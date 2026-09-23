import { channelCatalog } from './channels.js';
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
function pagination(params) {
  const page = Number(params.get('page') || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) fail(400, 'Invalid page');
  return { page, limit: 30, offset: (page - 1) * 30 };
}
async function listing(db, table, params, columns, timeColumn, select = '*') {
  const { page, limit, offset } = pagination(params), clauses = [], values = [];
  for (const [key, column] of Object.entries(columns)) {
    if (params.get(key)) { clauses.push(column + '=?'); values.push(params.get(key)); }
  }
  for (const [key, op] of [['from','>='],['to','<=']]) {
    if (params.get(key)) {
      const n = Number(params.get(key));
      if (!Number.isSafeInteger(n) || n < 0) fail(400, 'Invalid date filter');
      clauses.push(timeColumn + op + '?'); values.push(n);
    }
  }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  return { page, limit, total: (await db.prepare(`SELECT count(*) n FROM ${table}${where}`).get(...values)).n,
    items: (await db.prepare(`SELECT ${select} FROM ${table}${where} ORDER BY ${timeColumn} DESC,id DESC LIMIT ? OFFSET ?`).all(...values, limit, offset)) };
}
export async function adminAPI({ path, method, body, params, applications, db, queue, monitor, send, now, requestId }) {
  const started = performance.now();
  const audit = async (action, appId = '', channel = '', status = 200) => (await monitor.record({ kind: 'audit', action, appId, channel, status, duration: performance.now() - started, requestId }));
  if (path === '/admin/apps' && method === 'GET') return send(200, { applications: (await applications.list()), channels: channelCatalog });
  if (path === '/admin/apps' && method === 'POST') { const value = (await applications.create(body)); (await audit('application.create', value.id, '', 201)); return send(201, value); }
  const application = path.match(/^\/admin\/apps\/([A-Za-z0-9_-]+)$/);
  if (application) {
    const id = application[1];
    if (method === 'GET') return send(200, (await applications.describe(id)));
    if (method === 'PUT') { const value = (await applications.update(id, body)); (await audit('application.update', id)); return send(200, value); }
    if (method === 'DELETE') { const value = (await applications.remove(id)); (await audit('application.delete', id)); return send(200, value); }
  }
  const channel = path.match(/^\/admin\/apps\/([A-Za-z0-9_-]+)\/channels\/(apns|fcm)$/);
  if (channel && ['PUT','DELETE'].includes(method)) {
    const [, id, kind] = channel;
    const value = method === 'PUT' ? (await applications.configureChannel(id, kind, body)) : (await applications.removeChannel(id, kind));
    (await audit('channel.' + (method === 'PUT' ? 'update' : 'delete'), id, kind)); return send(200, value);
  }
  if (path === '/admin/overview' && method === 'GET') return send(200, (await monitor.overview()));
  if (path === '/admin/monitor' && method === 'GET') return send(200, (await monitor.history()));
  if (path === '/admin/logs' && method === 'GET') return send(200, (await listing(db, 'gateway_logs', params, { appId: 'app_id', channel: 'channel', kind: 'kind', status: 'status' }, 'time')));
  if (path === '/admin/jobs' && method === 'GET') return send(200, (await listing(db, 'delivery_jobs', params, { appId: 'app_id', channel: 'channel', state: 'state' }, 'created', 'id,registration_id,app_id,device_id,channel,mode,state,attempts,created,updated,next_at,status,reason,duration')));
  if (path === '/admin/devices' && method === 'GET') return send(200, (await listing(db, 'registrations', params, { appId: 'app_id', channel: 'channel' }, 'expires', 'id,app_id,device_id,server_id,channel,environment,expires,last_sent,(delivery_hash IS NOT NULL) verified')));
  const device = path.match(/^\/admin\/devices\/([A-Za-z0-9_-]+)(\/test)?$/);
  if (device) {
    const entry = (await db.prepare('SELECT * FROM registrations WHERE id=? AND expires>?').get(device[1], now()));
    if (!entry) fail(404, 'Registration not found');
    if (method === 'DELETE' && !device[2]) {
      (await queue.cancelRegistration(entry.id)); (await db.prepare('DELETE FROM registrations WHERE id=?').run(entry.id));
      (await audit('device.revoke', entry.app_id, entry.channel)); return send(200, { revoked: true });
    }
    if (method === 'POST' && device[2]) {
      if (!entry.delivery_hash || !(await applications.current(entry))) fail(409, 'Device has not completed verification');
      const job = (await queue.enqueue(entry, { requestId: body.requestId }));
      (await audit('device.test', entry.app_id, entry.channel, 202)); return send(202, queue.public(job));
    }
  }
  const task = path.match(/^\/admin\/jobs\/([A-Za-z0-9_-]+)$/);
  if (task && method === 'DELETE') { const job = (await queue.cancel(task[1])); (await audit('task.cancel', job.app_id, job.channel)); return send(200, job); }
  if (path === '/admin/metrics' && method === 'GET') {
    const value = (await monitor.overview());
    return send(200, { uptimeSeconds: value.uptime / 1000, queueDepth: value.queue, memoryBytes: value.memory.rss, tasks24h: value.counts });
  }
  return send(404, { error: 'Not found' });
}
