import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from './helpers.mjs';
import { ConfigCache } from '../src/config-cache.js';

const apns = topic => ({ keyId: 'ABCDEFGHIJ', teamId: '0123456789', topic, environment: 'both', privateKey: 'key' });
async function gateway(t) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cache-'));
  const app = await createGateway({
    dataDir: dir,
    adminToken: 'cache-test-operator'.repeat(3),
    autoStart: false,
    providerFactory: config => ({ topic: config.topic, send() {}, close() {} }),
    fcmFactory: () => ({ send() {}, close() {} }),
  });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return app;
}

test('cache entries change only when the writing transaction commits, and a rollback keeps them', async t => {
  const app = await gateway(t);
  const cache = new ConfigCache(app.db);
  const outside = fn => app.db.context.exit(fn);
  const name = async () => (await cache.application('perch-mail')).name;
  const original = await name();
  await app.db.transaction(async () => {
    await app.db.prepare('UPDATE applications SET name=? WHERE id=?').run('Renamed', 'perch-mail');
    cache.invalidate('app', 'perch-mail');
    // The writer reads its own change; everyone else keeps the committed value until the commit.
    assert.equal(await name(), 'Renamed');
    assert.equal(await outside(name), original);
  });
  assert.equal(await name(), 'Renamed');
  await assert.rejects(
    app.db.transaction(async () => {
      await app.db.prepare('UPDATE applications SET name=? WHERE id=?').run('Discarded', 'perch-mail');
      cache.invalidate('app', 'perch-mail');
      throw Error('abort');
    }),
    /abort/,
  );
  assert.equal(await name(), 'Renamed');
  assert.throws(() => {
    cache.entries.get('app:perch-mail').name = 'mutated';
  }, TypeError);
});

test('a value loaded across an invalidation is returned but not stored; unknown applications are not cached', async t => {
  const app = await gateway(t);
  const cache = new ConfigCache(app.db);
  let release,
    loads = 0;
  const gate = new Promise(resolve => (release = resolve));
  const pending = cache.get('app:slow', async () => {
    loads++;
    await gate;
    return 'stale';
  });
  cache.invalidate('app', 'slow');
  release();
  assert.equal(await pending, 'stale');
  assert.equal(
    await cache.get('app:slow', async () => {
      loads++;
      return 'fresh';
    }),
    'fresh',
  );
  assert.equal(loads, 2);
  assert.equal(await cache.application('missing-app'), null);
  assert.equal(cache.entries.has('app:missing-app'), false);
});

test('every configuration change is visible to the request path immediately', async t => {
  const app = await gateway(t);
  const { applications, access, abuse } = app;
  await applications.update('perch-mail', { name: 'Mail', enabled: true, apns: apns('com.example.one') });
  const before = await applications.resolve('perch-mail', 'apns', 'production');
  assert.equal(before.adapter.provider.topic, 'com.example.one');
  assert.deepEqual(await applications.capabilities('perch-mail', 'apns'), ['sync']);

  await applications.configureChannel('perch-mail', 'apns', apns('com.example.two'));
  const after = await applications.resolve('perch-mail', 'apns', 'production');
  assert.notEqual(after.revision, before.revision);
  assert.equal(after.adapter.provider.topic, 'com.example.two');

  await applications.update('perch-mail', { name: 'Mail', enabled: true, notifications: { kinds: ['sync', 'alert'] } });
  assert.deepEqual(await applications.capabilities('perch-mail', 'apns'), ['sync', 'alert']);

  await applications.update('perch-mail', { name: 'Mail', enabled: false });
  await assert.rejects(applications.resolve('perch-mail', 'apns', 'production'), e => e.status === 503);
  assert.ok(!(await applications.current({ app_id: 'perch-mail', app_revision: after.revision })));

  assert.equal((await abuse.effective('perch-mail')).taskAppDay, abuse.settings.taskAppDay);
  await abuse.saveApp('perch-mail', { taskAppDay: 7 });
  assert.equal((await abuse.effective('perch-mail')).taskAppDay, 7);

  const policy = await access.policy('perch-mail');
  await access.savePolicy('perch-mail', { settings: { ...policy.settings, requireTrustedServers: true } });
  const changed = await access.policy('perch-mail');
  assert.equal(changed.settings.requireTrustedServers, true);
  assert.notEqual(changed.revision, policy.revision);

  await access.createServer({ id: 'server', name: 'Business', apps: ['perch-mail'] });
  await access.updateServer('server', { action: 'approve' });
  const entry = { server_id: 'server', trusted_server: 1 };
  assert.equal(await access.active(entry), true);
  await access.updateServer('server', { action: 'block' });
  assert.equal(await access.active(entry), false);

  // Deleting an application drops its cascaded settings; a new one with the same ID starts from defaults.
  await applications.create({ id: 'second', name: 'Second' });
  await abuse.saveApp('second', { taskAppDay: 3 });
  assert.equal((await abuse.effective('second')).taskAppDay, 3);
  await applications.remove('second');
  await applications.create({ id: 'second', name: 'Second' });
  assert.equal((await abuse.effective('second')).taskAppDay, abuse.settings.taskAppDay);
});
