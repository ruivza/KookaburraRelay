import { randomUUID } from 'node:crypto';
import { notificationSettings } from './notification.js';
import { channelCatalog } from './channels.js';
import { ChannelStore } from './channel-store.js';
import { cancelJobs } from './delivery.js';
import { ConfigCache } from './config-cache.js';
import { fail } from './util.js';

export const defaultApp = 'perch-mail';
export const validID = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const jobCounts = `SELECT app_id,count(*) FILTER (WHERE state='accepted') accepted,
  count(*) FILTER (WHERE state IN ('failed','unknown')) failed FROM delivery_jobs`;
const activeRegistrations = 'SELECT app_id,count(*) n FROM registrations WHERE delivery_hash IS NOT NULL AND expires>?';

export class Applications {
  constructor({ db, seal, open, providerFactory, fcmFactory, now = Date.now, cache = new ConfigCache(db) }) {
    Object.assign(this, { db, seal, open, providerFactory, now, cache });
    this.channels = new ChannelStore({ db, seal, open, providerFactory, fcmFactory, cache });
    // Serialize configuration validation and mutation, including cross-app topic uniqueness.
    for (const method of ['create', 'update', 'configureChannel', 'removeChannel', 'remove']) {
      const perform = this[method].bind(this);
      this[method] = (...args) =>
        db.transaction(async () => {
          await db.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()), 72841104)');
          this.cache.writing();
          return perform(...args);
        });
    }
  }
  async row(id) {
    if (!validID(id)) fail(400, 'Invalid application ID');
    const row = await this.cache.application(id);
    if (!row) fail(404, 'Application not found');
    return row;
  }
  // Sends, registrations and confirmations hold the application row FOR SHARE while they commit.
  async lock(id) {
    if (!validID(id)) fail(400, 'Invalid application ID');
    const row = await this.db.prepare('SELECT * FROM applications WHERE id=? FOR UPDATE').get(id);
    if (!row) fail(404, 'Application not found');
    return row;
  }
  async describe(id) {
    // Sequential: describe() also runs inside configuration transactions, which have a single connection.
    const row = await this.row(id);
    const channels = await this.db.prepare('SELECT * FROM app_channels WHERE app_id=?').all(id);
    const counts = await this.db.prepare(jobCounts + ' WHERE app_id=? GROUP BY app_id').get(id);
    const registrations = await this.db
      .prepare(activeRegistrations + ' AND app_id=? GROUP BY app_id')
      .get(this.now(), id);
    return this.present(row, channels, counts, registrations);
  }
  async present(row, channels, counts, registrations) {
    const [apns, fcm] = ['apns', 'fcm'].map(kind =>
      this.channels.present(
        kind,
        channels.find(c => c.kind === kind),
      ),
    );
    return {
      id: row.id,
      notifications: await this.notifications(row.id),
      name: row.name,
      enabled: !!row.enabled,
      revision: row.revision,
      ready: !!row.enabled && [apns, fcm].some(c => c.hasKey && c.enabled),
      apns,
      fcm,
      counts: { accepted: counts?.accepted ?? 0, failed: counts?.failed ?? 0 },
      registrations: registrations?.n ?? 0,
    };
  }

  async publicStatus(id, channel) {
    const row = await this.row(id);
    return {
      ready: !!row.enabled && (await this.channels.enabled(id, channel)),
      kinds: await this.capabilities(id, channel),
    };
  }

  async notifications(id) {
    return notificationSettings((await this.cache.notifications(id)) ?? undefined);
  }
  async saveNotifications(id, settings) {
    await this.db
      .prepare(
        'INSERT INTO application_notifications(app_id,settings) VALUES(?,?::jsonb) ON CONFLICT(app_id) DO UPDATE SET settings=excluded.settings',
      )
      .run(id, JSON.stringify(settings));
    this.cache.invalidate('notifications', id);
  }
  async capabilities(id, channel) {
    const config = await this.notifications(id);
    return config.kinds.filter(k => channelCatalog.find(c => c.id === channel)?.kinds.includes(k));
  }
  // Four queries for any number of applications.
  async list() {
    const [rows, channels, counts, registrations] = await Promise.all([
      this.db.prepare('SELECT * FROM applications ORDER BY name,id').all(),
      this.db.prepare('SELECT * FROM app_channels').all(),
      this.db.prepare(jobCounts + ' GROUP BY app_id').all(),
      this.db.prepare(activeRegistrations + ' GROUP BY app_id').all(this.now()),
    ]);
    const byApp = list => new Map(list.map(entry => [entry.app_id, entry]));
    const countsBy = byApp(counts),
      registrationsBy = byApp(registrations);
    return Promise.all(
      rows.map(row =>
        this.present(
          row,
          channels.filter(c => c.app_id === row.id),
          countsBy.get(row.id),
          registrationsBy.get(row.id),
        ),
      ),
    );
  }
  async create(body) {
    const notifications = notificationSettings(body.notifications);
    if (!validID(body.id) || !this.validName(body.name)) fail(400, 'Invalid application ID or name');
    if (await this.db.prepare('SELECT 1 FROM applications WHERE id=?').get(body.id))
      fail(409, 'Application ID already exists');
    await this.db
      .prepare('INSERT INTO applications(id,name,enabled,revision) VALUES(?,?,1,?)')
      .run(body.id, body.name.trim(), randomUUID());
    this.cache.invalidateApplication(body.id);
    await this.saveNotifications(body.id, notifications);
    return await this.describe(body.id);
  }
  validName(name) {
    return typeof name === 'string' && name.trim().length > 0 && name.length <= 100 && !/[\x00-\x1f]/.test(name);
  }
  async invalidate(id) {
    await this.db.prepare('UPDATE applications SET revision=? WHERE id=?').run(randomUUID(), id);
    this.cache.invalidate('app', id);
    await this.db.prepare('DELETE FROM registrations WHERE app_id=?').run(id);
    await cancelJobs(this.db, this.now(), 'ConfigurationChanged', 'app_id=?', [id]);
  }
  async update(id, body) {
    const row = await this.lock(id);
    if (!this.validName(body.name) || typeof body.enabled !== 'boolean') fail(400, 'Invalid application settings');
    const prepared = body.apns === undefined ? null : await this.channels.prepare(id, 'apns', body.apns);
    const previous = await this.notifications(id);
    const notifications =
      body.notifications === undefined ? previous : notificationSettings({ ...previous, ...body.notifications });
    const changed = row.enabled !== +body.enabled || prepared?.changed;
    await this.db.transaction(async () => {
      await this.db
        .prepare('UPDATE applications SET name=?,enabled=? WHERE id=?')
        .run(body.name.trim(), +body.enabled, id);
      this.cache.invalidate('app', id);
      if (body.notifications !== undefined) await this.saveNotifications(id, notifications);
      if (prepared) await this.channels.save(id, 'apns', prepared);
      if (changed) await this.invalidate(id);
      else
        for (const kind of previous.kinds.filter(kind => !notifications.kinds.includes(kind))) {
          // Keep confirmed grants scoped as issued. Only the disabled kind's work is cancelled.
          await this.db
            .prepare('DELETE FROM registrations WHERE app_id=? AND delivery_hash IS NULL AND kinds @> ?::jsonb')
            .run(id, JSON.stringify([kind]));
          await cancelJobs(this.db, this.now(), 'CapabilityDisabled', 'app_id=? AND kind=?', [id, kind]);
        }
    });
    if (changed) this.channels.invalidate(id);
    return await this.describe(id);
  }
  async configureChannel(id, kind, body) {
    await this.lock(id);
    const prepared = await this.channels.prepare(id, kind, body);
    await this.db.transaction(async () => {
      await this.channels.save(id, kind, prepared);
      if (prepared.changed) await this.invalidate(id);
    });
    if (prepared.changed) this.channels.invalidate(id);
    return await this.describe(id);
  }
  async removeChannel(id, kind) {
    await this.lock(id);
    if (!['apns', 'fcm'].includes(kind)) fail(404, 'Channel not found');
    await this.db.transaction(async () => {
      await this.db.prepare('DELETE FROM app_channels WHERE app_id=? AND kind=?').run(id, kind);
      this.cache.invalidate('channel', id);
      await this.invalidate(id);
    });
    this.channels.invalidate(id);
    return await this.describe(id);
  }
  async remove(id) {
    await this.lock(id);
    await this.db.transaction(async () => {
      await this.invalidate(id);
      await this.db.prepare('DELETE FROM app_channels WHERE app_id=?').run(id);
      await this.db.prepare('DELETE FROM applications WHERE id=?').run(id);
      // Notification, quota and access settings cascade with the application row.
      this.cache.invalidateApplication(id);
    });
    this.channels.invalidate(id);
    return { deleted: true };
  }
  async resolve(id, channel, environment) {
    const row = await this.row(id);
    if (!row.enabled) fail(503, 'Application disabled');
    return { revision: row.revision, adapter: await this.channels.resolve(id, channel, environment) };
  }
  async current(entry) {
    const row = await this.cache.application(entry.app_id);
    return row?.enabled && row.revision === entry.app_revision;
  }
  close() {
    this.channels.close();
  }
}
