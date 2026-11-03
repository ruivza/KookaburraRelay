import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryQueue } from '../src/delivery.js';
import { createGateway } from './helpers.mjs';
const deferred = () => {
  let resolve;
  const promise = new Promise(r => (resolve = r));
  return { promise, resolve };
};
function fixture(count = 6) {
  const jobs = Array.from({ length: count }, (_, i) => ({ id: String(i), state: 'queued' }));
  const queue = new DeliveryQueue({
    autoStart: false,
    concurrency: 2,
    db: {
      detached: fn => fn(),
      prepare() {
        return {
          all: async (...args) =>
            jobs.filter(j => j.state === 'queued' && !args.slice(1, -1).includes(j.id)).slice(0, args.at(-1)),
        };
      },
    },
  });
  const first = deferred(),
    started = [],
    fifth = deferred();
  queue.perform = async id => {
    jobs[Number(id)].state = 'sending';
    started.push(id);
    if (id === '0') await first.promise;
    jobs[Number(id)].state = 'accepted';
    if (id === '5') fifth.resolve();
  };
  return { queue, jobs, first, started, fifth };
}
test('free slots refill while another provider request is still blocked', async () => {
  const f = fixture();
  const running = f.queue.flush();
  try {
    await Promise.race([
      f.fifth.promise,
      new Promise((_, reject) => setTimeout(() => reject(Error('Queue waited for the slow first request')), 500)),
    ]);
    assert.equal(f.jobs[0].state, 'sending');
    assert.deepEqual(f.started, ['0', '1', '2', '3', '4', '5']);
    assert.ok(f.queue.slots.size <= 2);
  } finally {
    f.first.resolve();
    await running;
    await f.queue.close();
  }
});
test('overlapping drains never duplicate a job or exceed available slots', async () => {
  const f = fixture();
  const one = f.queue.flush(),
    two = f.queue.flush();
  f.first.resolve();
  await Promise.all([one, two]);
  assert.equal(new Set(f.started).size, 6);
  assert.equal(f.started.length, 6);
  await f.queue.close();
});
test('close stops refill and waits for the admitted provider request', async () => {
  const f = fixture();
  const running = f.queue.flush();
  while (!f.started.length) await new Promise(r => setImmediate(r));
  const closing = f.queue.close();
  const count = f.started.length;
  f.first.resolve();
  await Promise.all([running, closing]);
  assert.equal(f.started.length, count);
  assert.equal(f.queue.slots.size, 0);
});
test('executor failure ends the drain without spinning or leaking slots', async () => {
  const f = fixture(1);
  f.queue.perform = async () => {
    throw Error('database unavailable');
  };
  await assert.rejects(f.queue.flush(), /database unavailable/);
  assert.equal(f.queue.slots.size, 0);
  await f.queue.close();
});

test('starting the worker drains immediately without waiting for the one-second timer', async () => {
  const f = fixture(1);
  f.queue.start();
  try {
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(f.started, ['0']);
  } finally {
    f.first.resolve();
    await f.queue.close();
  }
});
test('background database failure waits for the timer instead of hot-looping', async () => {
  const f = fixture(1);
  let attempts = 0;
  f.queue.perform = async () => {
    attempts++;
    throw Error('database unavailable');
  };
  f.queue.start();
  try {
    await new Promise(r => setTimeout(r, 50));
    assert.equal(attempts, 1);
    assert.equal(f.queue.failures, 1);
  } finally {
    await f.queue.close();
  }
});
test('a send rejected for its device token cancels the registration and its other waiting work at once', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-invalid-token-'));
  const sent = [];
  let result = { status: 200 };
  const app = await createGateway({
    dataDir,
    adminToken: 'invalid-token-operator'.repeat(3),
    autoStart: false,
    providerFactory: () => ({
      async send(device, token, payload) {
        sent.push(payload);
        return result;
      },
      close() {},
    }),
  });
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const call = async (path, body) =>
    (
      await fetch('http://127.0.0.1:' + app.server.address().port + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json();
  await app.applications.update('perch-mail', {
    name: 'Mail',
    enabled: true,
    apns: { privateKey: 'key', keyId: 'ABCDEFGHIJ', teamId: '0123456789', topic: 'com.example.mail' },
  });
  const registration = await call('/v1/registrations', {
    deviceId: 'phone',
    serverId: 'server',
    deviceToken: 'a'.repeat(64),
    environment: 'sandbox',
    nonce: 'n'.repeat(40),
  });
  const proof = sent.find(p => p.perchRegistration?.id === registration.registrationId).perchRegistration;
  const grant = await call('/v1/registrations/' + proof.id + '/confirm', proof);
  const entry = await app.db.prepare('SELECT * FROM registrations WHERE id=?').get(grant.registrationId);
  const first = await app.queue.enqueue(entry, { requestId: 'invalid-token-0001' });
  // Admission allows one active job per device, so the second waiting job is written directly.
  await app.db
    .prepare(
      `INSERT INTO delivery_jobs(id,registration_id,app_id,channel,device_id,mode,state,created,updated,next_at,expires,kind)
      SELECT 'second',registration_id,app_id,channel,device_id,mode,'queued',created+1,updated,next_at,expires,kind
      FROM delivery_jobs WHERE id=?`,
    )
    .run(first.id);
  result = { status: 410, reason: 'Unregistered' };
  const count = sent.length;
  assert.equal((await app.queue.execute(first.id)).state, 'failed');
  // Cancelled by the same send, not orphaned until a later cycle finds its registration gone.
  const second = await app.queue.get('second');
  assert.equal(second.state, 'cancelled');
  assert.equal(second.reason, 'DeviceTokenInvalid');
  assert.equal(await app.db.prepare('SELECT 1 FROM registrations WHERE id=?').get(entry.id), undefined);
  await app.queue.flush();
  assert.equal(sent.length, count + 1);
});
