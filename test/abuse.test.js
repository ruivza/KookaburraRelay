import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from './helpers.mjs';
import { AbuseProtection } from '../src/abuse.js';

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-abuse-'));
  let now = Math.floor(Date.now() / 86400000) * 86400000 + 3600000, app, base;
  const sent = []; let sender = async () => ({ status: 200 });
  const options = { dataDir, adminToken: 'test-admin-'.repeat(5), now: () => now, autoStart: false,
    trustedProxies: '127.0.0.1', providerFactory: () => ({
      async send(device, token, payload) { sent.push(payload); return sender(payload); }, close() {},
    }) };
  async function start() {
    app = await createGateway(options);
    await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + app.server.address().port;
  }
  await start();
  await app.applications.update('perch-mail', { name: 'Mail', enabled: true,
    apns: { privateKey: 'fixture', keyId: 'ABCDEFGHIJ', teamId: '0123456789', topic: 'com.example.mail', environment: 'both' } });
  return {
    get app() { return app; }, sent, sender(fn) { sender = fn; }, advance(ms) { now += ms; },
    async settings(patch) { return app.abuse.save({ ...app.abuse.settings, ...patch }); },
    async restart() { await app.close(); await start(); },
    async call(path, body, token = '', ip = '203.0.113.1', method = body ? 'POST' : 'GET') {
      const r = await fetch(base + path, { method, headers: { Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json(), retryAfter: r.headers.get('retry-after') };
    },
    input(n = 1) { return { deviceId: 'phone-' + n, serverId: 'server', deviceToken: n.toString(16).padStart(64, 'a'), environment: 'sandbox', nonce: 'n'.repeat(40) }; },
    async enroll(n = 1, kinds) {
      const r = await this.call('/v1/registrations', { ...this.input(n), ...(kinds ? { kinds } : {}) }); assert.equal(r.status, 202);
      const proof = sent.find(p => p.perchRegistration?.id === r.body.registrationId).perchRegistration;
      const grant = await this.call('/v1/registrations/' + proof.id + '/confirm', proof);
      assert.equal(grant.status, 200); return { ...grant.body, deviceId: proof.deviceId };
    },
    async close() { await app.close(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}
const scope = (g, requestId = 'request-0000000001') => ({ appId: g.appId, deviceId: g.deviceId, serverId: 'server', kind: 'sync', requestId });

test('registration capacity is atomic across sources, before provider calls; expired slots recover', async () => {
  const f = await fixture();
  try {
    await f.settings({ pendingGlobal: 2 });
    const results = await Promise.all(Array.from({ length: 12 }, (_, n) => f.call('/v1/registrations', f.input(n + 1), '', '203.0.113.' + (n + 1))));
    assert.equal(results.filter(r => r.status === 202).length, 2);
    assert.equal(f.sent.length, 2);
    assert.equal((await f.app.db.prepare('SELECT count(*) n FROM registrations').get()).n, 2);
    assert.ok(results.filter(r => r.status !== 202).every(r => r.status === 503 && +r.retryAfter > 0));
    f.advance(300001); await f.app.abuse.cleanup();
    assert.equal((await f.call('/v1/registrations', f.input(50))).status, 202);
  } finally { await f.close(); }
});

test('failed challenge releases its slot, deletes pending data, and still consumes durable daily allowance', async () => {
  const f = await fixture();
  try {
    await f.settings({ challengeGlobalDay: 1 });
    f.sender(async () => { throw Error('simulated provider timeout'); });
    assert.equal((await f.call('/v1/registrations', f.input())).status, 500);
    assert.equal(f.app.abuse.challenges, 0);
    assert.equal((await f.app.db.prepare('SELECT count(*) n FROM registrations').get()).n, 0);
    await f.restart();
    const r = await f.call('/v1/registrations', f.input(2), '', '203.0.113.9');
    assert.equal(r.status, 429); assert.equal(r.body.reason, 'challenge_global_day');
    assert.equal(f.sent.length, 1);
  } finally { await f.close(); }
});

test('slow challenge holds its slot; busy rejection allocates no registration and successful confirmation survives pause', async () => {
  const f = await fixture(); let finish;
  try {
    await f.settings({ challengeConcurrency: 1 });
    let started; const ready = new Promise(r => { started = r; });
    f.sender(() => new Promise(r => { finish = r; started(); }));
    const first = f.call('/v1/registrations', f.input()); await ready;
    const busy = await f.call('/v1/registrations', f.input(2));
    assert.equal(busy.status, 503); assert.equal(busy.body.reason, 'challenge_concurrency');
    assert.equal(f.sent.length, 1);
    await f.settings({ registrationEnabled: false }); finish({ status: 200 });
    assert.equal((await first).status, 202);
    const proof = f.sent[0].perchRegistration;
    const grant = await f.call('/v1/registrations/' + proof.id + '/confirm', proof);
    assert.equal(grant.status, 200);
    assert.equal((await f.call('/v1/registrations', f.input(3))).body.reason, 'registration_paused');
    assert.equal((await f.call('/v1/validate', scope({ ...grant.body, deviceId: proof.deviceId }), grant.body.credential)).status, 200);
  } finally { finish?.({ status: 200 }); await f.close(); }
});

test('concurrent duplicate jobs charge once; denied quotas roll back; device budget survives re-enrollment', async () => {
  const f = await fixture();
  try {
    await f.settings({ taskDeviceDay: 1 });
    const g = await f.enroll();
    const results = await Promise.all(Array.from({ length: 6 }, () => f.call('/v1/jobs', scope(g), g.credential)));
    assert.ok(results.every(r => r.status === 202));
    assert.equal(new Set(results.map(r => r.body.id)).size, 1);
    assert.equal((await f.app.db.prepare("SELECT count FROM abuse_quotas WHERE key='task:global'").get()).count, 1);
    await f.app.queue.flush(); f.advance(61000);
    const blocked = await f.call('/v1/jobs', scope(g, 'request-0000000002'), g.credential);
    assert.equal(blocked.status, 429); assert.equal(blocked.body.reason, 'task_device_day');
    assert.equal((await f.app.db.prepare("SELECT count FROM abuse_quotas WHERE key='task:global'").get()).count, 1);
    const replacement = await f.enroll();
    assert.equal((await f.call('/v1/jobs', scope(replacement), replacement.credential)).body.reason, 'task_device_day');
    await f.restart();
    assert.equal((await f.call('/v1/jobs', scope(replacement), replacement.credential)).status, 429);
    f.advance(86400000);
    assert.equal((await f.call('/v1/jobs', scope(replacement), replacement.credential)).status, 202);
  } finally { await f.close(); }
});

test('provider attempts have a separate quota; retry cannot call the provider after exhaustion', async () => {
  const f = await fixture();
  try {
    const g = await f.enroll(); await f.settings({ attemptGlobalDay: 1 });
    f.sender(async () => ({ status: 503 }));
    const r = await f.call('/v1/jobs', scope(g), g.credential);
    await f.app.queue.flush(); f.advance(70000); await f.app.queue.flush();
    assert.equal(f.sent.length, 2); // One challenge and one delivery.
    const job = await f.app.queue.get(r.body.id);
    assert.equal(job.status, 429); assert.equal(job.reason, 'GatewayQuota');
    assert.ok(job.next_at > Date.now() || job.next_at > job.updated);
  } finally { await f.close(); }
});

test('expired registration cleanup cancels outstanding jobs and removes their notification content', async () => {
  const f = await fixture();
  try {
    await f.app.applications.update('perch-mail', { name: 'Mail', enabled: true, notifications: { kinds: ['sync', 'alert'] } });
    const grant = await f.enroll(1, ['sync', 'alert']);
    const result = await f.call('/v1/jobs', { ...scope(grant), kind: 'alert', alert: { title: 'Private title', body: 'Private body' } }, grant.credential);
    assert.equal(result.status, 202);
    const job = await f.app.queue.get(result.body.id);
    assert.ok(job.notification); assert.ok(!job.notification.includes('Private body'));
    f.advance(31 * 86400000);
    await f.app.abuse.cleanup();
    const cancelled = await f.app.queue.get(job.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.reason, 'RegistrationExpired');
    assert.equal(cancelled.notification, null);
    assert.equal(await f.app.db.prepare('SELECT id FROM registrations WHERE id=?').get(job.registration_id), undefined);
    await f.app.queue.flush();
    assert.equal(f.sent.length, 1); // The registration challenge is the only provider call.
  } finally { await f.close(); }
});

for (const change of ['revocation', 'access policy']) test('task admission rechecks a stale registration after ' + change, async () => {
  const f = await fixture();
  try {
    const grant = await f.enroll();
    // Model a request that completed credential checks before another request revoked its grant.
    const stale = await f.app.db.prepare('SELECT * FROM registrations WHERE id=?').get(grant.registrationId);
    if (change === 'revocation') {
      assert.equal((await f.call('/v1/registrations/' + stale.id, undefined, grant.revokeToken, undefined, 'DELETE')).status, 200);
    } else {
      const policy = await f.app.access.describe(stale.app_id);
      await f.app.access.savePolicy(stale.app_id, { settings: policy.settings });
    }
    await assert.rejects(f.app.queue.enqueue(stale, { requestId: 'stale-request-0001' }), error => error.status === 410);
    assert.equal((await f.app.db.prepare('SELECT count(*) n FROM delivery_jobs').get()).n, 0);
    assert.equal((await f.app.db.prepare("SELECT count(*) n FROM abuse_quotas WHERE key LIKE 'task:%'").get()).n, 0);
    assert.equal(f.sent.length, 1);
  } finally { await f.close(); }
});

test('memory admission and logging remain bounded under changing keys and slow writes', async () => {
  let now = 0;
  const abuse = new AbuseProtection({ now: () => now });
  for (let n = 0; n < 11000; n++) abuse.memory('source:' + n, 1);
  assert.equal(abuse.buckets.size, 10000); assert.equal(abuse.memory('extra', 1), false);
  now = 60001; assert.equal(abuse.memory('extra', 1), true);
  const releases = []; let writes = 0;
  const work = Array.from({ length: 30 }, () => abuse.log(() => { writes++; return new Promise(r => releases.push(r)); }));
  assert.equal(writes, 8); assert.equal(abuse.droppedLogs, 22);
  releases.forEach(r => r()); await Promise.all(work); assert.equal(abuse.logWrites, 0);
  const slots = Array.from({ length: 64 }, (_, i) => abuse.admit('ip-' + i));
  assert.throws(() => abuse.admit('another'), e => e.reason === 'request_concurrency');
  slots.forEach(release => { release(); release(); }); assert.equal(abuse.requests, 0);
});

test('resource settings require admin auth, validate bounds and persist; malformed input never invokes provider', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('/admin/abuse')).status, 401);
    const login = await f.call('/auth/login', { token: 'test-admin-'.repeat(5) });
    const token = login.body.session;
    assert.equal((await f.call('/admin/abuse', { challengeConcurrency: 0 }, token, undefined, 'PUT')).status, 400);
    assert.equal((await f.call('/admin/abuse', { ...f.app.abuse.settings, challengeConcurrency: 2 }, token, undefined, 'PUT')).status, 200);
    assert.equal((await f.call('/v1/registrations', { ...f.input(), deviceToken: 'invalid' })).status, 400);
    assert.equal(f.sent.length, 0);
    await f.restart(); assert.equal(f.app.abuse.settings.challengeConcurrency, 2);
  } finally { await f.close(); }
});
