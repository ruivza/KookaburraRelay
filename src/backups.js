import { randomUUID } from 'node:crypto';
import { storageSettings, validateTarget } from './storage-target.js';
export { validateTarget } from './storage-target.js';
import { validateRecipient } from './backup-crypto.js';
import { fail } from './util.js';
import { SettingsStore } from './settings-store.js';
export const backupDefaults = {
  enabled: false,
  endpoint: '',
  bucket: '',
  prefix: 'kookaburra-relay',
  keyId: '',
  recipient: '',
  intervalHours: 24,
  retentionDays: 14,
};
// Whether a job of this kind other than `except` is queued, running or retrying: each kind runs one at a time.
export async function pendingJob(db, kind, except = '') {
  return !!(await db
    .prepare("SELECT 1 FROM backup_jobs WHERE state IN ('queued','running','retrying') AND kind=? AND id<>?")
    .get(kind, except));
}
export class Backups {
  constructor({ db, seal, open, security, now = Date.now, validateKey = validateRecipient }) {
    Object.assign(this, { db, seal, open, security, now, validateKey });
    this.store = new SettingsStore(db, 'backup_settings');
  }
  async initialize() {
    if (await this.row()) return;
    const interval = Number(process.env.GATEWAY_BACKUP_INTERVAL_SECONDS || 86400) / 3600;
    const retention = Number(process.env.GATEWAY_BACKUP_RETENTION_DAYS || 14);
    if (
      !Number.isInteger(interval) ||
      interval < 1 ||
      interval > 168 ||
      !Number.isInteger(retention) ||
      retention < 1 ||
      retention > 365
    )
      throw Error('Invalid initial backup schedule');
    await this.store.initialize({
      settings: { ...backupDefaults, intervalHours: interval, retentionDays: retention, revision: randomUUID() },
      secret: null,
      next_at: this.now(),
    });
  }
  async row() {
    const row = await this.store.read();
    return row ? { ...row, settings: storageSettings(row.settings) } : row;
  }
  // Worker liveness and the last local and remote backups, which status() and summary() both report. Only backup
  // jobs ever complete locally; remote successes count for the current target only.
  async health(row, time) {
    const r = await this.db
      .prepare(
        `SELECT (SELECT heartbeat FROM backup_worker WHERE id=1) heartbeat,
      (SELECT max(local_completed) FROM backup_jobs WHERE kind='backup' AND local_status='completed') last_local,
      (SELECT max(finished) FROM backup_jobs WHERE kind='backup' AND remote_status='completed' AND config_revision=?) last_remote`,
      )
      .get(row.settings.revision);
    return {
      workerOnline: r.heartbeat !== null && r.heartbeat > time - 120000,
      lastLocalSuccess: r.last_local,
      lastRemoteSuccess: r.last_remote,
    };
  }
  async status() {
    const row = await this.row(),
      { workerOnline, lastLocalSuccess, lastRemoteSuccess } = await this.health(row, this.now());
    return {
      settings: { ...row.settings, hasApplicationKey: !!row.secret },
      nextAt: row.next_at,
      workerOnline,
      twoFactorEnabled: (await this.security.status()).twoFactorEnabled,
      remoteCheck: await this.db
        .prepare(
          "SELECT remote_status,COALESCE(finished,created) AS finished FROM backup_jobs WHERE config_revision=? AND remote_status IN ('completed','failed') ORDER BY COALESCE(finished,created) DESC,id DESC LIMIT 1",
        )
        .get(row.settings.revision),
      lastLocalSuccess,
      lastRemoteSuccess,
      jobs: await this.db.prepare('SELECT * FROM backup_jobs ORDER BY created DESC,id DESC LIMIT 30').all(),
    };
  }
  async summary() {
    const row = await this.row(),
      time = this.now();
    const { workerOnline, lastLocalSuccess: local, lastRemoteSuccess: remote } = await this.health(row, time);
    const latest = await this.db
      .prepare(
        "SELECT state,error,local_status,remote_status FROM backup_jobs WHERE kind='backup' AND config_revision=? ORDER BY created DESC,id DESC LIMIT 1",
      )
      .get(row.settings.revision);
    const status = (last, failed) =>
      failed
        ? 'failed'
        : last === null
          ? 'unverified'
          : time - last > row.settings.intervalHours * 3600000 + 3600000
            ? 'overdue'
            : 'ok';
    return {
      workerOnline,
      intervalHours: row.settings.intervalHours,
      local: { lastSuccess: local, status: status(local, latest?.local_status === 'failed') },
      remote: {
        lastSuccess: remote,
        status: row.settings.enabled ? status(remote, latest?.remote_status === 'failed') : 'disabled',
      },
    };
  }
  async save(body) {
    const input = body.settings;
    if (!input || typeof input.enabled !== 'boolean') fail(400, 'Invalid backup settings');
    const settings = storageSettings({});
    for (const key of [...Object.keys(backupDefaults), 'provider', 'region', 'forcePathStyle', 'fixedFileName'])
      settings[key] = input[key];
    Object.assign(settings, storageSettings(settings));
    if (
      !Number.isInteger(settings.intervalHours) ||
      settings.intervalHours < 1 ||
      settings.intervalHours > 168 ||
      !Number.isInteger(settings.retentionDays) ||
      settings.retentionDays < 1 ||
      settings.retentionDays > 365
    )
      fail(400, 'Invalid backup schedule');
    for (const k of ['endpoint', 'bucket', 'prefix', 'keyId', 'recipient'])
      if (typeof settings[k] !== 'string') fail(400, 'Invalid backup settings');
    settings.endpoint = settings.endpoint.trim().replace(/\/$/, '');
    if (typeof settings.region === 'string') settings.region = settings.region.trim();
    for (const k of ['bucket', 'prefix', 'keyId', 'recipient']) settings[k] = settings[k].trim();
    if (
      !['b2', 'r2', 'aws', 'custom'].includes(settings.provider) ||
      typeof settings.forcePathStyle !== 'boolean' ||
      typeof settings.fixedFileName !== 'boolean'
    )
      fail(400, 'Invalid storage provider');
    const hasTarget = settings.enabled || ['endpoint', 'bucket', 'keyId', 'recipient'].some(k => settings[k]);
    if (hasTarget) {
      validateTarget(settings);
      await this.validateKey(settings.recipient);
    }
    if (
      body.applicationKey !== undefined &&
      (typeof body.applicationKey !== 'string' || body.applicationKey.length > 256 || /\s/.test(body.applicationKey))
    )
      fail(400, 'Invalid S3 Secret Access Key');
    await this.db.transaction(async () => {
      await this.security.reauthenticate(await this.security.row(), body);
      const row = await this.store.read({ lock: true });
      if (body.revision !== row.settings.revision) fail(409, 'Backup settings changed; refresh and try again');
      if (await this.db.prepare("SELECT 1 FROM backup_jobs WHERE state='running'").get())
        fail(409, 'Backup worker is busy; wait before changing settings');
      const replacement = body.applicationKey || '';
      if (replacement && replacement.length < 8) fail(400, 'Invalid S3 Secret Access Key');
      if (
        row.secret &&
        !replacement &&
        ((row.settings.provider ?? 'b2') !== settings.provider ||
          row.settings.endpoint !== settings.endpoint ||
          row.settings.bucket !== settings.bucket ||
          row.settings.keyId !== settings.keyId)
      )
        fail(400, 'Enter a new Secret Access Key when changing the storage destination');
      const secret = replacement ? this.seal(replacement) : row.secret;
      if (hasTarget && !secret) fail(400, 'S3 Secret Access Key is required');
      settings.revision = randomUUID();
      await this.store.write({ settings, secret, next_at: this.now() + settings.intervalHours * 3600000 });
      await this.db
        .prepare(
          "UPDATE backup_jobs SET state='cancelled',finished=?,error='ConfigurationChanged' WHERE state IN ('queued','retrying')",
        )
        .run(this.now());
    });
    return this.status();
  }
  async enqueue(kind = 'backup', source = 'manual') {
    if (!['backup', 'test'].includes(kind)) fail(400, 'Invalid backup operation');
    return this.db.transaction(async () => {
      const row = await this.store.read({ lock: true });
      if (kind === 'test') {
        validateTarget(row.settings);
        if (!row.secret || !row.settings.recipient) fail(400, 'Save storage credentials and public key first');
      }
      if (await pendingJob(this.db, kind)) fail(409, 'A backup operation is already pending');
      return this.insert(row, kind, source);
    });
  }
  async insert(row, kind, source) {
    const id = randomUUID();
    await this.db
      .prepare(
        "INSERT INTO backup_jobs(id,kind,source,state,created,next_at,config_revision,remote_status) VALUES(?,?,?,'queued',?,?,?,?)",
      )
      .run(
        id,
        kind,
        source,
        this.now(),
        this.now(),
        row.settings.revision,
        kind === 'test' || row.settings.enabled ? 'pending' : 'disabled',
      );
    return this.db.prepare('SELECT * FROM backup_jobs WHERE id=?').get(id);
  }
  async retry(id) {
    return this.db.transaction(async () => {
      const row = await this.store.read({ lock: true });
      const job = await this.db.prepare('SELECT * FROM backup_jobs WHERE id=? FOR UPDATE').get(id);
      if (!job || !['failed', 'retrying'].includes(job.state)) fail(409, 'This backup cannot be retried');
      if (job.config_revision !== row.settings.revision) fail(409, 'Backup target changed; create a new backup');
      if (await pendingJob(this.db, job.kind, id)) fail(409, 'A backup operation is already pending');
      await this.db
        .prepare("UPDATE backup_jobs SET state='queued',attempts=0,next_at=?,finished=NULL,error='' WHERE id=?")
        .run(this.now(), id);
      return this.db.prepare('SELECT * FROM backup_jobs WHERE id=?').get(id);
    });
  }
}
