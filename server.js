import {Backups} from './backups.js';
import { loadEncryption } from './master-key.js';
import { clientAddressResolver } from './client-address.js';
import {Maintenance} from './maintenance.js';
// Private operator service. Excluded from the open-source server export.
import http from "node:http";
import { Security } from "./security.js";
import { Database } from "./database.js";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Applications, defaultApp, validID } from "./applications.js";
import { channelCatalog } from "./channels.js";
import { DeliveryQueue } from './delivery.js';
import { Observability } from './observability.js';
import { adminAPI } from './admin-api.js';
import { deviceAPI } from './device-api.js';
const hash = (value) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const fail = (status, message) => {
  throw Object.assign(Error(message), { status });
};

export async function createGateway({
  databaseUrl = process.env.GATEWAY_DATABASE_URL,
  databaseSchema = process.env.GATEWAY_DATABASE_SCHEMA || "public",
  dataDir = process.env.GATEWAY_DATA_DIR ||
    resolve(dirname(fileURLToPath(import.meta.url)), "data"),
  adminToken = process.env.GATEWAY_ADMIN_TOKEN,
  providerFactory,
  fcmFactory,
  autoStart = true,
  now = Date.now,
  trustedProxies = process.env.GATEWAY_TRUSTED_PROXIES || '',
  onFatal = () => {},
  shutdownTimeout = 30000,
} = {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const addressFor = clientAddressResolver(trustedProxies);
  const db = new Database(databaseUrl, databaseSchema);
  let owner, applications, queue, monitor, maintenance, server;
  let ownershipLost = false, initialized = false, shutdown;
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
        await maintenance?.close();
        await queue?.close();
        await closed;
      } finally {
        applications?.close();
        try { await monitor?.close(); }
        finally {
          try {
            if (owner) {
              const client = owner; owner = null;
              let discard = ownershipLost;
              try {
                if (!ownershipLost) await client.query("SELECT pg_advisory_unlock(hashtext(current_schema()), 72841102)");
              } catch (error) { discard = true; throw error; }
              finally { client.release(discard); }
            }
          } finally { await db.close(); }
        }
      }
    };
    shutdown = Promise.race([
      cleanup(),
      new Promise((_, reject) => { timer = setTimeout(() => {
        server?.closeAllConnections();
        applications?.close();
        reject(Error('Gateway shutdown deadline exceeded'));
      }, shutdownTimeout); }),
    ]).finally(() => clearTimeout(timer));
    return shutdown;
  };
  try {
    await db.initialize();
    // Explicit single-owner lock: PostgreSQL migration does not imply distributed workers.
    owner = await db.pool.connect();
    owner.on('error', () => {
      ownershipLost = true;
      console.error('Gateway database ownership lost; shutting down');
      if (initialized) {
        void close({ fatal: true }).catch(() => {});
        onFatal();
      }
    });
    const lock = await owner.query("SELECT pg_try_advisory_lock(hashtext(current_schema()), 72841102) locked");
    if (!lock.rows[0].locked) throw Error('Another gateway is using this database');
    const { seal, open } = await loadEncryption(db, dataDir);
    const adminPath = resolve(dataDir, 'admin.token');
    if (!adminToken) {
      if (!existsSync(adminPath)) writeFileSync(adminPath, secret(), { mode: 0o600, flag: 'wx' });
      adminToken = readFileSync(adminPath, 'utf8').trim();
    }
    if (adminToken.length < 32) throw Error('Gateway admin token must be at least 32 characters');
    if (!await db.prepare('SELECT 1 FROM schema_migrations WHERE version=2').get()) {
      await db.transaction(async()=>{
        await db.prepare('INSERT INTO applications VALUES(?,?,1,?,NULL) ON CONFLICT DO NOTHING').run(defaultApp,'Perch Mail',randomUUID());
        await db.exec('INSERT INTO schema_migrations VALUES(2) ON CONFLICT DO NOTHING');
      });
    }
    const security = new Security({db,seal,open,now});
    await security.initialize(adminToken);
    const backups=new Backups({db,seal,open,security,now});
    await backups.initialize();
    applications = new Applications({ db, seal, open, providerFactory, fcmFactory, now });
    queue = new DeliveryQueue({ db, applications, open, now, autoStart: false });
    monitor = new Observability({ db, now, autoStart });
    await monitor.initialize(autoStart);
    maintenance=new Maintenance({db,now,runId:monitor.runId});
    await maintenance.initialize(autoStart);
    await db.prepare("UPDATE delivery_jobs SET state='unknown',reason='Interrupted',updated=? WHERE state='sending' OR (mode='legacy' AND state='queued')").run(now());
    const monitorPath = resolve(dataDir, 'monitor.token');
    if (!existsSync(monitorPath)) writeFileSync(monitorPath, secret(), { mode: 0o600, flag: 'wx' });
    const monitorToken = readFileSync(monitorPath, 'utf8').trim();
    async function limit(key, maximum, window = 3600000) {
      const time = now();
      const entry = await db.prepare(`INSERT INTO limits VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET
        count=CASE WHEN limits.start<=? THEN 1 ELSE limits.count+1 END,
        start=CASE WHEN limits.start<=? THEN excluded.start ELSE limits.start END RETURNING count`).get(key,time,time-window,time-window);
      if(entry.count>maximum) fail(429,'Too many requests');
    }

    function bearer(req) {
      return req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : "";
    }
    async function device(req, body) {
      const value = (await db
        .prepare(
          "SELECT * FROM registrations WHERE delivery_hash=? AND expires>?",
        )
        .get(hash(bearer(req)), now()));
      if (!value || !(await applications.current(value)))
        fail(410, "Registration expired or revoked");
      if (
        value.app_id !== (body.appId ?? defaultApp) ||
        value.device_id !== body.deviceId ||
        value.server_id !== body.serverId ||
        body.kind !== "sync"
      )
        fail(403, "Credential scope mismatch");
      req.gatewayScope = { appId: value.app_id, channel: value.channel };
      return value;
    }
    server = http.createServer(async (req, res) => {
      const requestId = randomUUID(), start = performance.now();
      let path = '', body = {};
      res.setHeader('X-Request-ID', requestId);
      res.once('finish', () => { void (async () => {
        const duration = performance.now() - start;
        monitor.request(res.statusCode, duration);
        if (path.startsWith('/v1/') && req.method !== 'GET' || res.statusCode >= 400 && res.statusCode !== 429) {
          const route = path.replace(/\/registrations\/[^/]+/, '/registrations/:id').replace(/\/apps\/[^/]+/, '/apps/:id').replace(/\/jobs\/[^/]+/, '/jobs/:id').replace(/\/devices\/[^/]+/, '/devices/:id');
          const known = /^\/(v1|admin)\/(registrations|notify|validate|status|apps|overview|monitor|logs|jobs|devices|metrics)(\/(:id|confirm|channels|apns|fcm|test))*$/.test(route);
          const logApp = req.gatewayScope?.appId ?? body?.appId ?? (path.startsWith('/v1/') ? defaultApp : '');
          (await monitor.record({ kind: res.statusCode >= 400 ? 'error' : 'request', action: req.method + ' ' + (known ? route : '/unknown'),
            appId: validID(logApp) && (await db.prepare('SELECT 1 FROM applications WHERE id=?').get(logApp)) ? logApp : '', channel: req.gatewayScope?.channel || (['apns','fcm'].includes(body?.channel) ? body.channel : ''), status: res.statusCode, duration, requestId }));
        }
      })().catch(() => console.error('Gateway request audit could not be stored')); });
      const send = (status, value) => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(JSON.stringify(value));
      };
      try {
        if (shutdown || ownershipLost) return send(503, { error: "Gateway shutting down" });
        req.clientAddress = addressFor(req);
        const url = new URL(req.url, "http://localhost");
        path = url.pathname;
        if (req.method === 'GET' && ['/logo.png','/favicon.png'].includes(path)) {
          res.writeHead(200, {'Content-Type':'image/png','Cache-Control':'public, max-age=3600','X-Content-Type-Options':'nosniff'});
          return res.end(readFileSync(new URL('./assets'+path,import.meta.url)));
        }
        if (path === '/favicon.ico' && req.method === 'GET') { res.writeHead(204); return res.end(); }
        if (path === "/healthz" && req.method === "GET") { (await db.prepare("SELECT 1").get()); return send(200, { status: "ok" }); }
        if (req.method === "GET" && path === "/") {
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy":
              "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
          });
          return res.end(readFileSync(new URL("./index.html", import.meta.url)));
        }
        if (req.method === "GET" && ["/admin.js", "/theme.js", "/i18n.js", "/security-ui.js", "/maintenance-ui.js", "/monitor-charts.js", "/backups-ui.js", "/style.css"].includes(path)) {
          res.writeHead(200, {
            "Content-Type": path.endsWith(".js") ? "text/javascript" : "text/css",
            "X-Content-Type-Options": "nosniff",
          });
          return res.end(readFileSync(new URL("." + path, import.meta.url)));
        }
        if (path.startsWith("/admin/")) {
          await security.authenticate(bearer(req));
          (await limit("admin:" + req.clientAddress, 600, 60000));
        }
        if (path === '/monitor/report' || path === '/metrics') {
          (await limit('probe:' + req.clientAddress, 120, 60000));
          if (!timingSafeEqual(Buffer.from(hash(bearer(req))), Buffer.from(hash(monitorToken)))) fail(401, 'Unauthorized');
        }
        if (["POST", "PUT", "DELETE"].includes(req.method)) {
          let size = 0;
          const chunks = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 24000) fail(413, "Request too large");
            chunks.push(chunk);
          }
          try {
            body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
          } catch {
            fail(400, "Invalid JSON");
          }
          if (!body || typeof body !== "object" || Array.isArray(body))
            fail(400, "Invalid JSON");
        }
        if (path === '/auth/login' && req.method === 'POST') {
          await limit('login:'+req.clientAddress,20,60000);
          return send(200,await security.login(body));
        }
        if (path.startsWith('/admin/security')) {
          if(path === '/admin/security' && req.method==='GET') return send(200,await security.status());
          if(req.method==='POST') {
            await limit('security:'+req.clientAddress,10,60000);
            const actions={'/admin/security/token':'changeToken','/admin/security/setup':'setup','/admin/security/confirm':'confirm','/admin/security/disable':'disable'};
            const action=actions[path];if(action){const result=await security[action](body);await monitor.record({kind:'audit',action:'security.'+action,requestId});return send(200,result);}
          }
        }
        if(path.startsWith('/admin/backups')) {
        if(path==='/admin/backups'&&req.method==='GET')return send(200,await backups.status());
        if(['PUT','POST'].includes(req.method)) {
          await limit('backup-admin:'+req.clientAddress,10,60000);
          let result,action;
          if(path==='/admin/backups'&&req.method==='PUT'){result=await backups.save(body);action='backup.settings';}
          if(path==='/admin/backups/run'&&req.method==='POST'){result=await backups.enqueue();action='backup.run';}
          if(path==='/admin/backups/test'&&req.method==='POST'){result=await backups.enqueue('test');action='backup.test';}
          const retry=path.match(/^\/admin\/backups\/([a-f0-9-]{36})\/retry$/);
          if(retry&&req.method==='POST'){result=await backups.retry(retry[1]);action='backup.retry';}
          if(action){await monitor.record({kind:'audit',action,requestId});return send(req.method==='PUT'?200:202,result);}
        }
      }
      if(path==='/admin/settings' && req.method==='GET') return send(200,await maintenance.state());
        if(path==='/admin/settings' && req.method==='PUT'){const result=await maintenance.save(body.previewId);await monitor.record({kind:'audit',action:'retention.update',requestId});return send(200,result);}
        if(path==='/admin/cleanup/preview' && req.method==='POST') return send(200,await maintenance.preview(body));
        if(path==='/admin/cleanup/run' && req.method==='POST'){const result=await maintenance.manual(body.previewId);await monitor.record({kind:'audit',action:'cleanup.manual',requestId});return send(202,result);}
        if(path==='/admin/logout'&&req.method==='POST'){await security.logout(bearer(req));return send(200,{signedOut:true});}
        (await db.prepare("DELETE FROM registrations WHERE expires<=?").run(now()));
        if (path === "/v1/status" && req.method === "GET") {
          const appId =
            new URL(req.url, "http://localhost").searchParams.get("appId") ||
            defaultApp;
          const app = (await applications.describe(appId));
          return send(200, {
            protocol: 1,
            appId,
            ready: app.enabled && !!app[url.searchParams.get("channel") || "apns"]?.enabled,
            kinds: ["sync"],
          });
        }
        if (path === '/metrics' && req.method === 'GET') {
          const v = (await monitor.overview());
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store' });
          return res.end(`# HELP perch_gateway_uptime_seconds Current process uptime\n# TYPE perch_gateway_uptime_seconds gauge\nperch_gateway_uptime_seconds ${v.uptime / 1000}\n# TYPE perch_gateway_queue_depth gauge\nperch_gateway_queue_depth ${v.queue}\n# TYPE perch_gateway_memory_bytes gauge\nperch_gateway_memory_bytes ${v.memory.rss}\n# TYPE perch_gateway_tasks_24h gauge\nperch_gateway_tasks_24h{state="accepted"} ${v.counts.accepted}\nperch_gateway_tasks_24h{state="failed_or_unknown"} ${v.counts.failed}\n`);
        }
        if (path === '/monitor/report' && req.method === 'POST') return send(200, (await monitor.report(body)));
        if (path.startsWith('/admin/')) return await adminAPI({ path, method: req.method, body, params: url.searchParams, applications, db, queue, monitor, send, now, requestId });
        return await deviceAPI({ req, path, body, send, applications, db, queue, now, limit, hash, secret, seal, open, bearer, device });
      } catch (error) {
        send(error.status || 500, {
          error: error.status ? error.message : "Gateway request failed",
        });
      }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    if (ownershipLost) throw Error('Database ownership lost during startup');
    initialized = true;
    if (autoStart) queue.start();
    return {
      server,
      db,
      adminPath,
      applications,
      queue, monitor, monitorPath, security, maintenance, backups,
      close,
    };
  } catch (error) {
    await close({ fatal: true }).catch(() => {});
    throw error;
  }

}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (existsSync(new URL("./.env",import.meta.url))) process.loadEnvFile(fileURLToPath(new URL("./.env",import.meta.url)));
  let app, stopping;
  function stop(code) {
    if (code) process.exitCode = code;
    if (stopping) return stopping;
    // A referenced watchdog guarantees exit even if a driver or socket stalls.
    const watchdog = setTimeout(() => process.exit(1), 35000);
    stopping = (async () => {
      try { await app?.close({ fatal: code !== 0 }); }
      catch { process.exitCode = 1; }
      finally { clearTimeout(watchdog); process.exit(process.exitCode || code); }
    })();
    return stopping;
  }
  try {
    app = await createGateway({ onFatal: () => { void stop(1); } });
    app.server.on('error', () => { console.error('Gateway listener failed'); void stop(1); });
    app.server.listen(Number(process.env.GATEWAY_PORT || 3220), process.env.GATEWAY_HOST || '127.0.0.1', () => {
      console.log('Private push gateway ready; admin login token file:', app.adminPath);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(0); });
  } catch (error) {
    console.error('Gateway startup failed:', error.message);
    process.exit(1);
  }
}
