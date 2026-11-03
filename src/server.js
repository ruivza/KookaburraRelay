import { AccessControl } from './access.js';
import { Alerts } from './alerts.js';
import { Backups } from './backups.js';
import { loadEncryption } from './master-key.js';
import { clientAddressResolver, rateKey } from './client-address.js';
import { Maintenance } from './maintenance.js';
// Standalone push gateway and administrator HTTP API.
import http from 'node:http';
import { Security } from './security.js';
import { Database } from './database.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Applications, appIdOf, validID } from './applications.js';
import { allows } from './notification.js';
import { DeliveryQueue } from './delivery.js';
import { Observability } from './observability.js';
import { AbuseProtection } from './abuse.js';
import { RateLimiter } from './rate-limit.js';
import { ConfigCache } from './config-cache.js';
import { Scheduler } from './scheduler.js';
import { fail, isPlainObject, isToken43, randomSecret, sha256Hex } from './util.js';
import { match, routeName } from './router.js';
import { publicRoutes } from './routes/public.js';
import { securityRoutes } from './routes/security.js';
import { backupRoutes } from './routes/backups.js';
import { adminRoutes } from './routes/admin.js';
import { deviceRoutes } from './routes/device.js';
// Logged error codes never carry identifiers or messages; logged routes are route patterns.
const errorCode = error => {
  const code = String(error?.code ?? error?.name ?? 'Error');
  return /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : 'Error';
};
// The console is read once per gateway start and served from memory. Pages, scripts and styles revalidate on
// every load (so an upgrade applies at once) and answer an unchanged ETag with 304.
function loadConsole() {
  const files = new Map();
  const add = (path, file, headers) => {
    const body = readFileSync(new URL('../public/' + file, import.meta.url));
    files.set(path, { body, headers, etag: '"' + sha256Hex(body).slice(0, 32) + '"' });
  };
  add('/', 'index.html', {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    // No <base> rewriting, no plugins, forms submit only to the gateway, and links out carry no Referer.
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
  });
  for (const name of [
    'admin',
    'theme',
    'i18n',
    'security-ui',
    'maintenance-ui',
    'monitor-charts',
    'backups-ui',
    'abuse-ui',
    'access-ui',
  ])
    add('/' + name + '.js', name + '.js', { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
  add('/style.css', 'style.css', { 'Content-Type': 'text/css', 'Cache-Control': 'no-cache' });
  for (const name of ['logo', 'favicon'])
    add('/' + name + '.png', 'assets/' + name + '.png', {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=3600',
    });
  return files;
}
// Answers a GET for a console file, or 304 for an unchanged ETag; false when the request is for something else.
function serveConsole(files, req, res, path) {
  const asset = req.method === 'GET' && files.get(path);
  if (!asset) return false;
  const headers = { ...asset.headers, ETag: asset.etag, 'X-Content-Type-Options': 'nosniff' };
  if (req.headers['if-none-match'] === asset.etag) {
    res.writeHead(304, headers);
    res.end();
  } else {
    res.writeHead(200, headers);
    res.end(asset.body);
  }
  return true;
}
// A request body is a JSON object of at most 32 KiB; an empty body is {}.
async function readBody(req) {
  let size = 0,
    body;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) fail(413, 'Request too large');
    chunks.push(chunk);
  }
  try {
    body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    fail(400, 'Invalid JSON');
  }
  if (!isPlainObject(body)) fail(400, 'Invalid JSON');
  return body;
}

export async function createGateway({
  databaseUrl = process.env.GATEWAY_DATABASE_URL,
  databaseSchema = process.env.GATEWAY_DATABASE_SCHEMA || 'public',
  dataDir = process.env.GATEWAY_DATA_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data'),
  adminToken = process.env.GATEWAY_ADMIN_TOKEN,
  providerFactory,
  fcmFactory,
  autoStart = true,
  now = Date.now,
  trustedProxies = process.env.GATEWAY_TRUSTED_PROXIES || '',
  onFatal = () => {},
  shutdownTimeout = 30000,
  appleVerifier,
  googleVerifier,
  alertSender,
  databasePoolSize = Number(process.env.GATEWAY_DATABASE_POOL_SIZE || 20),
  deliveryWorkers = Number(process.env.GATEWAY_DELIVERY_WORKERS || 32),
  legacyWorkers = Number(process.env.GATEWAY_LEGACY_WORKERS || 4),
} = {}) {
  if (!Number.isInteger(deliveryWorkers) || deliveryWorkers < 1 || deliveryWorkers > 256)
    throw Error('GATEWAY_DELIVERY_WORKERS must be an integer from 1 to 256');
  // Each synchronous send holds its request open until the provider answers; the cap bounds those requests.
  if (!Number.isInteger(legacyWorkers) || legacyWorkers < 1 || legacyWorkers > 64)
    throw Error('GATEWAY_LEGACY_WORKERS must be an integer from 1 to 64');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const consoleFiles = loadConsole();
  const addressFor = clientAddressResolver(trustedProxies);
  const db = new Database(databaseUrl, databaseSchema, { poolSize: databasePoolSize });
  let owner, applications, queue, monitor, maintenance, server, abuse, access, alerts, scheduler;
  let ownershipLost = false,
    initialized = false,
    shutdown;
  const close = ({ fatal = false } = {}) => {
    if (queue) queue.stopping = true;
    if (fatal) {
      server?.closeAllConnections();
      applications?.close();
    }
    if (shutdown) return shutdown;
    const closed = server ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
    let timer;
    const cleanup = async () => {
      try {
        await scheduler?.close();
        await maintenance?.close();
        await alerts?.close();
        await abuse?.close();
        await queue?.close();
        await closed;
      } finally {
        applications?.close();
        try {
          await monitor?.close();
        } finally {
          try {
            if (owner) {
              const client = owner;
              owner = null;
              // An unlock failure still reaches the caller after the pool is closed below; ending the session
              // releases the lock either way.
              try {
                if (!ownershipLost)
                  await client.query('SELECT pg_advisory_unlock(hashtext(current_schema()), 72841102)');
              } finally {
                await client.end().catch(() => {});
              }
            }
          } finally {
            await db.close();
          }
        }
      }
    };
    shutdown = Promise.race([
      cleanup(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          server?.closeAllConnections();
          applications?.close();
          reject(Error('Gateway shutdown deadline exceeded'));
        }, shutdownTimeout);
      }),
    ]).finally(() => clearTimeout(timer));
    return shutdown;
  };
  try {
    // Explicit single-owner lock: PostgreSQL migration does not imply distributed workers. The session that holds
    // it is outside the pool, so it costs no pool slot. It is taken before migrating, so a gateway refused here
    // never changes the schema another one is running on.
    await db.ensureSchema();
    owner = await db.dedicated();
    owner.on('error', () => {
      ownershipLost = true;
      console.error('Gateway database ownership lost; shutting down');
      if (initialized) {
        void close({ fatal: true }).catch(() => {});
        onFatal();
      }
    });
    const lock = await owner.query('SELECT pg_try_advisory_lock(hashtext(current_schema()), 72841102) locked');
    if (!lock.rows[0].locked) throw Error('Another gateway is using this database');
    await db.initialize();
    const { seal, open } = await loadEncryption(db, dataDir);
    const adminPath = resolve(dataDir, 'admin.token');
    if (adminToken && adminToken.length < 32) throw Error('Gateway admin token must be at least 32 characters');
    // Version 2 marks a gateway whose master key is bound. Before 0.3.0 the first start also created the default
    // perch-mail application, which those installations keep; new ones create applications in the console.
    await db.exec('INSERT INTO schema_migrations VALUES(2) ON CONFLICT DO NOTHING');
    const security = new Security({ db, seal, open, now, adminPath });
    await security.initialize(adminToken);
    const backups = new Backups({ db, seal, open, security, now });
    await backups.initialize();
    const cache = new ConfigCache(db);
    applications = new Applications({ db, seal, open, providerFactory, fcmFactory, now, cache });
    await applications.channels.backfill();
    abuse = new AbuseProtection({ db, now, cache });
    await abuse.initialize();
    access = new AccessControl({ db, seal, open, now, abuse, appleVerifier, googleVerifier, cache });
    queue = new DeliveryQueue({
      db,
      applications,
      open,
      seal,
      now,
      abuse,
      access,
      autoStart: false,
      concurrency: deliveryWorkers,
      legacyConcurrency: legacyWorkers,
    });
    monitor = new Observability({ db, now, queue, backups });
    await monitor.initialize();
    alerts = new Alerts({ db, seal, open, abuse, monitor, now, sender: alertSender });
    await alerts.initialize();
    maintenance = new Maintenance({ db, now, runId: monitor.runId });
    await maintenance.initialize();
    // The abuse cleanup job also applies every expiry rule in src/expiry.js.
    scheduler = new Scheduler()
      .every('abuse-cleanup', 60000, () => abuse.cleanup(), { onError: () => abuse.cleanupFailures++ })
      .every('alerts', 60000, () => alerts.tick(), { onError: () => (alerts.workerFailed = true) })
      .every('maintenance', 60000, () => maintenance.tick(), {
        onError: () => console.error('Maintenance scheduler failed'),
      })
      .every('monitor-sample', 60000, () => monitor.sample(), {
        onError: () => {
          monitor.sampleFailures++;
          console.error('Gateway monitoring sample failed');
        },
      });
    await db
      .prepare(
        "UPDATE delivery_jobs SET state='unknown',notification=NULL,reason='Interrupted',updated=? WHERE state='sending' OR (mode='legacy' AND state='queued')",
      )
      .run(now());
    // Repair content retained by cancellation paths in earlier gateway versions.
    await db.exec(
      "UPDATE delivery_jobs SET notification=NULL WHERE notification IS NOT NULL AND state IN ('accepted','failed','unknown','cancelled')",
    );
    const monitorPath = resolve(dataDir, 'monitor.token');
    if (!existsSync(monitorPath)) writeFileSync(monitorPath, randomSecret(), { mode: 0o600, flag: 'wx' });
    const monitorToken = readFileSync(monitorPath, 'utf8').trim();
    // Unauthenticated enrollment keys have their own capped table that refuses new keys when full; operator, login
    // and sender keys never fail on capacity, the least recently used one is dropped instead. Application and device
    // send windows exist only once a credential checks out, so they have their own table that a source rotating
    // through addresses cannot evict.
    const enrollmentKey = /^(enroll-ip|enroll-token|confirm-ip):/;
    const credentialKey = /^send-(app|device):/;
    const rateLimits = {
      enrollment: new RateLimiter({ capacity: 20000, evict: false, now }),
      credentials: new RateLimiter({ capacity: 100000, evict: true, now }),
      general: new RateLimiter({ capacity: 100000, evict: true, now }),
    };
    function limit(key, maximum, window = 3600000) {
      const pool = enrollmentKey.test(key)
        ? rateLimits.enrollment
        : credentialKey.test(key)
          ? rateLimits.credentials
          : rateLimits.general;
      const result = pool.take(key, maximum, window);
      if (result?.full) abuse.reject('limit_capacity', 60, 503);
      if (result) abuse.reject('source_or_device', result.retryAfter / 1000);
    }

    function bearer(req) {
      return req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    }
    // The registration whose delivery credential is the bearer token, while it and its application configuration
    // are current; 410 otherwise, so a client re-enrolls.
    async function credential(req) {
      const token = bearer(req);
      if (!isToken43(token)) fail(410, 'Registration expired or revoked');
      const value = await db
        .prepare('SELECT * FROM registrations WHERE delivery_hash=? AND expires>?')
        .get(sha256Hex(token), now());
      if (!value || !(await applications.current(value))) fail(410, 'Registration expired or revoked');
      return value;
    }
    async function device(req, body) {
      const value = await credential(req);
      if (
        value.app_id !== appIdOf(body) ||
        value.device_id !== body.deviceId ||
        value.server_id !== body.serverId ||
        !allows(value, body.kind)
      )
        fail(403, 'Credential scope mismatch');
      if (!(await applications.capabilities(value.app_id, value.channel)).includes(body.kind))
        fail(403, 'Notification capability disabled for application');
      await access.delivery(req, value);
      req.gatewayScope = { appId: value.app_id, channel: value.channel };
      return value;
    }
    const services = {
      db,
      applications,
      queue,
      monitor,
      security,
      backups,
      maintenance,
      abuse,
      access,
      alerts,
      scheduler,
      now,
      limit,
      seal,
      open,
      bearer,
      credential,
      device,
    };
    const routes = [
      ...publicRoutes(services),
      ...securityRoutes(services),
      ...backupRoutes(services),
      ...adminRoutes(services),
      ...deviceRoutes(services),
    ];
    server = http.createServer(async (req, res) => {
      const requestId = randomUUID(),
        start = performance.now();
      let path = '',
        body = {},
        release;
      res.setHeader('X-Request-ID', requestId);
      res.once('finish', () => {
        // Detached: a response may finish while the handler's transaction context is still current.
        void db
          .detached(async () => {
            const duration = performance.now() - start;
            monitor.request(res.statusCode, duration);
            if (
              (path.startsWith('/v1/') && req.method !== 'GET') ||
              (res.statusCode >= 400 && res.statusCode !== 429)
            ) {
              await abuse.log(async () => {
                const logApp =
                  req.gatewayScope?.appId ?? (path.startsWith('/v1/') ? appIdOf(body) : (body?.appId ?? ''));
                await monitor.record({
                  kind: res.statusCode >= 400 ? 'error' : 'request',
                  action: req.method + ' ' + routeName(routes, path),
                  appId: validID(logApp) && (await cache.application(logApp)) ? logApp : '',
                  channel: req.gatewayScope?.channel || (['apns', 'fcm'].includes(body?.channel) ? body.channel : ''),
                  status: res.statusCode,
                  duration,
                  requestId,
                });
              });
            }
          })
          .catch(() => console.error('Gateway request audit could not be stored'));
      });
      const send = (status, value) => {
        if (res.destroyed || res.headersSent) return;
        if ((status === 429 || status === 503) && !res.hasHeader('Retry-After')) res.setHeader('Retry-After', '60');
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        });
        res.end(JSON.stringify(value));
      };
      try {
        if (shutdown || ownershipLost) return send(503, { error: 'Gateway shutting down' });
        req.clientAddress = addressFor(req);
        req.rateKey = rateKey(req.clientAddress);
        abuse.admit(req.rateKey);
        const url = new URL(req.url, 'http://localhost');
        path = url.pathname;
        if (serveConsole(consoleFiles, req, res, path)) return;
        if (path === '/favicon.ico' && req.method === 'GET') {
          res.writeHead(204);
          return res.end();
        }
        if (path === '/healthz' && req.method === 'GET') {
          await db.prepare('SELECT 1').get();
          return send(200, { status: 'ok' });
        }
        // Counted before the session lookup, so probing /admin/ paths without a session is limited too.
        if (path.startsWith('/admin/')) {
          await limit('admin:' + req.rateKey, 600, 60000);
          await security.authenticate(bearer(req));
        }
        // Monitor routes require the monitor token whatever the method, before the body is read.
        if (routes.some(entry => entry.auth === 'monitor' && entry.regex.test(path))) {
          await limit('probe:' + req.rateKey, 120, 60000);
          if (!timingSafeEqual(Buffer.from(sha256Hex(bearer(req))), Buffer.from(sha256Hex(monitorToken))))
            fail(401, 'Unauthorized');
        }
        if (['POST', 'PUT', 'DELETE'].includes(req.method)) body = await readBody(req);
        // Only a request whose body has arrived takes a handler slot; see AbuseProtection.slot.
        release = abuse.slot();
        const found = match(routes, req.method, path);
        if (!found) return send(404, { error: 'Not found' });
        const { route: entry, params } = found;
        if (entry.limit) await limit(entry.limit[0] + ':' + req.rateKey, entry.limit[1], entry.limit[2]);
        const context = { req, res, path, body, params, query: url.searchParams, send, requestId };
        const result = await entry.handler(context);
        if (result === undefined) return;
        const status = result.status ?? 200;
        if (entry.audit)
          await monitor.record({
            kind: 'audit',
            action: typeof entry.audit === 'function' ? entry.audit(context) : entry.audit,
            appId: result.appId ?? '',
            channel: result.channel ?? '',
            status,
            duration: performance.now() - start,
            requestId,
          });
        return send(status, result.value);
      } catch (error) {
        if (!error?.status)
          console.error(
            `Gateway request failed requestId=${requestId} method=${req.method} route=${routeName(routes, path)} error=${errorCode(error)}`,
          );
        if (error.retryAfter && !res.headersSent) res.setHeader('Retry-After', String(error.retryAfter));
        send(error.status || 500, {
          error: error.status ? error.message : 'Gateway request failed',
          ...(error.reason ? { reason: error.reason } : {}),
        });
      } finally {
        release?.();
      }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    if (ownershipLost) throw Error('Database ownership lost during startup');
    initialized = true;
    if (autoStart) {
      queue.start();
      scheduler.start();
    }
    return {
      server,
      db,
      adminPath,
      applications,
      queue,
      monitor,
      monitorPath,
      security,
      maintenance,
      backups,
      abuse,
      access,
      alerts,
      scheduler,
      rateLimits,
      routes,
      close,
    };
  } catch (error) {
    await close({ fatal: true }).catch(() => {});
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (existsSync(new URL('../.env', import.meta.url)))
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
  let app, stopping;
  function stop(code) {
    if (code) process.exitCode = code;
    if (stopping) return stopping;
    // A referenced watchdog guarantees exit even if a driver or socket stalls.
    const watchdog = setTimeout(() => process.exit(1), 35000);
    stopping = (async () => {
      try {
        await app?.close({ fatal: code !== 0 });
      } catch {
        process.exitCode = 1;
      } finally {
        clearTimeout(watchdog);
        process.exit(process.exitCode || code);
      }
    })();
    return stopping;
  }
  try {
    app = await createGateway({
      onFatal: () => {
        void stop(1);
      },
    });
    app.server.on('error', () => {
      console.error('Gateway listener failed');
      void stop(1);
    });
    app.server.listen(Number(process.env.GATEWAY_PORT || 3220), process.env.GATEWAY_HOST || '127.0.0.1', () => {
      console.log('Private push gateway ready; admin login token file:', app.adminPath);
    });
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.once(signal, () => {
        void stop(0);
      });
  } catch (error) {
    console.error('Gateway startup failed:', error.message);
    process.exit(1);
  }
}
