// Run on a separate host to observe gateway/host outages. Samples are kept locally
// while the gateway is offline, then uploaded using a dedicated write-only token.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export class UptimeProbe {
  constructor({ db, origin, credential, monitor = 'external-1', fetcher = fetch, now = Date.now }) {
    const url = new URL(origin);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('GATEWAY_URL must be an HTTPS origin (or loopback HTTP)');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(monitor) || typeof credential !== 'string' || credential.length < 32) throw Error('Invalid probe identity or token');
    Object.assign(this, { db, origin: url.origin, credential, monitor, fetcher, now });
    db.exec('CREATE TABLE IF NOT EXISTS samples(time INTEGER PRIMARY KEY,ok INTEGER NOT NULL,latency INTEGER NOT NULL)');
  }
  async tick() {
    const time = this.now(), start = performance.now();
    let ok = false;
    try {
      const response = await this.fetcher(this.origin + '/healthz', { signal: AbortSignal.timeout(10000), redirect: 'error' });
      ok = response.ok && (await response.json()).status === 'ok';
    } catch { /* An unreachable gateway is a failed observation. */ }
    const latency = Math.min(60000, Math.round(performance.now() - start));
    this.db.prepare('INSERT OR REPLACE INTO samples VALUES(?,?,?)').run(time, +ok, latency);
    this.db.prepare('DELETE FROM samples WHERE time<?').run(this.now() - 30 * 86400000);
    // Up to 100 missed observations per tick; never discard until acknowledged.
    const samples = this.db.prepare('SELECT * FROM samples ORDER BY time LIMIT 100').all().map(s => ({ ...s, ok: !!s.ok }));
    try {
      const response = await this.fetcher(this.origin + '/monitor/report', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: 'Bearer ' + this.credential, 'Content-Type': 'application/json' },
        body: JSON.stringify({ monitor: this.monitor, samples }),
      });
      const reply = await response.json();
      if (response.ok && reply.recorded === samples.length)
        this.db.prepare('DELETE FROM samples WHERE time<=?').run(samples.at(-1).time);
    } catch { /* Preserve the spool for the next tick. */ }
    return { ok, latency, pending: this.db.prepare('SELECT count(*) n FROM samples').get().n };
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { GATEWAY_URL, GATEWAY_MONITOR_TOKEN_FILE, PROBE_DATA_DIR, PROBE_NAME } = process.env;
  if (!GATEWAY_URL || !GATEWAY_MONITOR_TOKEN_FILE || !PROBE_DATA_DIR) throw Error('Set GATEWAY_URL, GATEWAY_MONITOR_TOKEN_FILE and PROBE_DATA_DIR');
  mkdirSync(PROBE_DATA_DIR, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolve(PROBE_DATA_DIR, 'probe.sqlite'));
  db.exec('PRAGMA journal_mode=WAL');
  const probe = new UptimeProbe({ db, origin: GATEWAY_URL, credential: readFileSync(GATEWAY_MONITOR_TOKEN_FILE,'utf8').trim(), monitor: PROBE_NAME || 'external-1' });
  let stopped = false, timer, working;
  const run = async () => {
    working = probe.tick();
    try { const result = await working; console.log(new Date().toISOString(), JSON.stringify(result)); }
    catch { console.error('Probe sample failed; check local spool storage'); }
    if (!stopped) timer = setTimeout(run, 60000);
  };
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => {
    stopped = true; clearTimeout(timer); await working?.catch(() => {}); db.close();
  });
  void run();
}
