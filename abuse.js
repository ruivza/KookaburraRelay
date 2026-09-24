const DAY = 86400000;
export const abuseDefaults = Object.freeze({
  registrationEnabled: true,
  registrationGlobalMinute: 300, registrationAppMinute: 120,
  challengeGlobalDay: 10000, challengeAppDay: 5000,
  pendingGlobal: 2000, pendingApp: 1000, challengeConcurrency: 4,
  taskGlobalDay: 100000, taskAppDay: 50000, taskDeviceDay: 240,
  attemptGlobalDay: 150000, attemptAppDay: 75000,
});
const ceilings = { challengeConcurrency: 32, pendingGlobal: 100000, pendingApp: 100000,
  registrationGlobalMinute: 10000, registrationAppMinute: 10000 };

// One gateway process owns each database. Memory admission happens before any DB work;
// durable quotas are charged in the caller's transaction, so failed admission rolls back.
export class AbuseProtection {
  constructor({ db, now = Date.now }) {
    Object.assign(this, { db, now });
    this.settings = { ...abuseDefaults };
    this.buckets = new Map(); this.rejections = Object.create(null);
    this.requests = 0; this.challenges = 0; this.logWrites = 0; this.droppedLogs = 0;
  }
  async initialize() {
    await this.db.prepare('INSERT INTO abuse_settings VALUES(1,?) ON CONFLICT DO NOTHING').run(JSON.stringify(abuseDefaults));
    this.settings = this.validate((await this.db.prepare('SELECT settings FROM abuse_settings WHERE id=1').get()).settings);
    await this.cleanup();
    this.timer = setInterval(() => { void this.cleanup().catch(() => { this.cleanupFailures = (this.cleanupFailures || 0) + 1; }); }, 60000).unref();
  }
  validate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !(k in abuseDefaults)))
      throw Object.assign(Error('Invalid abuse settings'), { status: 400 });
    const result = { ...abuseDefaults, ...input };
    for (const [key, value] of Object.entries(result)) {
      if (key === 'registrationEnabled' ? typeof value !== 'boolean' : !Number.isSafeInteger(value) || value < 1 || value > (ceilings[key] || 10000000))
        throw Object.assign(Error('Invalid abuse settings'), { status: 400 });
    }
    return result;
  }
  async save(input) {
    const settings = this.validate(input);
    await this.db.prepare('UPDATE abuse_settings SET settings=? WHERE id=1').run(JSON.stringify(settings));
    this.settings = settings;
    return this.state();
  }
  state() {
    return { settings: { ...this.settings }, rejections: { ...this.rejections },
      activeRequests: this.requests, activeChallenges: this.challenges,
      droppedLogs: this.droppedLogs, cleanupFailures: this.cleanupFailures || 0 };
  }
  reject(reason, retryAfter = 60, status = 429) {
    this.rejections[reason] = (this.rejections[reason] || 0) + 1;
    throw Object.assign(Error('Gateway resource limit'), { status, reason, retryAfter: Math.max(1, Math.ceil(retryAfter)) });
  }
  memory(key, maximum, window = 60000) {
    const time = this.now();
    let bucket = this.buckets.get(key);
    if (bucket && bucket.until <= time) { this.buckets.delete(key); bucket = null; }
    if (!bucket) {
      if (this.buckets.size >= 10000) {
        for (const [key, value] of this.buckets) if (value.until <= time) this.buckets.delete(key);
        if (this.buckets.size >= 10000) return false;
      }
      bucket = { count: 0, until: time + window }; this.buckets.set(key, bucket);
    }
    if (bucket.count >= maximum) return false;
    bucket.count++; return true;
  }
  admit(address) {
    if (!this.memory('http:global', 6000)) this.reject('request_global');
    if (!this.memory('http:' + address, 600)) this.reject('request_source');
    if (this.requests >= 64) this.reject('request_concurrency', 5, 503);
    this.requests++;
    let released = false;
    return () => { if (!released) { released = true; this.requests--; } };
  }
  reserveChallenge() {
    if (!this.settings.registrationEnabled) this.reject('registration_paused', 300, 503);
    if (this.challenges >= this.settings.challengeConcurrency) this.reject('challenge_concurrency', 10, 503);
    this.challenges++;
    let released = false;
    return () => { if (!released) { released = true; this.challenges--; } };
  }
  async quota(key, maximum, window = DAY, reason = 'daily_quota') {
    const time = this.now(), start = Math.floor(time / window) * window;
    const row = await this.db.prepare(`INSERT INTO abuse_quotas(key,start,expires,count) VALUES(?,?,?,1)
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN abuse_quotas.start<>excluded.start THEN 1 ELSE abuse_quotas.count+1 END,
      start=excluded.start,expires=excluded.expires
      WHERE abuse_quotas.start<>excluded.start OR abuse_quotas.count<? RETURNING count`).get(key, start, start + window, maximum);
    if (!row) this.reject(reason, (start + window - time) / 1000);
  }
  async registration(appId) {
    if (!this.settings.registrationEnabled) this.reject('registration_paused', 300, 503);
    const s = this.settings;
    await this.quota('registration:global', s.registrationGlobalMinute, 60000, 'registration_global');
    await this.quota('registration:app:' + appId, s.registrationAppMinute, 60000, 'registration_app');
    await this.quota('challenge:global', s.challengeGlobalDay, DAY, 'challenge_global_day');
    await this.quota('challenge:app:' + appId, s.challengeAppDay, DAY, 'challenge_app_day');
    const counts = await this.db.prepare(`SELECT count(*) total,count(*) FILTER (WHERE app_id=?) app
      FROM registrations WHERE delivery_hash IS NULL AND expires>?`).get(appId, this.now());
    if (counts.total >= s.pendingGlobal || counts.app >= s.pendingApp) this.reject('registration_capacity', 60, 503);
  }
  async task(entry) {
    const s = this.settings;
    await this.quota('task:global', s.taskGlobalDay, DAY, 'task_global_day');
    await this.quota('task:app:' + entry.app_id, s.taskAppDay, DAY, 'task_app_day');
    // The token hash includes app/channel/environment; re-enrolling cannot reset this quota.
    await this.quota('task:device:' + entry.token_hash, s.taskDeviceDay, DAY, 'task_device_day');
  }
  async attempt(entry) {
    await this.db.transaction(async () => {
      await this.quota('attempt:global', this.settings.attemptGlobalDay, DAY, 'attempt_global_day');
      await this.quota('attempt:app:' + entry.app_id, this.settings.attemptAppDay, DAY, 'attempt_app_day');
    });
  }
  async log(work) {
    if (this.logWrites >= 8 || !this.memory('logs', 120)) { this.droppedLogs++; return; }
    this.logWrites++;
    try { await work(); } finally { this.logWrites--; }
  }
  async cleanup() {
    if (this.cleaning) return this.cleaning;
    this.cleaning = (async () => {
      await this.db.prepare('DELETE FROM abuse_quotas WHERE expires<=?').run(this.now());
      await this.db.prepare('DELETE FROM limits WHERE start<?').run(this.now() - 3600000);
      await this.db.transaction(async () => {
        const expired = await this.db.prepare(`DELETE FROM registrations WHERE id IN
          (SELECT id FROM registrations WHERE expires<=? ORDER BY expires LIMIT 1000)
          AND expires<=? RETURNING id`).all(this.now(), this.now());
        if (expired.length) await this.db.query(`UPDATE delivery_jobs SET state='cancelled',reason='RegistrationExpired',updated=$1
          WHERE registration_id=ANY($2::text[]) AND state IN ('queued','retrying','sending')`, [this.now(), expired.map(r => r.id)]);
      });
      for (const [key, value] of this.buckets) if (value.until <= this.now()) this.buckets.delete(key);
    })();
    try { await this.cleaning; } finally { this.cleaning = null; }
  }
  async close() { clearInterval(this.timer); await this.cleaning; }
}
