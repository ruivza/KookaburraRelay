import { randomUUID } from 'node:crypto';
const DAY = 86400000;
export class Observability {
  constructor({ db, now = Date.now, queue, backups }) {
    Object.assign(this, { db, now, queue, backups });
    this.sampleFailures = 0; this.lastSampleAt = null;
    this.started = now(); this.runId = randomUUID(); this.requests = 0; this.errors = 0; this.elapsed = 0;
  }
  async initialize(autoStart=true) {
    const {db,now}=this;
    await db.prepare('INSERT INTO gateway_runs VALUES(?,?,?,NULL)').run(this.runId, now(), now());
    if (autoStart) this.timer = setInterval(() => { void this.sample().catch(() => { this.sampleFailures++; console.error('Gateway monitoring sample failed'); }); }, 60000).unref();
    await this.sample();
  }
  async record({ kind, action, appId = '', channel = '', status = 200, duration = 0, requestId = randomUUID() }) {
    (await this.db.prepare('INSERT INTO gateway_logs(time,kind,action,app_id,channel,status,duration,request_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(this.now(), kind, action, appId, channel, status, Math.round(duration), requestId));
  }
  request(status, duration) { this.requests++; this.errors += +(status >= 500); this.elapsed += duration; }
  async sample() {
    if (this.sampling) return this.sampling;
    this.sampling = this.collect();
    try { return await this.sampling; } finally { this.sampling = null; }
  }
  async collect() {
    const requests=this.requests, errors=this.errors, elapsed=this.elapsed;
    const mem = process.memoryUsage(),time=this.now();
    await this.db.transaction(async()=>{
      const q = await this.queueStatus();
      await this.db.prepare('INSERT INTO gateway_samples VALUES(?,?,?,?,?,?,?) ON CONFLICT(time) DO UPDATE SET rss=excluded.rss,heap=excluded.heap,requests=excluded.requests,errors=excluded.errors,latency=excluded.latency,queued=excluded.queued').run(time,mem.rss,mem.heapUsed,requests,errors,requests?elapsed/requests:0,q.queued+q.retrying);
      await this.db.prepare('INSERT INTO gateway_queue_samples VALUES(?,?,?,?,?) ON CONFLICT(time) DO UPDATE SET queued=excluded.queued,retrying=excluded.retrying,sending=excluded.sending,oldest_wait_seconds=excluded.oldest_wait_seconds').run(time,q.queued,q.retrying,q.sending,q.oldestWaitSeconds);
      await this.db.prepare('UPDATE gateway_runs SET heartbeat=? WHERE id=?').run(time,this.runId);
    });
    this.requests -= requests; this.errors -= errors; this.elapsed -= elapsed;
    this.lastSampleAt = time;
  }

  async queueStatus() {
    const time=this.now();
    const q=await this.db.prepare(`SELECT count(*) FILTER (WHERE state='queued') queued,
      count(*) FILTER (WHERE state='retrying') retrying,count(*) FILTER (WHERE state='sending') sending,
      min(created) FILTER (WHERE state IN ('queued','retrying')) oldest,
      count(*) FILTER (WHERE state IN ('queued','retrying') AND next_at<?) overdue,
      count(*) FILTER (WHERE state='sending' AND updated<?) stuck
      FROM delivery_jobs WHERE state IN ('queued','retrying','sending')`).get(time-300000,time-120000);
    return {...q,oldestWaitSeconds:q.oldest===null?0:Math.max(0,(time-q.oldest)/1000),
      lastWorkerSuccess:this.queue?.lastSuccessAt??null,workerFailures:this.queue?.failures??0,
      workerError:!!this.queue?.lastErrorAt};
  }
  async business() {
    const time=this.now(), since=time-DAY;
    const results=await this.db.prepare(`SELECT channel,state,count(*) count FROM delivery_jobs
      WHERE updated>=? AND state IN ('accepted','failed','unknown') GROUP BY channel,state`).all(since);
    const buckets=await this.db.prepare(`SELECT (updated / 3600000)*3600000 time,state,count(*) count
      FROM delivery_jobs WHERE updated>=? AND state IN ('accepted','failed','unknown') GROUP BY updated / 3600000,state ORDER BY time`).all(since);
    const failures=await this.db.prepare(`SELECT channel,reason,count(*) count FROM delivery_jobs
      WHERE updated>=? AND state IN ('failed','unknown') GROUP BY channel,reason ORDER BY count(*) DESC LIMIT 8`).all(since);
    return {results,buckets,failures,queueStatus:await this.queueStatus(),
      queueSamples:await this.db.prepare('SELECT * FROM gateway_queue_samples WHERE time>=? ORDER BY time').all(since),
      backupSummary:await this.backups?.summary(),
      diagnostics:{lastSampleAt:this.lastSampleAt,sampleFailures:this.sampleFailures}};
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
    return { ...(await this.overview()), ...(await this.business()), samples: (await this.db.prepare('SELECT * FROM gateway_samples WHERE time>=? ORDER BY time').all(this.now() - DAY)),
      runs: (await this.db.prepare('SELECT * FROM gateway_runs ORDER BY started DESC LIMIT 30').all()), monitors,
      probes: (await this.db.prepare('SELECT monitor,(time / 3600000)*3600000 time,count(*) samples,sum(ok) successes FROM gateway_probes WHERE time>=? GROUP BY monitor,time / 3600000 ORDER BY time').all(this.now() - DAY)),
      retentionDays: (await this.db.prepare('SELECT settings FROM maintenance_settings WHERE id=1').get())?.settings.metricsDays ?? 30, sampleIntervalSeconds: 60 };
  }
  async close() { clearInterval(this.timer); await this.sampling?.catch(() => {}); (await this.db.prepare('UPDATE gateway_runs SET heartbeat=?,stopped=? WHERE id=?').run(this.now(), this.now(), this.runId)); }
}
