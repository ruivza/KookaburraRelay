import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rate-limit.js';

test('fixed windows count up to the maximum, report the wait and restart after the window', () => {
  let now = 1000;
  const limiter = new RateLimiter({ capacity: 10, evict: false, now: () => now });
  assert.equal(limiter.take('a', 2, 60000), null);
  assert.equal(limiter.take('a', 2, 60000), null);
  assert.deepEqual(limiter.take('a', 2, 60000), { retryAfter: 60000 });
  now += 59999;
  assert.deepEqual(limiter.take('a', 2, 60000), { retryAfter: 1 });
  assert.equal(limiter.count('a'), 2);
  now += 1;
  assert.equal(limiter.count('a'), 0);
  assert.equal(limiter.take('a', 2, 60000), null);
  assert.equal(limiter.count('a'), 1);
});

test('a full refusing limiter keeps live windows and admits new keys only once windows expire', () => {
  let now = 0;
  const limiter = new RateLimiter({ capacity: 3, evict: false, now: () => now });
  for (const key of ['a', 'b', 'c']) limiter.take(key, 1, 1000);
  assert.deepEqual(limiter.take('d', 1, 1000), { full: true });
  // Existing keys are still counted while full.
  assert.deepEqual(limiter.take('a', 1, 1000), { retryAfter: 1000 });
  now = 1000;
  assert.equal(limiter.take('d', 1, 1000), null);
  assert.equal(limiter.windows.size, 3);
});

test('a full evicting limiter drops the least recently used key, never one just counted', () => {
  const limiter = new RateLimiter({ capacity: 3, evict: true, now: () => 0 });
  for (const key of ['a', 'b', 'c']) limiter.take(key, 5, 1000);
  limiter.take('a', 5, 1000);
  assert.equal(limiter.take('d', 5, 1000), null);
  assert.deepEqual([...limiter.windows.keys()], ['c', 'a', 'd']);
  assert.equal(limiter.count('b'), 0);
  assert.equal(limiter.count('a'), 2);
});

test('pruning removes only expired windows', () => {
  let now = 0;
  const limiter = new RateLimiter({ capacity: 10, evict: false, now: () => now });
  limiter.take('short', 1, 100);
  limiter.take('long', 1, 10000);
  now = 100;
  limiter.prune();
  assert.deepEqual([...limiter.windows.keys()], ['long']);
});
