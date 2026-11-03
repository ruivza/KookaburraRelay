// Fixed-window counters held in memory and bounded to `capacity` keys. Counts reset when the process restarts;
// daily quotas that must survive a restart use AbuseProtection.quota() in PostgreSQL instead.
// When every slot holds a live window, `evict` drops the least recently used key (that key's window restarts);
// without it new keys are refused, so a flood of fresh keys cannot reset the limits already being counted.
export class RateLimiter {
  constructor({ capacity, evict, now = Date.now }) {
    this.capacity = capacity;
    this.evict = evict;
    this.now = now;
    this.windows = new Map();
    this.swept = 0;
  }
  // Counts one event. Returns null when allowed, { retryAfter } in milliseconds when the key is over its limit,
  // or { full: true } when a new key cannot be tracked.
  take(key, maximum, window) {
    const time = this.now();
    let entry = this.windows.get(key);
    if (entry) {
      // Re-inserting keeps the map in least-recently-used order.
      this.windows.delete(key);
      if (entry.until <= time) entry = null;
    }
    if (!entry) {
      if (this.windows.size >= this.capacity && !this.makeRoom(time)) return { full: true };
      entry = { count: 0, until: time + window };
    }
    this.windows.set(key, entry);
    if (entry.count >= maximum) return { retryAfter: entry.until - time };
    entry.count++;
    return null;
  }
  count(key) {
    const entry = this.windows.get(key);
    return entry && entry.until > this.now() ? entry.count : 0;
  }
  prune(time = this.now()) {
    this.swept = time;
    for (const [key, entry] of this.windows) if (entry.until <= time) this.windows.delete(key);
  }
  makeRoom(time) {
    const [oldest, entry] = this.windows.entries().next().value;
    if (entry.until <= time || this.evict) {
      this.windows.delete(oldest);
      return true;
    }
    // A full scan at most once a second, so a flood of new keys cannot turn every request into one.
    if (time - this.swept >= 1000) this.prune(time);
    return this.windows.size < this.capacity;
  }
}
