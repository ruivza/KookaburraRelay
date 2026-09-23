import { randomUUID } from 'node:crypto';
const DAY = 86400000;
export class Observability {
  constructor({ db, now = Date.now, autoStart = true }) {
    Object.assign(this, { db, now });
    this.started = now(); this.runId = randomUUID(); this.requests = 0; this.errors = 0; this.elapsed = 0;
  }
  async initialize(autoStart=true) {
    const {db,now}=this;
    await db.prepare('INSERT INTO gateway_runs VALUES(?,?,?,NULL)').run(this.runId, now(), now());
    if (autoStart) this.timer = setInterval(() => { void this.sample().catch(() => {}); }, 60000).unref();
    await this.sample();
  }
  async record({ kind, action, appId = '', channel = '', status = 200, duration = 0, requestId = randomUUID() }) {
    (await this.db.prepare('INSERT INTO gateway_logs(time,kind,action,app_id,channel,status,duration,request_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(this.now(), kind, action, appId, channel, status, Math.round(duration), requestId));
  }
  request(status, duration) { this.requests++; this.errors += +(status >= 500); this.elapsed += duration; }
  async sample() {
    const mem = process.memoryUsage();
    const queued = (await this.db.prepare("SELECT count(*) n FROM delivery_jobs WHERE state IN ('queued','retrying')").get()).n;
    (await this.db.prepare('INSERT INTO gateway_samples VALUES(?,?,?,?,?,?,?) ON CONFLICT(time) DO UPDATE SET rss=excluded.rss,heap=excluded.heap,requests=excluded.requests,errors=excluded.errors,latency=excluded.latency,queued=excluded.queued').run(this.now(), mem.rss, mem.heapUsed, this.requests, this.errors, this.requests ? this.elapsed / this.requests : 0, queued));
    (await this.db.prepare('UPDATE gateway_runs SET heartbeat=? WHERE id=?').run(this.now(), this.runId));
    this.requests = this.errors = this.elapsed = 0;

  }
  async overview() {
    const db = this.db;
    const counts = (await db.prepare(`SELECT count(*) total,coalesce(sum(CASE WHEN state='accepted' THEN 1 ELSE 0 END),0) accepted,
      coalesce(sum(CASE WHEN state IN ('failed','unknown') THEN 1 ELSE 0 END),0) failed,coalesce(sum(CASE WHEN state IN ('queued','retrying') THEN 1 ELSE 0 END),0) queued,
      coalesce(sum(CASE WHEN state='sending' THEN 1 ELSE 0 END),0) sending FROM delivery_jobs WHERE created>=?`).get(this.now() - DAY));
    return { time: this.now(), runId: this.runId, startedAt: this.started, uptime: Math.max(0, this.now() - this.started),
      memory: process.memoryUsage(), node: process.version, counts,
      applications: (await db.prepare('SELECT count(*) total,coalesce(sum(enabled),0) enabled FROM applications').get()),
      devices: (await db.prepare('SELECT count(*) n FROM registrations WHERE expires>? AND delivery_hash IS NOT NULL').get(this.now())).n,
      queue: (await db.prepare("SELECT count(*) n FROM delivery_jobs WHERE state IN ('queued','retrying','sending')").get()).n,
      recent: (await db.prepare('SELECT id,app_id,channel,state,status,reason,created FROM delivery_jobs ORDER BY created DESC LIMIT 8').all()) };
  }
  async report(body) {
    const fail = () => { throw Object.assign(Error('Invalid probe report'), { status: 400 }); };
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(body.monitor || '') || !Array.isArray(body.samples) || body.samples.length > 100) fail();
    for (const s of body.samples) if (!Number.isSafeInteger(s.time) || s.time < this.now() - 30 * DAY || s.time > this.now() + 60000 || typeof s.ok !== 'boolean' || !Number.isInteger(s.latency) || s.latency < 0 || s.latency > 60000) fail();
    await this.db.transaction(async () => {
      for (const s of body.samples) (await this.db.prepare('INSERT INTO gateway_probes VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(body.monitor, s.time, +s.ok, s.latency));
    });
    return { recorded: body.samples.length };
  }
  async history() {
    const monitors = (await this.db.prepare('SELECT monitor,count(*) samples,sum(ok) successes,max(time) "lastSeen" FROM gateway_probes WHERE time>=? GROUP BY monitor').all(this.now() - DAY));
    return { ...(await this.overview()), samples: (await this.db.prepare('SELECT * FROM gateway_samples WHERE time>=? ORDER BY time').all(this.now() - DAY)),
      runs: (await this.db.prepare('SELECT * FROM gateway_runs ORDER BY started DESC LIMIT 30').all()), monitors,
      probes: (await this.db.prepare('SELECT monitor,(time / 3600000)*3600000 time,count(*) samples,sum(ok) successes FROM gateway_probes WHERE time>=? GROUP BY monitor,time / 3600000 ORDER BY time').all(this.now() - DAY)),
      retentionDays: (await this.db.prepare('SELECT settings FROM maintenance_settings WHERE id=1').get())?.settings.metricsDays ?? 30, sampleIntervalSeconds: 60 };
  }
  async close() { clearInterval(this.timer); (await this.db.prepare('UPDATE gateway_runs SET heartbeat=?,stopped=? WHERE id=?').run(this.now(), this.now(), this.runId)); }
}
