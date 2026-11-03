import { APNsChannel, channelCatalog } from './channels.js';
import { FCMChannel } from './fcm.js';
import { fail, isPlainObject } from './util.js';

// Channel identifiers are plain columns and `secret` seals only the private key. Rows from before 0.2.0 sealed the
// whole configuration there; backfill() converts them at startup, and reads accept both.
const columns = config => [
  config.keyId ?? null,
  config.teamId ?? null,
  config.topic ?? null,
  config.environment ?? null,
  config.projectId ?? null,
  config.clientEmail ?? null,
];
const sealedPart = (kind, config) => (kind === 'apns' ? { key: config.key } : { privateKey: config.privateKey });
const converted = row => (row.kind === 'apns' ? row.topic != null : row.project_id != null);

export class ChannelStore {
  constructor({ db, seal, open, providerFactory, fcmFactory, cache }) {
    Object.assign(this, { db, seal, open, providerFactory, fcmFactory, cache });
    this.adapters = new Map();
  }
  async row(id, kind) {
    return await this.db.prepare('SELECT * FROM app_channels WHERE app_id=? AND kind=?').get(id, kind);
  }
  // The full configuration, decrypting only the private key.
  config(kind, row) {
    const sealed = JSON.parse(this.open(row.secret));
    return kind === 'apns'
      ? {
          key: sealed.key,
          keyId: row.key_id ?? sealed.keyId,
          teamId: row.team_id ?? sealed.teamId,
          topic: row.topic ?? sealed.topic,
          environment: row.environment ?? sealed.environment,
        }
      : {
          projectId: row.project_id ?? sealed.projectId,
          clientEmail: row.client_email ?? sealed.clientEmail,
          privateKey: sealed.privateKey,
        };
  }
  // Converts rows that still seal the whole configuration. Runs at startup, before requests are served.
  async backfill() {
    const rows = await this.db
      .prepare(
        "SELECT * FROM app_channels WHERE (kind='apns' AND topic IS NULL) OR (kind='fcm' AND project_id IS NULL)",
      )
      .all();
    for (const row of rows) {
      const config = this.config(row.kind, row);
      await this.db
        .prepare(
          'UPDATE app_channels SET secret=?,key_id=?,team_id=?,topic=?,environment=?,project_id=?,client_email=? WHERE app_id=? AND kind=?',
        )
        .run(this.seal(JSON.stringify(sealedPart(row.kind, config))), ...columns(config), row.app_id, row.kind);
    }
    return rows.length;
  }
  // Decrypts every stored private key; restore verification uses it to prove the master key matches.
  async verify() {
    for (const row of await this.db.prepare('SELECT * FROM app_channels').all()) this.config(row.kind, row);
  }
  // The configuration is decrypted on first use and then cached like the adapter built from it: a resolve that
  // hits the cache neither queries nor decrypts, and status checks that need only the flag never decrypt.
  cached(id, kind) {
    return this.cache.get('channel:' + id + ':' + kind, async () => {
      const row = await this.row(id, kind);
      if (!row) return null;
      let config;
      return { enabled: !!row.enabled, config: () => (config ??= this.config(kind, row)) };
    });
  }
  async enabled(id, kind) {
    // Unknown channel names are answered without a cache entry, so callers cannot fill the cache with them.
    if (!channelCatalog.some(c => c.id === kind && c.implemented)) return false;
    return !!(await this.cached(id, kind))?.enabled;
  }
  async describe(id, kind) {
    return this.present(kind, await this.row(id, kind));
  }
  // Display fields come from the plain columns; nothing is decrypted once rows are converted.
  present(kind, row) {
    const c = !row
      ? {}
      : converted(row)
        ? {
            keyId: row.key_id,
            teamId: row.team_id,
            topic: row.topic,
            environment: row.environment,
            projectId: row.project_id,
            clientEmail: row.client_email,
          }
        : this.config(kind, row);
    return {
      kind,
      enabled: !!row?.enabled,
      hasKey: !!row,
      ...(kind === 'apns'
        ? {
            keyId: c.keyId || '',
            teamId: c.teamId || '',
            topic: c.topic || '',
            environment: c.environment || (row ? 'both' : 'production'),
          }
        : { projectId: c.projectId || '', clientEmail: c.clientEmail || '', environment: 'production' }),
    };
  }
  async prepare(id, kind, body) {
    if (!channelCatalog.find(c => c.id === kind)?.implemented) fail(501, 'Push channel not implemented');
    if (!isPlainObject(body)) fail(400, 'Invalid channel configuration');
    const row = await this.row(id, kind),
      previous = row ? this.config(kind, row) : null;
    let config;
    if (kind === 'apns') {
      config = {
        key: body.privateKey || previous?.key,
        keyId: body.keyId ?? previous?.keyId,
        teamId: body.teamId ?? previous?.teamId,
        topic: body.topic ?? previous?.topic,
        environment: body.environment ?? previous?.environment ?? 'both',
      };
      if (
        !/^[A-Z0-9]{10}$/.test(config.keyId || '') ||
        !/^[A-Z0-9]{10}$/.test(config.teamId || '') ||
        !/^[A-Za-z0-9.-]{1,255}$/.test(config.topic || '') ||
        !['sandbox', 'production', 'both'].includes(config.environment)
      )
        fail(400, 'Invalid APNs configuration');
      // A missing environment means both, as for delivery.
      if (
        await this.db
          .prepare(
            `SELECT 1 FROM app_channels WHERE kind='apns' AND app_id<>? AND team_id=? AND topic=?
            AND (coalesce(environment,'both')='both' OR ?='both' OR environment=?)`,
          )
          .get(id, config.teamId, config.topic, config.environment, config.environment)
      )
        fail(409, 'Apple topic and environment already assigned');
    } else {
      const account = body.serviceAccount;
      if (account !== undefined && (!isPlainObject(account) || account.type !== 'service_account'))
        fail(400, 'Invalid service account JSON');
      config = account
        ? { projectId: account.project_id, clientEmail: account.client_email, privateKey: account.private_key }
        : previous;
      if (
        !config ||
        !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(config.projectId || '') ||
        typeof config.clientEmail !== 'string' ||
        !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(config.clientEmail)
      )
        fail(400, 'Invalid FCM service account');
      if (
        await this.db
          .prepare("SELECT 1 FROM app_channels WHERE kind='fcm' AND app_id<>? AND project_id=?")
          .get(id, config.projectId)
      )
        fail(409, 'Firebase project already assigned');
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') fail(400, 'Invalid channel state');
    try {
      this.make(kind, config).close();
    } catch {
      fail(400, kind === 'apns' ? 'Invalid P-256 private key' : 'Invalid RSA private key');
    }
    const enabled = body.enabled ?? (row ? !!row.enabled : true);
    return {
      config,
      enabled,
      changed: JSON.stringify(previous) !== JSON.stringify(config) || !!row?.enabled !== enabled,
    };
  }
  make(kind, config) {
    return kind === 'apns'
      ? new APNsChannel(config, this.providerFactory)
      : this.fcmFactory
        ? this.fcmFactory(config)
        : new FCMChannel(config);
  }
  async save(id, kind, prepared) {
    await this.db
      .prepare(
        `INSERT INTO app_channels(app_id,kind,enabled,secret,key_id,team_id,topic,environment,project_id,client_email)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(app_id,kind) DO UPDATE SET enabled=excluded.enabled,secret=excluded.secret,
        key_id=excluded.key_id,team_id=excluded.team_id,topic=excluded.topic,environment=excluded.environment,
        project_id=excluded.project_id,client_email=excluded.client_email`,
      )
      .run(
        id,
        kind,
        +prepared.enabled,
        this.seal(JSON.stringify(sealedPart(kind, prepared.config))),
        ...columns(prepared.config),
      );
    this.cache.invalidate('channel', id);
  }
  async resolve(id, kind, environment) {
    if (!channelCatalog.find(c => c.id === kind)?.implemented) fail(501, 'Push channel not implemented');
    const channel = await this.cached(id, kind);
    if (!channel?.enabled) fail(503, 'Application channel not configured or disabled');
    const config = channel.config();
    if (
      kind === 'apns'
        ? !['sandbox', 'production'].includes(environment) ||
          (config.environment && config.environment !== 'both' && config.environment !== environment)
        : environment !== 'production'
    )
      fail(400, 'Environment not enabled for this application');
    // An adapter belongs to the cache entry it was built from. A resolve that raced a configuration change may build
    // one from the old entry; the first resolve with the new entry replaces it, so old keys never outlive the change.
    const key = id + ':' + kind;
    const current = this.adapters.get(key);
    if (current?.channel === channel) return current.adapter;
    current?.adapter.close();
    const adapter = this.make(kind, { ...config });
    this.adapters.set(key, { channel, adapter });
    return adapter;
  }
  invalidate(id) {
    for (const kind of ['apns', 'fcm']) {
      const key = id + ':' + kind;
      this.adapters.get(key)?.adapter.close();
      this.adapters.delete(key);
    }
  }
  close() {
    for (const { adapter } of this.adapters.values()) adapter.close();
    this.adapters.clear();
  }
}
