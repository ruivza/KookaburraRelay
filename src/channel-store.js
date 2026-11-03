import { APNsChannel, channelCatalog } from './channels.js';
import { FCMChannel } from './fcm.js';
import { fail } from './util.js';
export class ChannelStore {
  constructor({ db, seal, open, providerFactory, fcmFactory, cache }) {
    Object.assign(this, { db, seal, open, providerFactory, fcmFactory, cache });
    this.adapters = new Map();
  }
  async row(id, kind) {
    return await this.db.prepare('SELECT * FROM app_channels WHERE app_id=? AND kind=?').get(id, kind);
  }
  // The configuration is decrypted on first use and then cached like the adapter built from it: a resolve that
  // hits the cache neither queries nor decrypts, and status checks that need only the flag never decrypt.
  cached(id, kind) {
    return this.cache.get('channel:' + id + ':' + kind, async () => {
      const row = await this.row(id, kind);
      if (!row) return null;
      let config;
      return { enabled: !!row.enabled, config: () => (config ??= JSON.parse(this.open(row.secret))) };
    });
  }
  async enabled(id, kind) {
    return !!(await this.cached(id, kind))?.enabled;
  }
  async describe(id, kind) {
    const row = await this.row(id, kind),
      c = row ? JSON.parse(this.open(row.secret)) : {};
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Invalid channel configuration');
    const row = await this.row(id, kind),
      previous = row ? JSON.parse(this.open(row.secret)) : null;
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
      for (const other of await this.db
        .prepare("SELECT app_id FROM app_channels WHERE kind='apns' AND app_id<>?")
        .all(id)) {
        const c = await this.describe(other.app_id, 'apns');
        if (
          c.teamId === config.teamId &&
          c.topic === config.topic &&
          (c.environment === 'both' || config.environment === 'both' || c.environment === config.environment)
        )
          fail(409, 'Apple topic and environment already assigned');
      }
    } else {
      const account = body.serviceAccount;
      if (account !== undefined && (!account || typeof account !== 'object' || account.type !== 'service_account'))
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
      for (const other of await this.db
        .prepare("SELECT app_id FROM app_channels WHERE kind='fcm' AND app_id<>?")
        .all(id))
        if ((await this.describe(other.app_id, 'fcm')).projectId === config.projectId)
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
    const encrypted = this.seal(JSON.stringify(prepared.config));
    await this.db
      .prepare(
        'INSERT INTO app_channels VALUES(?,?,?,?) ON CONFLICT(app_id,kind) DO UPDATE SET enabled=excluded.enabled,secret=excluded.secret',
      )
      .run(id, kind, +prepared.enabled, encrypted);
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
    const key = id + ':' + kind;
    if (!this.adapters.has(key)) this.adapters.set(key, this.make(kind, { ...config }));
    return this.adapters.get(key);
  }
  invalidate(id) {
    for (const kind of ['apns', 'fcm']) {
      const key = id + ':' + kind;
      this.adapters.get(key)?.close();
      this.adapters.delete(key);
    }
  }
  close() {
    for (const adapter of this.adapters.values()) adapter.close();
    this.adapters.clear();
  }
}
