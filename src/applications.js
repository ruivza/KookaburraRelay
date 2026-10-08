import { randomUUID } from "node:crypto";
import { notificationSettings } from "./notification.js";
import { channelCatalog } from "./channels.js";
import { ChannelStore } from "./channel-store.js";

export const defaultApp = "perch-mail";
const fail = (status, message) => {
  throw Object.assign(Error(message), { status });
};
export const validID = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);

export class Applications {
  constructor({ db, seal, open, providerFactory, fcmFactory, now = Date.now }) {
    Object.assign(this, { db, seal, open, providerFactory, now });
    this.channels = new ChannelStore({ db, seal, open, providerFactory, fcmFactory });
    // Serialize configuration validation and mutation, including cross-app topic uniqueness.
    for (const method of ['create','update','configureChannel','removeChannel','remove']) {
      const perform=this[method].bind(this);
      this[method]=(...args)=>db.transaction(async()=>{
        await db.query('SELECT pg_advisory_xact_lock(72841104)');
        return perform(...args);
      });
    }

  }
  async row(id) {
    if (!validID(id)) fail(400, "Invalid application ID");
    const row = (await this.db
      .prepare("SELECT * FROM applications WHERE id=?")
      .get(id));
    if (!row) fail(404, "Application not found");
    return row;
  }
  async describe(id) {
    const row = (await this.row(id)), apns = (await this.channels.describe(id, 'apns')), fcm = (await this.channels.describe(id, 'fcm'));
    const hasJobs = true;
    const counts = hasJobs ? (await this.db.prepare(`SELECT
      coalesce(sum(CASE WHEN state='accepted' THEN 1 ELSE 0 END),0) accepted, coalesce(sum(CASE WHEN state IN ('failed','unknown') THEN 1 ELSE 0 END),0) failed
      FROM delivery_jobs WHERE app_id=?`).get(id)) : { accepted: 0, failed: 0 };
    return { id, notifications:await this.notifications(id), name: row.name, enabled: !!row.enabled, revision: row.revision,
      ready: !!row.enabled && [apns,fcm].some(c => c.hasKey && c.enabled), apns, fcm, counts,
      registrations: (await this.db.prepare('SELECT count(*) n FROM registrations WHERE app_id=? AND delivery_hash IS NOT NULL AND expires>?').get(id, this.now())).n };
  }

  async publicStatus(id, channel) {
    const row = await this.row(id);
    const configured = await this.db.prepare('SELECT enabled FROM app_channels WHERE app_id=? AND kind=?').get(id, channel);
    return { ready: !!row.enabled && !!configured?.enabled, kinds: await this.capabilities(id, channel) };
  }

  async notifications(id) {
    const row = await this.db.prepare('SELECT settings FROM application_notifications WHERE app_id=?').get(id);
    return notificationSettings(row?.settings);
  }
  async saveNotifications(id, settings) {
    await this.db.prepare('INSERT INTO application_notifications(app_id,settings) VALUES(?,?::jsonb) ON CONFLICT(app_id) DO UPDATE SET settings=excluded.settings').run(id,JSON.stringify(settings));
  }
  async capabilities(id, channel) {
    const config = await this.notifications(id);
    return config.kinds.filter(k => channelCatalog.find(c=>c.id===channel)?.kinds.includes(k));
  }
  async list() {
    const rows = await this.db.prepare("SELECT id FROM applications ORDER BY name,id").all();
    return Promise.all(rows.map(row => this.describe(row.id)));
  }
  async create(body) {
    const notifications = notificationSettings(body.notifications);
    if (!validID(body.id) || !this.validName(body.name))
      fail(400, "Invalid application ID or name");
    if ((await this.db.prepare("SELECT 1 FROM applications WHERE id=?").get(body.id)))
      fail(409, "Application ID already exists");
    (await this.db
      .prepare("INSERT INTO applications VALUES(?,?,1,?,NULL)")
      .run(body.id, body.name.trim(), randomUUID()));
    await this.saveNotifications(body.id,notifications);
    return (await this.describe(body.id));
  }
  validName(name) {
    return (
      typeof name === "string" &&
      name.trim().length > 0 &&
      name.length <= 100 &&
      !/[\x00-\x1f]/.test(name)
    );
  }
  async transaction(action) {
    return (await this.db.transaction(action));
  }
  async invalidate(id) {
    (await this.db.prepare('UPDATE applications SET revision=? WHERE id=?').run(randomUUID(), id));
    (await this.db.prepare('DELETE FROM registrations WHERE app_id=?').run(id));

      (await this.db.prepare("UPDATE delivery_jobs SET state='cancelled',notification=NULL,reason='ConfigurationChanged',updated=? WHERE app_id=? AND state IN ('queued','retrying','sending')").run(this.now(), id));
  }
  async update(id, body) {
    const row = (await this.row(id));
    if (!this.validName(body.name) || typeof body.enabled !== 'boolean') fail(400, 'Invalid application settings');
    const prepared = body.apns === undefined ? null : (await this.channels.prepare(id, 'apns', body.apns));
    const previous = await this.notifications(id);
    const notifications = body.notifications === undefined ? previous : notificationSettings({...previous,...body.notifications});
    const changed = row.enabled !== +body.enabled || prepared?.changed;
    (await this.transaction(async () => {
      (await this.db.prepare('UPDATE applications SET name=?,enabled=? WHERE id=?').run(body.name.trim(), +body.enabled, id));
      if (body.notifications !== undefined) await this.saveNotifications(id,notifications);
      if (prepared) (await this.channels.save(id, 'apns', prepared));
      if (changed) (await this.invalidate(id));
      else for (const kind of previous.kinds.filter(kind => !notifications.kinds.includes(kind))) {
        // Keep confirmed grants scoped as issued. Only the disabled kind's work is cancelled.
        await this.db.prepare("UPDATE delivery_jobs SET state='cancelled',notification=NULL,reason='CapabilityDisabled',updated=? WHERE app_id=? AND kind=? AND state IN ('queued','retrying','sending')").run(this.now(),id,kind);
        await this.db.prepare('DELETE FROM registrations WHERE app_id=? AND delivery_hash IS NULL AND kinds @> ?::jsonb').run(id,JSON.stringify([kind]));
      }
    }));
    if (changed) this.channels.invalidate(id);
    return (await this.describe(id));
  }
  async configureChannel(id, kind, body) {
    (await this.row(id));
    const prepared = (await this.channels.prepare(id, kind, body));
    (await this.transaction(async () => {
      (await this.channels.save(id, kind, prepared));
      if (prepared.changed) (await this.invalidate(id));
    }));
    if (prepared.changed) this.channels.invalidate(id);
    return (await this.describe(id));
  }
  async removeChannel(id, kind) {
    (await this.row(id));
    if (!['apns','fcm'].includes(kind)) fail(404, 'Channel not found');
    (await this.transaction(async () => {
      (await this.db.prepare('DELETE FROM app_channels WHERE app_id=? AND kind=?').run(id, kind));
      if (kind === 'apns') (await this.db.prepare('UPDATE applications SET secret=NULL WHERE id=?').run(id));
      (await this.invalidate(id));
    }));
    this.channels.invalidate(id);
    return (await this.describe(id));
  }
  async remove(id) {
    (await this.row(id));
    (await this.transaction(async () => {
      (await this.invalidate(id));
      (await this.db.prepare('DELETE FROM app_channels WHERE app_id=?').run(id));
      (await this.db.prepare('DELETE FROM applications WHERE id=?').run(id));
    }));
    this.channels.invalidate(id);
    return { deleted: true };
  }
  async resolve(id, channel, environment) {
    const row = (await this.row(id));
    if (!row.enabled) fail(503, 'Application disabled');
    return { revision: row.revision, adapter: (await this.channels.resolve(id, channel, environment)) };
  }
  async current(entry) {
    const row = (await this.db
      .prepare("SELECT * FROM applications WHERE id=?")
      .get(entry.app_id));
    return row?.enabled && row.revision === entry.app_revision;
  }
  close() { this.channels.close(); }
}
