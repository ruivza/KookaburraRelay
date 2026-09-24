import { randomUUID, createHash } from 'node:crypto';
import { deliveryContent, allows } from './notification.js';
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
const terminal = new Set(['accepted','failed','unknown','cancelled']);
const invalidToken = result => result.status === 410 || ['BadDeviceToken','DeviceTokenNotForTopic','UNREGISTERED'].includes(result.reason);
// Only provider error codes from this allowlist may enter logs, never provider text.
const safeReasons = new Set(['BadDeviceToken','DeviceTokenNotForTopic','Unregistered','UNREGISTERED','SENDER_ID_MISMATCH','INVALID_ARGUMENT','QUOTA_EXCEEDED','UNAVAILABLE','INTERNAL','THIRD_PARTY_AUTH_ERROR','InvalidProviderToken','ExpiredProviderToken','TooManyRequests','ServiceUnavailable','Shutdown','BadTopic','TopicDisallowed','AuthenticationError','NetworkError']);
export class DeliveryQueue {
  constructor({ db, applications, open, seal, now = Date.now, autoStart = true, concurrency = 4, abuse, access }) {
    Object.assign(this, { db, applications, open, seal, now, concurrency, abuse, access });
    this.active = new Map();
    this.failures = 0; this.lastSuccessAt = null; this.lastErrorAt = null;
    this.slots = new Set();
    if (autoStart) this.start();
  }
  start() {
    if (!this.timer && !this.stopping) this.timer = setInterval(() => { void this.poll(); }, 1000).unref();
  }
  async poll() {
    if(this.polling)return this.polling;
    this.polling=(async()=>{
      try { await this.flush(); this.lastSuccessAt=this.now(); this.lastErrorAt=null; }
      catch { this.failures++; this.lastErrorAt=this.now(); console.error('Delivery worker cycle failed'); }
    })();
    try { await this.polling; } finally { this.polling=null; }
  }
  async get(id) { return (await this.db.prepare('SELECT * FROM delivery_jobs WHERE id=?').get(id)); }
  public(job) { if (!job) fail(404, 'Task not found'); const { dedupe, notification, notification_hash, notification_sealed, ...safe } = job; return safe; }
  async enqueue(entry, { mode = 'async', requestId, kind = 'sync', notification, alert } = {}) {
    const content = deliveryContent(kind, notification, alert, this.now());
    const encoded = content ? JSON.stringify(content) : '';
    const contentHash = encoded ? createHash('sha256').update(encoded).digest('hex') : '';
    return this.db.transaction(async () => {
      await this.db.query('SELECT pg_advisory_xact_lock(72841104)');
      await this.db.query('SELECT pg_advisory_xact_lock(72841103)');
      entry = await this.db.prepare('SELECT * FROM registrations WHERE id=? AND expires>? FOR UPDATE').get(entry.id,this.now());
      if (!entry || !await this.applications.current(entry)) fail(410,'Registration expired or revoked');
    if (!allows(entry,kind) || !(await this.applications.capabilities(entry.app_id,entry.channel)).includes(kind)) fail(403, 'Credential scope mismatch');
    if (this.stopping) fail(503, 'Gateway shutting down');
    if (mode === 'async' && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(requestId))) fail(400, 'A requestId of 16-100 letters, numbers, underscores or hyphens is required');
    const dedupe = requestId ? createHash('sha256').update(entry.id + ':' + requestId).digest('hex') : null;
    if (dedupe) {
      const previous = (await this.db.prepare('SELECT * FROM delivery_jobs WHERE dedupe=?').get(dedupe));
      if (previous) { if (previous.kind !== kind || previous.notification_hash !== contentHash) fail(409, 'Request ID already used for another kind'); return previous; }
    }
    if ((await this.db.prepare("SELECT count(*) n FROM delivery_jobs WHERE state IN ('queued','retrying','sending')").get()).n >= 10000) fail(503, 'Queue capacity reached');
    // One active sync hint per registration, also prevents legacy/async overlap.
    const pending = (await this.db.prepare("SELECT 1 FROM delivery_jobs WHERE registration_id=? AND state IN ('queued','retrying','sending')").get(entry.id));
    if (pending || (entry.last_sent && this.now() - entry.last_sent < 60000)) fail(429, 'Device rate limit');
    const id = randomUUID(), time = this.now();
      await this.abuse?.task(entry);

      (await this.db.prepare('INSERT INTO delivery_jobs(id,registration_id,app_id,channel,device_id,mode,dedupe,state,created,updated,next_at,expires,kind,notification,notification_hash,notification_sealed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, entry.id, entry.app_id, entry.channel, entry.device_id, mode, dedupe, 'queued', time, time, time, Math.min(entry.expires, time + 86400000, content?.encryptedNotification?.expires ?? Infinity), kind, encoded ? this.seal(encoded) : null, contentHash, 1));
      (await this.db.prepare('UPDATE registrations SET last_sent=? WHERE id=?').run(time, entry.id));
    return (await this.get(id));
    });
  }
  async cancelRegistration(id) {
    (await this.db.prepare("UPDATE delivery_jobs SET state='cancelled',notification=NULL,reason='RegistrationRevoked',updated=? WHERE registration_id=? AND state IN ('queued','retrying','sending')").run(this.now(), id));
  }
  async cancel(id) {
    const job = (await this.get(id));
    if (!job) fail(404, 'Task not found');
    if (!['queued','retrying'].includes(job.state)) fail(409, 'Only waiting tasks can be cancelled');
    (await this.db.prepare("UPDATE delivery_jobs SET state='cancelled',notification=NULL,reason='OperatorCancelled',updated=? WHERE id=? AND state IN ('queued','retrying')").run(this.now(), id));
    return this.public((await this.get(id)));
  }
  reserve() {
    if (this.stopping) fail(503, 'Gateway shutting down');
    if (this.slots.size >= this.concurrency) fail(503, 'Workers busy');
    let finish;
    const slot = { done: new Promise(resolve => { finish = resolve; }) };
    slot.release = () => { this.slots.delete(slot); finish(); };
    this.slots.add(slot);
    return slot;
  }
  async execute(id, reserved) {
    if (this.active.has(id)) return this.active.get(id);
    const slot = reserved || this.reserve();
    const work = this.perform(id);
    this.active.set(id, work);
    try { return await work; }
    finally { this.active.delete(id); slot.release(); }
  }
  async perform(id) {
    const job = (await this.get(id));
    if (!job || terminal.has(job.state)) return job;
    if (job.state === 'sending') return job;
    const entry = (await this.db.prepare('SELECT * FROM registrations WHERE id=? AND expires>? AND delivery_hash IS NOT NULL').get(job.registration_id, this.now()));
    if (!entry || !(await this.applications.current(entry)) || job.expires <= this.now() || !allows(entry,job.kind) || !(await this.applications.capabilities(entry.app_id,entry.channel)).includes(job.kind)) {
      (await this.db.prepare("UPDATE delivery_jobs SET state='cancelled',notification=NULL,reason='RegistrationExpired',updated=? WHERE id=?").run(this.now(), id));
      return (await this.get(id));
    }
    try { await this.abuse?.attempt(entry); }
    catch (error) {
      if (error.status !== 429) throw error;
      const next = this.now() + error.retryAfter * 1000;
      const retry = job.mode === 'async' && next < job.expires;
      await this.db.prepare("UPDATE delivery_jobs SET state=?,status=429,reason='GatewayQuota',next_at=?,updated=?,notification=CASE WHEN ? THEN notification ELSE NULL END WHERE id=? AND state IN ('queued','retrying')")
        .run(retry ? 'retrying' : 'failed', next, this.now(), retry, id);
      return this.get(id);
    }
    const claimed = await this.db.prepare("UPDATE delivery_jobs SET state='sending',attempts=attempts+1,updated=? WHERE id=? AND state IN ('queued','retrying') RETURNING id").get(this.now(), id);
    if (!claimed) return this.get(id);
    const start = performance.now();
    let result;
    try {
      const route = (await this.applications.resolve(entry.app_id, entry.channel, entry.environment));
      // Configuration lookup yields; recheck cancellation immediately before send.
      if ((await this.get(id)).state !== 'sending' || !await this.applications.current(entry)) return this.get(id);
      const content = job.notification ? JSON.parse(job.notification_sealed ? this.open(job.notification) : job.notification) : {};
      const {fallback} = await this.applications.notifications(entry.app_id);
      if ((await this.get(id)).state !== 'sending' || !await this.applications.current(entry)) return this.get(id);
      if (!(await this.applications.capabilities(entry.app_id,entry.channel)).includes(job.kind)) {
        await this.db.prepare("UPDATE delivery_jobs SET state='cancelled',notification=NULL,reason='CapabilityDisabled',updated=? WHERE id=? AND state='sending'").run(this.now(),id);
        return this.get(id);
      }
      if (this.access && !await this.access.active(entry)) { await this.cancelRegistration(entry.id); return this.get(id); }
      result = await route.adapter.send(entry, this.open(entry.token), {kind:job.kind,...content,fallback});
    } catch { result = { status: 0, reason: 'NetworkError' }; }
    if ((await this.get(id)).state !== 'sending') return (await this.get(id));
    if (!(await this.applications.current(entry)) || !(await this.db.prepare('SELECT 1 FROM registrations WHERE id=? AND expires>?').get(entry.id, this.now()))) {
      (await this.cancelRegistration(entry.id));
      return (await this.get(id));
    }
    const status = Number.isInteger(result.status) ? result.status : 0;
    const attempts = job.attempts + 1;
    const retryable = status === 429 || status >= 500;
    let state = status === 200 ? 'accepted' : status === 0 ? 'unknown' : 'failed';
    let next = this.now();
    if (invalidToken(result)) (await this.db.prepare('DELETE FROM registrations WHERE id=?').run(entry.id));
    else if (job.mode === 'async' && retryable && attempts < 6) {
      const header = result.retryAfter;
      const retryAfter = header ? (/^\d+$/.test(String(header)) ? Number(header) * 1000 : Date.parse(header) - this.now()) : 0;
      next += Math.max(Math.min(3600000, Number.isFinite(retryAfter) ? retryAfter : 0), Math.min(3600000, 60000 * 2 ** (attempts - 1))) + Math.floor(Math.random() * 5000);
      if (next < job.expires) state = 'retrying';
    }
    const reason = status === 200 ? '' : safeReasons.has(result.reason) ? result.reason : status === 0 ? 'NetworkError' : 'ProviderRejected';
    (await this.db.prepare("UPDATE delivery_jobs SET state=?,status=?,reason=?,updated=?,next_at=?,duration=?,notification=CASE WHEN ?='retrying' THEN notification ELSE NULL END WHERE id=? AND state='sending'")
      .run(state, status, reason, this.now(), next, Math.round(performance.now() - start), state, id));
    return (await this.get(id));
  }
  async legacy(entry, kind = 'sync', notification, alert) {
    // Legacy callers own retries. Never background-retry a failed legacy call.
    // Reserve synchronously, before the first database await. Async workers use
    // the same slots, so an admitted legacy task always has an executor.
    const slot = this.reserve();
    try {
      const job = await this.enqueue(entry, { mode: 'legacy', kind, notification, alert });
      return await this.execute(job.id, slot);
    } finally { slot.release(); }
  }
  async flush() {
    if (this.stopping) return;
    const capacity = this.concurrency - this.slots.size;
    if (capacity <= 0) return;
    const jobs = (await this.db.prepare("SELECT id FROM delivery_jobs WHERE mode='async' AND state IN ('queued','retrying') AND next_at<=? ORDER BY created LIMIT ?").all(this.now(), capacity));
    await Promise.all(jobs.map(j => this.execute(j.id)));
  }
  async close() {
    this.stopping = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.slots].map(slot => slot.done));
  }
}
