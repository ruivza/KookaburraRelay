import { randomUUID } from 'node:crypto';
import { deliveryContent, allows } from './notification.js';
import { DAY, backoff, fail, sha256Hex } from './util.js';
const terminal = new Set(['accepted', 'failed', 'unknown', 'cancelled']);
const pending = ['queued', 'retrying', 'sending'];
// Cancels the jobs matching `where` (trusted SQL with ? placeholders) and drops their stored content.
// `states` limits it to jobs still in those states; null cancels regardless of state.
export function cancelJobs(db, now, reason, where, params, states = pending) {
  const scope = states ? ` AND state IN (${states.map(state => `'${state}'`).join(',')})` : '';
  return db
    .prepare(`UPDATE delivery_jobs SET state='cancelled',notification=NULL,reason=?,updated=? WHERE ${where}${scope}`)
    .run(reason, now, ...params);
}
const invalidToken = result =>
  result.status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'UNREGISTERED'].includes(result.reason);
// Only provider error codes from this allowlist may enter logs, never provider text.
const safeReasons = new Set([
  'BadDeviceToken',
  'DeviceTokenNotForTopic',
  'Unregistered',
  'UNREGISTERED',
  'SENDER_ID_MISMATCH',
  'INVALID_ARGUMENT',
  'QUOTA_EXCEEDED',
  'UNAVAILABLE',
  'INTERNAL',
  'THIRD_PARTY_AUTH_ERROR',
  'InvalidProviderToken',
  'ExpiredProviderToken',
  'TooManyRequests',
  'ServiceUnavailable',
  'Shutdown',
  'BadTopic',
  'TopicDisallowed',
  'AuthenticationError',
  'NetworkError',
]);
export class DeliveryQueue {
  constructor({
    db,
    applications,
    open,
    seal,
    now = Date.now,
    autoStart = true,
    concurrency = 32,
    legacyConcurrency = 4,
    abuse,
    access,
  }) {
    this.db = db;
    this.applications = applications;
    this.open = open;
    this.seal = seal;
    this.now = now;
    this.concurrency = concurrency;
    this.legacyConcurrency = legacyConcurrency;
    this.abuse = abuse;
    this.access = access;
    this.active = new Map();
    this.failures = 0;
    this.lastSuccessAt = null;
    this.lastErrorAt = null;
    // Async workers and legacy calls have separate slots, so neither can starve the other.
    this.slots = new Set();
    this.legacySlots = new Set();
    if (autoStart) this.start();
  }
  start() {
    if (!this.timer && !this.stopping) {
      this.timer = setInterval(() => this.wake(), 1000).unref();
      this.wake();
    }
  }
  wake() {
    this.wakeRequested = true;
    this.resumeWake?.();
    if (this.timer && !this.stopping && !this.wakeScheduled) {
      this.wakeScheduled = true;
      queueMicrotask(() => {
        this.wakeScheduled = false;
        // The drain outlives whatever request or transaction woke it.
        if (!this.stopping) void this.db.detached(() => this.poll());
      });
    }
  }
  async poll() {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      try {
        await this.flush();
        this.lastSuccessAt = this.now();
        this.lastErrorAt = null;
      } catch {
        this.wakeRequested = false;
        this.failures++;
        this.lastErrorAt = this.now();
        console.error('Delivery worker cycle failed');
      }
    })();
    try {
      await this.polling;
    } finally {
      this.polling = null;
      if (this.wakeRequested && !this.stopping) this.wake();
    }
  }
  async get(id) {
    return await this.db.prepare('SELECT * FROM delivery_jobs WHERE id=?').get(id);
  }
  public(job) {
    if (!job) fail(404, 'Task not found');
    const { dedupe, notification, notification_hash, notification_sealed, ...safe } = job;
    return safe;
  }
  /**
   * @param {any} entry
   * @param {{ mode?: string, requestId?: string, kind?: string, notification?: any, alert?: any }} [options]
   */
  async enqueue(entry, { mode = 'async', requestId, kind = 'sync', notification, alert } = {}) {
    const content = deliveryContent(kind, notification, alert, this.now());
    const encoded = content ? JSON.stringify(content) : '';
    const contentHash = encoded ? sha256Hex(encoded) : '';
    const job = await this.db.transaction(async () => {
      // Row locks, application first: configuration changes take this application's row FOR UPDATE, and
      // revocation and other sends to this device take the registration row.
      const application = await this.db
        .prepare('SELECT enabled,revision FROM applications WHERE id=? FOR SHARE')
        .get(entry.app_id);
      entry = await this.db
        .prepare('SELECT * FROM registrations WHERE id=? AND expires>? FOR UPDATE')
        .get(entry.id, this.now());
      if (!entry || !application?.enabled || application.revision !== entry.app_revision)
        fail(410, 'Registration expired or revoked');
      if (!allows(entry, kind) || !(await this.applications.capabilities(entry.app_id, entry.channel)).includes(kind))
        fail(403, 'Credential scope mismatch');
      if (this.stopping) fail(503, 'Gateway shutting down');
      if (mode === 'async' && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(requestId)))
        fail(400, 'A requestId of 16-100 letters, numbers, underscores or hyphens is required');
      const dedupe = requestId ? sha256Hex(entry.id + ':' + requestId) : null;
      // One read for the duplicate request, the queue cap and this device's active job. The cap check asks whether
      // a 10,000th pending job exists, so it stops reading at the cap instead of counting the whole queue.
      const check = await this.db
        .prepare(
          `SELECT previous.id previous,previous.kind previous_kind,previous.notification_hash previous_hash,
          EXISTS(SELECT 1 FROM delivery_jobs WHERE state IN ('queued','retrying','sending') OFFSET 9999) queue_full,
          EXISTS(SELECT 1 FROM delivery_jobs WHERE registration_id=? AND state IN ('queued','retrying','sending')) pending
          FROM (SELECT 1) one LEFT JOIN delivery_jobs previous ON previous.dedupe=?`,
        )
        .get(entry.id, dedupe);
      if (check.previous) {
        if (check.previous_kind !== kind || check.previous_hash !== contentHash)
          fail(409, 'Request ID already used for another kind');
        return await this.get(check.previous);
      }
      // Sends to different devices no longer serialize, so concurrent ones can pass this check together and
      // overshoot the cap by at most the requests in flight.
      if (check.queue_full) fail(503, 'Queue capacity reached');
      // One active sync hint per registration, also prevents legacy/async overlap.
      if (check.pending || (entry.last_sent && this.now() - entry.last_sent < 60000)) fail(429, 'Device rate limit');
      const id = randomUUID(),
        time = this.now();
      await this.abuse?.task(entry);
      return await this.db
        .prepare(
          `WITH job AS (INSERT INTO delivery_jobs(id,registration_id,app_id,channel,device_id,mode,dedupe,state,created,updated,next_at,expires,kind,notification,notification_hash,notification_sealed)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *),
          sent AS (UPDATE registrations SET last_sent=? WHERE id=?)
          SELECT * FROM job`,
        )
        .get(
          id,
          entry.id,
          entry.app_id,
          entry.channel,
          entry.device_id,
          mode,
          dedupe,
          'queued',
          time,
          time,
          time,
          Math.min(entry.expires, time + DAY, content?.encryptedNotification?.expires ?? Infinity),
          kind,
          encoded ? this.seal(encoded) : null,
          contentHash,
          1,
          time,
          entry.id,
        );
    });
    if (mode === 'async' && this.timer) this.wake();
    return job;
  }
  async cancelRegistration(id, reason = 'RegistrationRevoked') {
    await cancelJobs(this.db, this.now(), reason, 'registration_id=?', [id]);
  }
  async cancel(id) {
    const job = await this.get(id);
    if (!job) fail(404, 'Task not found');
    if (!['queued', 'retrying'].includes(job.state)) fail(409, 'Only waiting tasks can be cancelled');
    await cancelJobs(this.db, this.now(), 'OperatorCancelled', 'id=?', [id], ['queued', 'retrying']);
    return this.public(await this.get(id));
  }
  reserve(legacy = false) {
    const slots = legacy ? this.legacySlots : this.slots;
    if (this.stopping) fail(503, 'Gateway shutting down');
    if (slots.size >= (legacy ? this.legacyConcurrency : this.concurrency)) fail(503, 'Workers busy');
    let finish;
    const slot = {
      done: new Promise(resolve => {
        finish = resolve;
      }),
    };
    slot.release = () => {
      if (slots.delete(slot)) {
        finish();
        if (!legacy && this.timer && !this.flushing) this.wake();
      }
    };
    slots.add(slot);
    return slot;
  }
  async execute(id, reserved) {
    if (this.active.has(id)) return this.active.get(id);
    const slot = reserved || this.reserve();
    const work = this.perform(id);
    this.active.set(id, work);
    try {
      return await work;
    } finally {
      this.active.delete(id);
      slot.release();
    }
  }
  // Correctness rests on the state conditions of the claim and the final update, not on repeated reads: a job
  // cancelled while it is being sent keeps its cancellation, because the result is written only WHERE
  // state='sending'.
  async perform(id) {
    const found = await this.db
      .prepare(
        `SELECT job.*,row_to_json(entry) registration FROM delivery_jobs job
        LEFT JOIN registrations entry ON entry.id=job.registration_id AND entry.expires>? AND entry.delivery_hash IS NOT NULL
        WHERE job.id=?`,
      )
      .get(this.now(), id);
    if (!found) return found;
    const { registration: entry, ...job } = found;
    if (terminal.has(job.state) || job.state === 'sending') return job;
    if (
      !entry ||
      !(await this.applications.current(entry)) ||
      job.expires <= this.now() ||
      !allows(entry, job.kind) ||
      !(await this.applications.capabilities(entry.app_id, entry.channel)).includes(job.kind)
    ) {
      await cancelJobs(this.db, this.now(), 'RegistrationExpired', 'id=?', [id], null);
      return await this.get(id);
    }
    try {
      await this.abuse?.attempt(entry);
    } catch (error) {
      if (error.status !== 429) throw error;
      const next = this.now() + error.retryAfter * 1000;
      const retry = job.mode === 'async' && next < job.expires;
      await this.db
        .prepare(
          "UPDATE delivery_jobs SET state=?,status=429,reason='GatewayQuota',next_at=?,updated=?,notification=CASE WHEN ? THEN notification ELSE NULL END WHERE id=? AND state IN ('queued','retrying')",
        )
        .run(retry ? 'retrying' : 'failed', next, this.now(), retry, id);
      return this.get(id);
    }
    const claimed = await this.db
      .prepare(
        "UPDATE delivery_jobs SET state='sending',attempts=attempts+1,updated=? WHERE id=? AND state IN ('queued','retrying') RETURNING id",
      )
      .get(this.now(), id);
    if (!claimed) return this.get(id);
    const start = performance.now();
    let result;
    try {
      const route = await this.applications.resolve(entry.app_id, entry.channel, entry.environment);
      const content = job.notification
        ? JSON.parse(job.notification_sealed ? this.open(job.notification) : job.notification)
        : {};
      const { fallback } = await this.applications.notifications(entry.app_id);
      if (!(await this.applications.current(entry))) return this.get(id);
      if (!(await this.applications.capabilities(entry.app_id, entry.channel)).includes(job.kind)) {
        await cancelJobs(this.db, this.now(), 'CapabilityDisabled', 'id=?', [id], ['sending']);
        return this.get(id);
      }
      if (this.access && !(await this.access.active(entry))) {
        await this.cancelRegistration(entry.id);
        return this.get(id);
      }
      // The one read before sending: the configuration lookups above can yield to a cancellation.
      if ((await this.db.prepare('SELECT state FROM delivery_jobs WHERE id=?').get(id))?.state !== 'sending')
        return this.get(id);
      result = await route.adapter.send(entry, this.open(entry.token), { kind: job.kind, ...content, fallback });
    } catch {
      result = { status: 0, reason: 'NetworkError' };
    }
    // Every path that deletes a registration cancels its work, which the final update below respects.
    if (!(await this.applications.current(entry))) {
      await this.cancelRegistration(entry.id);
      return await this.get(id);
    }
    const status = Number.isInteger(result.status) ? result.status : 0;
    const attempts = job.attempts + 1;
    const retryable = status === 429 || status >= 500;
    let state = status === 200 ? 'accepted' : status === 0 ? 'unknown' : 'failed';
    let next = this.now();
    if (!invalidToken(result) && job.mode === 'async' && retryable && attempts < 6) {
      const header = result.retryAfter;
      const retryAfter = header
        ? /^\d+$/.test(String(header))
          ? Number(header) * 1000
          : Date.parse(header) - this.now()
        : 0;
      next +=
        Math.max(Math.min(3600000, Number.isFinite(retryAfter) ? retryAfter : 0), backoff(attempts)) +
        Math.floor(Math.random() * 5000);
      if (next < job.expires) state = 'retrying';
    }
    const reason =
      status === 200
        ? ''
        : safeReasons.has(result.reason)
          ? result.reason
          : status === 0
            ? 'NetworkError'
            : 'ProviderRejected';
    const recorded = await this.db
      .prepare(
        "UPDATE delivery_jobs SET state=?,status=?,reason=?,updated=?,next_at=?,duration=?,notification=CASE WHEN ?='retrying' THEN notification ELSE NULL END WHERE id=? AND state='sending' RETURNING *",
      )
      .get(state, status, reason, this.now(), next, Math.round(performance.now() - start), state, id);
    // A job cancelled during the send keeps its cancellation and its registration.
    if (!recorded) return await this.get(id);
    // The token is dead for all of this registration's work: revoke it like every other path, the registration row
    // before its jobs, so its other waiting jobs are cancelled now with this reason, not found orphaned later.
    if (invalidToken(result))
      await this.db.transaction(async () => {
        if (!(await this.db.prepare('SELECT 1 FROM registrations WHERE id=? FOR UPDATE').get(entry.id))) return;
        await this.cancelRegistration(entry.id, 'DeviceTokenInvalid');
        await this.db.prepare('DELETE FROM registrations WHERE id=?').run(entry.id);
      });
    return recorded;
  }
  async legacy(entry, kind = 'sync', notification, alert) {
    // Legacy callers own retries. Never background-retry a failed legacy call.
    // Reserve synchronously, before the first database await, so an admitted legacy task always has an executor.
    const slot = this.reserve(true);
    try {
      const job = await this.enqueue(entry, { mode: 'legacy', kind, notification, alert });
      return await this.execute(job.id, slot);
    } finally {
      slot.release();
    }
  }
  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this.drain();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }
  async drain() {
    const pending = new Set();
    let failure;
    try {
      while (!this.stopping) {
        if (failure) throw failure;
        this.wakeRequested = false;
        const capacity = this.concurrency - this.slots.size;
        if (capacity > 0) {
          // An executor may still be validating a queued row before claiming it.
          const active = [...this.active.keys()];
          const excluded = active.length ? ` AND id NOT IN (${active.map(() => '?').join(',')})` : '';
          const jobs = await this.db
            .prepare(
              "SELECT id FROM delivery_jobs WHERE mode='async' AND state IN ('queued','retrying') AND next_at<=?" +
                excluded +
                ' ORDER BY created,id LIMIT ?',
            )
            .all(this.now(), ...active, capacity);
          for (const job of jobs) {
            // Slots can fill while the query is running.
            if (this.stopping || this.slots.size >= this.concurrency) break;
            const work = this.execute(job.id);
            pending.add(work);
            // Attach the rejection handler immediately; drain still reports failures.
            work.then(
              () => pending.delete(work),
              error => {
                failure = error;
                pending.delete(work);
              },
            );
          }
        }
        if (failure) throw failure;
        if (!pending.size) {
          if (this.wakeRequested) continue;
          break;
        }
        if (this.wakeRequested) continue;
        const wake = /** @type {Promise<void>} */ (
          new Promise(resolve => {
            this.resumeWake = resolve;
          })
        );
        try {
          await Promise.race([...pending, wake]);
        } finally {
          this.resumeWake = null;
        }
      }
    } finally {
      await Promise.allSettled([...pending]);
    }
  }
  async close() {
    this.stopping = true;
    clearInterval(this.timer);
    this.resumeWake?.();
    await this.flushing;
    await Promise.allSettled([...this.slots, ...this.legacySlots].map(slot => slot.done));
  }
}
