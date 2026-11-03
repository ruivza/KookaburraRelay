import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('scheduled jobs never overlap, count failures and finish before close returns', async () => {
  const scheduler = new Scheduler();
  const errors = [];
  let runs = 0,
    release;
  scheduler
    .every('slow', 10, () => {
      runs++;
      return new Promise(resolve => (release = resolve));
    })
    .every(
      'broken',
      10,
      () => {
        throw Error('boom');
      },
      { onError: error => errors.push(error.message) },
    );
  scheduler.start(5);
  await sleep(100);
  assert.equal(runs, 1);
  assert.ok(errors.length >= 2 && errors.every(message => message === 'boom'));
  const status = Object.fromEntries(scheduler.status().map(job => [job.name, job]));
  assert.equal(status.slow.running, true);
  assert.equal(status.broken.failures, errors.length);
  let closed = false;
  const closing = scheduler.close().then(() => (closed = true));
  await sleep(30);
  assert.equal(closed, false);
  release();
  await closing;
  const failures = errors.length;
  await sleep(50);
  assert.equal(errors.length, failures);
  assert.equal(runs, 1);
});
