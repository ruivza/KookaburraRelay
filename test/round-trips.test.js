import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createGateway } from './helpers.mjs';

// Every statement any pool client sends, BEGIN and COMMIT included.
async function roundTrips(work) {
  const query = pg.Client.prototype.query;
  let count = 0;
  pg.Client.prototype.query = function (...args) {
    count++;
    return query.apply(this, args);
  };
  try {
    return { result: await work(), count: () => count };
  } finally {
    pg.Client.prototype.query = query;
  }
}

test('a warm send costs at most 12 database round trips and a delivery at most 6', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-round-trips-'));
  const sent = [];
  const app = await createGateway({
    dataDir,
    adminToken: 'round-trip-operator'.repeat(3),
    autoStart: false,
    providerFactory: () => ({
      async send(device, token, payload) {
        sent.push(payload);
        return { status: 200 };
      },
      close() {},
    }),
  });
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (path, body, token = '') => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  await app.applications.update('perch-mail', {
    name: 'Mail',
    enabled: true,
    apns: { privateKey: 'key', keyId: 'ABCDEFGHIJ', teamId: '0123456789', topic: 'com.example.mail' },
  });
  const enroll = async n => {
    const input = {
      deviceId: 'phone-' + n,
      serverId: 'server',
      deviceToken: n.toString(16).padStart(64, 'a'),
      environment: 'sandbox',
      nonce: 'n'.repeat(40),
    };
    const registration = await call('/v1/registrations', input);
    const proof = sent.find(p => p.perchRegistration?.id === registration.body.registrationId).perchRegistration;
    return (await call('/v1/registrations/' + proof.id + '/confirm', proof)).body;
  };
  const send = (grant, n) =>
    call(
      '/v1/jobs',
      {
        appId: 'perch-mail',
        deviceId: 'phone-' + n,
        serverId: 'server',
        kind: 'sync',
        requestId: 'round-trip-' + String(n).padStart(8, '0'),
      },
      grant.credential,
    );
  // The first send loads the configuration cache; the measured one runs against a warm cache.
  assert.equal((await send(await enroll(1), 1)).status, 202);
  const grant = await enroll(2);
  const request = await roundTrips(async () => {
    const response = await send(grant, 2);
    // Let the sampled request audit row land inside the measurement.
    await new Promise(resolve => setTimeout(resolve, 200));
    return response;
  });
  assert.equal(request.result.status, 202);
  t.diagnostic('send round trips: ' + request.count());
  assert.ok(request.count() <= 12, 'send took ' + request.count());
  // Send windows live apart from the per-address ones, which a source rotating addresses could evict.
  assert.equal(app.rateLimits.credentials.count('send-device:' + grant.registrationId), 1);
  assert.equal(app.rateLimits.general.count('send-device:' + grant.registrationId), 0);

  const delivery = await roundTrips(() => app.queue.execute(request.result.body.id));
  assert.equal(delivery.result.state, 'accepted');
  t.diagnostic('delivery round trips: ' + delivery.count());
  assert.ok(delivery.count() <= 6, 'delivery took ' + delivery.count());
});
