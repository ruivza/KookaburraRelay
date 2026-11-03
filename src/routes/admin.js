import { channelCatalog } from '../channels.js';
import { route } from '../router.js';
import { fail } from '../util.js';

function pagination(query) {
  const page = Number(query.get('page') || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) fail(400, 'Invalid page');
  return { page, limit: 30, offset: (page - 1) * 30 };
}
async function listing(db, table, query, columns, timeColumn, select = '*') {
  const { page, limit, offset } = pagination(query),
    clauses = [],
    values = [];
  for (const [key, column] of Object.entries(columns)) {
    if (query.get(key)) {
      clauses.push(column + '=?');
      values.push(query.get(key));
    }
  }
  for (const [key, op] of [
    ['from', '>='],
    ['to', '<='],
  ]) {
    if (query.get(key)) {
      const n = Number(query.get(key));
      if (!Number.isSafeInteger(n) || n < 0) fail(400, 'Invalid date filter');
      clauses.push(timeColumn + op + '?');
      values.push(n);
    }
  }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  return {
    page,
    limit,
    total: (await db.prepare(`SELECT count(*) n FROM ${table}${where}`).get(...values)).n,
    items: await db
      .prepare(`SELECT ${select} FROM ${table}${where} ORDER BY ${timeColumn} DESC,id DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset),
  };
}

export function adminRoutes({ db, applications, queue, monitor, maintenance, abuse, access, alerts, now }) {
  const admin = (method, pattern, handler, audit) => route(method, pattern, { auth: 'admin', audit }, handler);
  const value = load => async context => ({ value: await load(context) });
  const registration = async id => {
    const entry = await db.prepare('SELECT * FROM registrations WHERE id=? AND expires>?').get(id, now());
    if (!entry) fail(404, 'Registration not found');
    return entry;
  };
  return [
    admin(
      'GET',
      '/admin/apps',
      value(async () => ({ applications: await applications.list(), channels: channelCatalog })),
    ),
    admin(
      'POST',
      '/admin/apps',
      async ({ body }) => {
        const created = await applications.create(body);
        return { status: 201, value: created, appId: created.id };
      },
      'application.create',
    ),
    admin(
      'GET',
      '/admin/apps/:id',
      value(({ params }) => applications.describe(params.id)),
    ),
    admin(
      'PUT',
      '/admin/apps/:id',
      async ({ params, body }) => ({ value: await applications.update(params.id, body), appId: params.id }),
      'application.update',
    ),
    admin(
      'DELETE',
      '/admin/apps/:id',
      async ({ params }) => ({ value: await applications.remove(params.id), appId: params.id }),
      'application.delete',
    ),
    admin(
      'PUT',
      '/admin/apps/:id/channels/:kind(apns|fcm)',
      async ({ params, body }) => ({
        value: await applications.configureChannel(params.id, params.kind, body),
        appId: params.id,
        channel: params.kind,
      }),
      'channel.update',
    ),
    admin(
      'DELETE',
      '/admin/apps/:id/channels/:kind(apns|fcm)',
      async ({ params }) => ({
        value: await applications.removeChannel(params.id, params.kind),
        appId: params.id,
        channel: params.kind,
      }),
      'channel.delete',
    ),
    admin(
      'GET',
      '/admin/apps/:id/access',
      value(({ params }) => access.describe(params.id)),
    ),
    admin(
      'PUT',
      '/admin/apps/:id/access',
      async ({ params, body }) => ({ value: await access.savePolicy(params.id, body), appId: params.id }),
      'access.settings',
    ),
    admin(
      'GET',
      '/admin/apps/:id/quotas',
      value(({ params }) => abuse.appSettings(params.id)),
    ),
    admin(
      'PUT',
      '/admin/apps/:id/quotas',
      async ({ params, body }) => ({ value: await abuse.saveApp(params.id, body), appId: params.id }),
      'quotas.settings',
    ),
    admin(
      'GET',
      '/admin/servers',
      value(async () => ({ servers: await access.servers() })),
    ),
    admin(
      'POST',
      '/admin/servers',
      value(({ body }) => access.createServer(body)),
      'server.request',
    ),
    admin(
      'POST',
      '/admin/servers/:id',
      value(({ params, body }) => access.updateServer(params.id, body)),
      ({ body }) => 'server.' + body.action,
    ),
    admin(
      'GET',
      '/admin/alerts',
      value(() => alerts.state()),
    ),
    admin(
      'PUT',
      '/admin/alerts',
      value(({ body }) => alerts.save(body)),
      'alerts.settings',
    ),
    admin(
      'GET',
      '/admin/abuse',
      value(() => abuse.state()),
    ),
    admin(
      'PUT',
      '/admin/abuse',
      value(({ body }) => abuse.save(body)),
      'abuse.settings',
    ),
    admin(
      'GET',
      '/admin/settings',
      value(() => maintenance.state()),
    ),
    admin(
      'PUT',
      '/admin/settings',
      value(({ body }) => maintenance.save(body.previewId)),
      'retention.update',
    ),
    admin(
      'POST',
      '/admin/cleanup/preview',
      value(({ body }) => maintenance.preview(body)),
    ),
    admin(
      'POST',
      '/admin/cleanup/run',
      async ({ body }) => ({ status: 202, value: await maintenance.manual(body.previewId) }),
      'cleanup.manual',
    ),
    admin(
      'GET',
      '/admin/overview',
      value(() => monitor.overview()),
    ),
    admin(
      'GET',
      '/admin/monitor',
      value(() => monitor.history()),
    ),
    admin(
      'GET',
      '/admin/metrics',
      value(async () => {
        const overview = await monitor.overview();
        return {
          uptimeSeconds: overview.uptime / 1000,
          queueDepth: overview.queue,
          memoryBytes: overview.memory.rss,
          tasks24h: overview.counts,
        };
      }),
    ),
    admin(
      'GET',
      '/admin/logs',
      value(({ query }) =>
        listing(
          db,
          'gateway_logs',
          query,
          { appId: 'app_id', channel: 'channel', kind: 'kind', status: 'status' },
          'time',
        ),
      ),
    ),
    admin(
      'GET',
      '/admin/jobs',
      value(({ query }) =>
        listing(
          db,
          'delivery_jobs',
          query,
          { appId: 'app_id', channel: 'channel', state: 'state' },
          'created',
          'id,registration_id,app_id,device_id,channel,mode,state,attempts,created,updated,next_at,status,reason,duration',
        ),
      ),
    ),
    admin(
      'DELETE',
      '/admin/jobs/:id',
      async ({ params }) => {
        const job = await queue.cancel(params.id);
        return { value: job, appId: job.app_id, channel: job.channel };
      },
      'task.cancel',
    ),
    admin(
      'GET',
      '/admin/devices',
      value(({ query }) =>
        listing(
          db,
          'registrations',
          query,
          { appId: 'app_id', channel: 'channel' },
          'expires',
          'id,app_id,device_id,server_id,channel,environment,expires,last_sent,(delivery_hash IS NOT NULL) verified',
        ),
      ),
    ),
    admin(
      'DELETE',
      '/admin/devices/:id',
      async ({ params }) => {
        const entry = await registration(params.id);
        await queue.cancelRegistration(entry.id);
        await db.prepare('DELETE FROM registrations WHERE id=?').run(entry.id);
        return { value: { revoked: true }, appId: entry.app_id, channel: entry.channel };
      },
      'device.revoke',
    ),
    admin(
      'POST',
      '/admin/devices/:id/test',
      async ({ params, body }) => {
        const entry = await registration(params.id);
        if (!entry.delivery_hash || !(await applications.current(entry)))
          fail(409, 'Device has not completed verification');
        const job = await queue.enqueue(entry, { requestId: body.requestId });
        return { status: 202, value: queue.public(job), appId: entry.app_id, channel: entry.channel };
      },
      'device.test',
    ),
  ];
}
