// Notify hot-path benchmark: a real gateway on PostgreSQL with a simulated APNs provider.
// GATEWAY_DATABASE_URL=... node scripts/bench.mjs [--jobs 2000] [--concurrency 32] [--provider-delay 50]
//   [--sources 256] [--scenario all|concurrent|phased] [--timeout 600] [--out file.json]
// Each scenario creates and drops its own bench_* schema. Use a disposable database, never production.
// The JSON report goes to stdout, progress to stderr. See docs/PERFORMANCE.md.
import {isMainThread, Worker, workerData, parentPort} from 'node:worker_threads';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir, cpus, totalmem, availableParallelism} from 'node:os';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import http from 'node:http';

const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => performance.timeOrigin + performance.now();
const round = (value, digits = 1) => Number(value.toFixed(digits));
const log = message => process.stderr.write(`[bench] ${message}\n`);

if (isMainThread) await main();
else parentPort.postMessage(await load(workerData));

// Load generator. Runs on its own thread so client work does not share the gateway's event loop.
async function load({base, devices, concurrency, sources, appId, serverId}) {
  const agent = new http.Agent({keepAlive: true, maxSockets: concurrency});
  const latency = new Array(devices.length), status = new Array(devices.length), reasons = {};
  let next = 0;
  const post = (i, payload) => new Promise(resolve => {
    // Client addresses come from the 198.18.0.0/15 benchmarking range (RFC 2544).
    const source = i % sources;
    const req = http.request(base + '/v1/jobs', {method: 'POST', agent, headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
      Authorization: 'Bearer ' + devices[i].credential, 'X-Forwarded-For': `198.18.${source >> 8}.${source & 255}`,
    }}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks).toString()}));
    });
    req.on('error', error => resolve({status: 0, body: JSON.stringify({reason: error.code || 'network_error'})}));
    req.end(payload);
  });
  async function lane() {
    while (next < devices.length) {
      const i = next++;
      const payload = JSON.stringify({appId, deviceId: devices[i].deviceId, serverId, kind: 'sync', requestId: 'bench-request-' + String(i).padStart(8, '0')});
      const start = performance.now();
      const result = await post(i, payload);
      latency[i] = performance.now() - start;
      status[i] = result.status;
      if (result.status !== 202) {
        let reason = '';
        try { const body = JSON.parse(result.body); reason = body.reason || body.error || ''; } catch {}
        const key = result.status + (reason ? ' ' + reason : '');
        reasons[key] = (reasons[key] || 0) + 1;
      }
    }
  }
  const startedAt = now();
  await Promise.all(Array.from({length: Math.min(concurrency, devices.length)}, lane));
  const finishedAt = now();
  agent.destroy();
  return {startedAt, finishedAt, latency, status, reasons};
}

async function main() {
  const {values} = parseArgs({options: {
    jobs: {type: 'string', default: '2000'}, concurrency: {type: 'string', default: '32'},
    'provider-delay': {type: 'string', default: '50'}, sources: {type: 'string', default: '256'},
    scenario: {type: 'string', default: 'all'}, timeout: {type: 'string', default: '600'}, out: {type: 'string'},
  }});
  const integer = (name, min, max) => {
    const value = Number(values[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw Error(`--${name} must be an integer from ${min} to ${max}`);
    return value;
  };
  const options = {jobs: integer('jobs', 1, 9000), concurrency: integer('concurrency', 1, 64),
    providerDelayMs: integer('provider-delay', 0, 10000), sources: integer('sources', 1, 65536), timeoutSeconds: integer('timeout', 1, 86400)};
  const scenarios = values.scenario === 'all' ? ['concurrent', 'phased'] : [values.scenario];
  if (scenarios.some(s => !['concurrent', 'phased'].includes(s))) throw Error('--scenario must be all, concurrent or phased');
  const url = process.env.GATEWAY_DATABASE_URL;
  if (!url) throw Error('GATEWAY_DATABASE_URL is required; use a disposable database');

  const pg = (await import('pg')).default;
  const {createGateway} = await import('../src/server.js');
  const counter = countQueries(pg);
  const observer = new pg.Client({connectionString: url});
  observer.uncounted = true;
  await observer.connect();
  try {
    const report = {benchmark: 'kookaburra-relay /v1/jobs hot path', date: new Date().toISOString(),
      commit: commit(), parameters: {...options, scenarios}, environment: await environment(observer), scenarios: {}};
    for (const scenario of scenarios) report.scenarios[scenario] = await run(scenario, {options, url, pg, createGateway, counter, observer});
    const text = JSON.stringify(report, null, 2);
    if (values.out) writeFileSync(values.out, text + '\n');
    process.stdout.write(text + '\n');
  } finally { await observer.end(); }
}

// Counts every PostgreSQL round-trip, including BEGIN/COMMIT, by statement text.
function countQueries(pg) {
  const counter = {total: 0, statements: new Map()};
  const query = pg.Client.prototype.query;
  pg.Client.prototype.query = function (config, ...rest) {
    if (!this.uncounted) {
      const text = typeof config === 'string' ? config : config?.text ?? '';
      const key = text.replace(/\s+/g, ' ').replace(/\$\d+/g, '?').replace(/\?(?:\s*,\s*\?)*/g, list => list.length > 1 ? '?,...' : '?')
        .replace(/ IN \(\?\)/g, ' IN (?,...)').trim().slice(0, 160);
      counter.total++;
      counter.statements.set(key, (counter.statements.get(key) || 0) + 1);
    }
    return query.call(this, config, ...rest);
  };
  counter.snapshot = () => ({total: counter.total, statements: new Map(counter.statements)});
  counter.since = (start, operations) => {
    const statements = [...counter.statements].map(([sql, count]) => [sql, count - (start.statements.get(sql) || 0)])
      .filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1])
      .map(([sql, count]) => ({perOperation: round(count / operations, 3), count, sql}));
    const total = counter.total - start.total;
    return {operations, total, perOperation: operations ? round(total / operations, 2) : null, statements};
  };
  return counter;
}

function commit() {
  if (process.env.RELAY_GIT_COMMIT) return process.env.RELAY_GIT_COMMIT;
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {encoding: 'utf8'});
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

async function environment(observer) {
  const postgresSettings = {};
  for (const name of ['max_connections', 'shared_buffers', 'synchronous_commit', 'fsync'])
    postgresSettings[name] = (await observer.query('SELECT current_setting($1) v', [name])).rows[0].v;
  return {node: process.version, platform: `${process.platform} ${process.arch}`, container: existsSync('/.dockerenv'),
    cpus: availableParallelism(), cpuModel: cpus()[0]?.model ?? 'unknown', memoryGiB: round(totalmem() / 2 ** 30),
    postgres: (await observer.query('SELECT version() v')).rows[0].v, postgresSettings};
}

function latencies(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return {count: sorted.length, mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p50: round(at(0.5)), p90: round(at(0.9)), p99: round(at(0.99)), max: round(sorted.at(-1))};
}

async function run(scenario, {options, url, pg, createGateway, counter, observer}) {
  log(`${scenario}: starting gateway`);
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-bench-'));
  const schema = 'bench_' + randomBytes(6).toString('hex');
  const challenges = new Map();
  let providerCalls = 0;
  let gateway;
  try {
    gateway = await createGateway({databaseUrl: url, databaseSchema: schema, dataDir, adminToken: randomBytes(32).toString('base64url'),
      trustedProxies: '127.0.0.1', autoStart: scenario === 'concurrent',
      providerFactory: () => ({
        async send(device, token, payload) {
          if (payload.perchRegistration) { challenges.set(payload.perchRegistration.id, payload.perchRegistration); return {status: 200}; }
          providerCalls++;
          if (options.providerDelayMs) await delay(options.providerDelayMs);
          return {status: 200};
        },
        close() {},
      })});
    await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${gateway.server.address().port}`;
    const appId = 'perch-mail', serverId = 'bench-server';
    await gateway.applications.update(appId, {name: 'Benchmark', enabled: true,
      apns: {keyId: 'BENCHKEY01', teamId: 'BENCHTEAM1', topic: 'com.example.bench', environment: 'both', privateKey: 'bench-fixture-key'}});

    // One real enrollment through HTTP provides a template row; the rest are cloned with distinct
    // identities because enrollment is limited to 60 per hour per address.
    const call = async (path, body) => {
      const res = await fetch(base + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
      const value = await res.json();
      if (!res.ok) throw Error(`${path} returned ${res.status}: ${JSON.stringify(value)}`);
      return value;
    };
    const {registrationId} = await call('/v1/registrations', {appId, deviceId: 'bench-template', serverId, deviceToken: 'ab'.repeat(32),
      environment: 'sandbox', platform: 'ios', channel: 'apns', nonce: 'n'.repeat(40)});
    await call(`/v1/registrations/${registrationId}/confirm`, challenges.get(registrationId));
    const devices = Array.from({length: options.jobs}, (_, i) => ({id: randomUUID(), deviceId: 'bench-device-' + i, credential: randomBytes(32).toString('base64url')}));
    await gateway.db.query(`INSERT INTO registrations(id,device_id,server_id,token,token_hash,environment,nonce,expires,delivery_hash,revoke_hash,app_id,channel,app_revision,purpose,kinds)
      SELECT d.id,d.device_id,t.server_id,t.token,d.token_hash,t.environment,t.nonce,t.expires,d.delivery_hash,d.revoke_hash,t.app_id,t.channel,t.app_revision,t.purpose,t.kinds
      FROM registrations t, unnest($2::text[],$3::text[],$4::text[],$5::text[],$6::text[]) AS d(id,device_id,token_hash,delivery_hash,revoke_hash) WHERE t.id=$1`,
    [registrationId, devices.map(d => d.id), devices.map(d => d.deviceId), devices.map(d => hash('bench-token:' + d.id)),
      devices.map(d => hash(d.credential)), devices.map(() => hash(randomBytes(32).toString('base64url')))]);
    await gateway.db.query('ANALYZE registrations');
    log(`${scenario}: seeded ${devices.length} verified registrations in schema ${schema}`);

    const jobs = async () => (await observer.query(`SELECT state,count(*)::int n,min(created)::float8 first_created,max(updated)::float8 last_updated
      FROM ${schema}.delivery_jobs GROUP BY state`)).rows;
    const pending = async () => (await observer.query(`SELECT count(*)::int n FROM ${schema}.delivery_jobs WHERE state IN ('queued','retrying','sending')`)).rows[0].n;
    const abuseBefore = gateway.abuse.state();
    const settle = async () => {
      // Request audit rows are written after the response finishes; wait for three quiet polls.
      for (let previous = -1, quiet = 0; quiet < 3;) {
        await delay(50);
        quiet = previous === counter.total && !gateway.abuse.logWrites ? quiet + 1 : 0;
        previous = counter.total;
      }
    };
    const until = async (condition, deadline) => {
      while (!await condition()) {
        if (now() > deadline) return false;
        await delay(100);
      }
      return true;
    };

    log(`${scenario}: sending ${devices.length} POST /v1/jobs with concurrency ${options.concurrency}`);
    const requestStart = counter.snapshot();
    const loading = new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), {workerData: {base, devices: devices.map(({deviceId, credential}) => ({deviceId, credential})),
        concurrency: options.concurrency, sources: options.sources, appId, serverId}});
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', code => { if (code) reject(Error('Load worker exited with ' + code)); });
    });
    const result = {gateway: {databasePool: gateway.db.pool.options.max, deliveryWorkers: gateway.queue.concurrency}};
    let loaded;
    if (scenario === 'concurrent') {
      loaded = await loading;
      log(`${scenario}: requests done; waiting for deliveries`);
      const complete = await until(async () => !await pending(), loaded.finishedAt + options.timeoutSeconds * 1000);
      await settle();
      const states = await jobs();
      const accepted = states.find(s => s.state === 'accepted');
      const firstCreated = Math.min(...states.map(s => s.first_created));
      result.deliveries = {complete, states: Object.fromEntries(states.map(s => [s.state, s.n])), providerCalls,
        firstEnqueueToAllAcceptedMs: complete && accepted ? Math.round(accepted.last_updated - firstCreated) : null,
        acceptedPerSecond: complete && accepted ? round(accepted.n / ((accepted.last_updated - firstCreated) / 1000)) : null};
      result.roundTrips = {perJob: counter.since(requestStart, accepted?.n ?? 0)};
    } else {
      loaded = await loading;
      await settle();
      const requestRoundTrips = counter.since(requestStart, devices.length);
      log(`${scenario}: requests done; starting delivery workers`);
      const queued = (await jobs()).reduce((sum, s) => sum + s.n, 0);
      const deliveryStart = counter.snapshot(), drainStart = Date.now();
      gateway.queue.start();
      const complete = await until(async () => !await pending(), now() + options.timeoutSeconds * 1000);
      await settle();
      const states = await jobs();
      const accepted = states.find(s => s.state === 'accepted');
      result.deliveries = {complete, queued, states: Object.fromEntries(states.map(s => [s.state, s.n])), providerCalls,
        drainMs: complete && accepted ? Math.round(accepted.last_updated - drainStart) : null,
        acceptedPerSecond: complete && accepted ? round(accepted.n / ((accepted.last_updated - drainStart) / 1000)) : null};
      result.roundTrips = {perRequest: requestRoundTrips, perDelivery: counter.since(deliveryStart, accepted?.n ?? 0)};
    }
    const statuses = {};
    for (const status of loaded.status) statuses[status] = (statuses[status] || 0) + 1;
    const seconds = (loaded.finishedAt - loaded.startedAt) / 1000;
    const abuse = gateway.abuse.state();
    result.http = {requests: devices.length, durationMs: Math.round(seconds * 1000), requestsPerSecond: round(devices.length / seconds),
      acceptedPerSecond: round((statuses[202] || 0) / seconds), statuses, rejections: loaded.reasons,
      latencyMs: {all: latencies(loaded.latency), accepted: latencies(loaded.latency.filter((_, i) => loaded.status[i] === 202))},
      auditLogsDropped: abuse.droppedLogs - abuseBefore.droppedLogs};
    result.gatewayRejections = Object.fromEntries(Object.entries(abuse.rejections)
      .map(([reason, count]) => [reason, count - (abuseBefore.rejections[reason] || 0)]).filter(([, count]) => count));
    log(`${scenario}: ${result.http.requestsPerSecond} req/s, p50 ${result.http.latencyMs.all.p50} ms, p99 ${result.http.latencyMs.all.p99} ms, statuses ${JSON.stringify(statuses)}`);
    log(`${scenario}: deliveries ${JSON.stringify(result.deliveries.states)} at ${result.deliveries.acceptedPerSecond} accepted/s; round-trips ` +
      Object.entries(result.roundTrips).map(([name, value]) => `${name} ${value.perOperation}`).join(', '));
    return result;
  } finally {
    await gateway?.close().catch(error => log('gateway close failed: ' + error.message));
    const db = new pg.Client({connectionString: url});
    db.uncounted = true;
    await db.connect();
    try { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await db.end(); }
    rmSync(dataDir, {recursive: true, force: true});
  }
}
