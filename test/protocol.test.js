import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { createGateway } from './helpers.mjs';
import { APNsChannel } from '../src/channels.js';
import { APNsProvider } from '../src/apns.js';
import { FCMChannel } from '../src/fcm.js';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const account = {
  project_id: 'relay-test',
  client_email: 'worker@relay-test.iam.gserviceaccount.com',
  private_key: rsa,
};

test('a new installation has no applications; protocol 2 enrolls with relay names and needs its appId', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-protocol-'));
  const sent = [];
  const app = await createGateway({
    dataDir,
    defaultApplication: false,
    adminToken: 'protocol-test-operator'.repeat(3),
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
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(await app.applications.list(), []);
  assert.equal((await call('/v1/status')).status, 404);

  await app.applications.create({ id: 'notes', name: 'Notes' });
  await app.applications.update('notes', {
    name: 'Notes',
    enabled: true,
    apns: { privateKey: 'key', keyId: 'ABCDEFGHIJ', teamId: '0123456789', topic: 'com.example.notes' },
  });
  assert.deepEqual((await call('/v1/status?appId=notes')).body.protocols, [1, 2]);
  const input = n => ({
    deviceId: 'phone-' + n,
    serverId: 'server',
    deviceToken: n.toString(16).padStart(64, 'a'),
    environment: 'sandbox',
    nonce: 'n'.repeat(40),
  });
  assert.equal((await call('/v1/registrations', { ...input(1), protocol: 2 })).status, 400);
  assert.equal((await call('/v1/registrations', { ...input(1), appId: 'notes', protocol: 3 })).status, 400);

  const enroll = async (n, extra) => {
    const registration = await call('/v1/registrations', { ...input(n), appId: 'notes', ...extra });
    assert.equal(registration.status, 202);
    const payload = sent.at(-1);
    const proof = payload.relayRegistration ?? payload.perchRegistration;
    const grant = await call('/v1/registrations/' + proof.id + '/confirm', proof);
    assert.equal(grant.status, 200);
    return { payload, grant: grant.body, deviceId: 'phone-' + n };
  };
  const sync = async ({ grant, deviceId }, n) => {
    const job = await call(
      '/v1/jobs',
      { appId: 'notes', deviceId, serverId: 'server', kind: 'sync', requestId: 'protocol-request-' + n },
      grant.credential,
    );
    assert.equal(job.status, 202);
    assert.equal((await app.queue.execute(job.body.id)).state, 'accepted');
    return sent.at(-1);
  };

  const relay = await enroll(1, { protocol: 2 });
  assert.equal(relay.payload.perchRegistration, undefined);
  assert.equal(relay.payload.relayRegistration.appId, 'notes');
  assert.deepEqual((await sync(relay, 1)).relay, { version: 2, kind: 'sync', deviceId: 'phone-1', appId: 'notes' });

  const perch = await enroll(2);
  assert.equal(perch.payload.relayRegistration, undefined);
  assert.ok(perch.payload.perchRegistration);
  const legacy = await sync(perch, 2);
  assert.deepEqual(legacy.perch, { version: 1, deviceId: 'phone-2', appId: 'notes' });
  assert.equal(legacy.relay, undefined);
});

test('APNs collapse IDs and FCM data keys follow the registration protocol', async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const requests = [];
  const provider = new APNsProvider(
    { key: privateKey.export({ format: 'pem', type: 'pkcs8' }), keyId: 'ABCDEFGHIJ', teamId: '0123456789', topic: 't' },
    {
      connection: () => {
        const session = new EventEmitter();
        session.destroy = () => {};
        session.request = headers => {
          const request = new EventEmitter();
          request.setEncoding = () => {};
          request.end = () => {
            requests.push(headers);
            queueMicrotask(() => {
              request.emit('response', { ':status': 200 });
              request.emit('end');
              request.emit('close');
            });
          };
          return request;
        };
        return session;
      },
    },
  );
  const apns = new APNsChannel({}, () => provider);
  const token = 'a'.repeat(64);
  for (const protocol of [1, 2]) {
    const target = { device_id: 'phone', app_id: 'notes', environment: 'sandbox', protocol };
    await apns.send(target, token, { kind: 'challenge', proof: { id: 'proof-' + protocol } });
    await apns.send(target, token, { kind: 'sync' });
  }
  assert.deepEqual(
    requests.map(headers => headers['apns-collapse-id']),
    ['perch-enroll-proof-1', 'perch-mail-sync', 'relay-enroll-proof-2', 'relay-sync'],
  );
  apns.close();

  const bodies = [];
  const fcm = new FCMChannel(
    { projectId: account.project_id, clientEmail: account.client_email, privateKey: account.private_key },
    {
      fetcher: async (url, options) => {
        if (url === 'https://oauth2.googleapis.com/token')
          return Response.json({ access_token: 'token', expires_in: 3600 });
        bodies.push(JSON.parse(options.body).message);
        return Response.json({ name: 'message' });
      },
    },
  );
  for (const protocol of [1, 2]) {
    const target = { device_id: 'phone', app_id: 'notes', protocol };
    await fcm.send(target, 'AbC_Token', { kind: 'challenge', proof: { id: 'proof' } });
    await fcm.send(target, 'AbC_Token', { kind: 'sync' });
  }
  assert.deepEqual(
    bodies.map(message => [Object.keys(message.data)[0], message.android.collapse_key]),
    [
      ['perchRegistration', 'perch-enroll'],
      ['perch', 'perch-sync'],
      ['relayRegistration', 'relay-enroll'],
      ['relay', 'relay-sync'],
    ],
  );
  assert.deepEqual(JSON.parse(bodies[3].data.relay), { version: 2, kind: 'sync', deviceId: 'phone', appId: 'notes' });
  fcm.close();
});
