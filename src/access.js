import { createHash, randomUUID } from 'node:crypto';
import { appIdOf, validID } from './applications.js';
import { requestedKinds } from './notification.js';
import { verifyApple, GoogleIntegrity, googleCredential } from './integrity.js';
import { cancelJobs } from './delivery.js';
import { ConfigCache } from './config-cache.js';
import { DAY, fail, isPlainObject, isToken43, randomSecret, sha256Hex } from './util.js';
export const accessDefaults = Object.freeze({
  requireTrustedServers: false,
  iosRequired: false,
  androidRequired: false,
  teamId: '',
  bundleId: '',
  appleEnvironment: 'production',
  packageName: '',
  certificateDigests: [],
  cloudProjectNumber: '',
});
// Field checks shared by registration and its integrity challenge. APNs tokens are compared lowercased.
// Protocol 2 registrations name their application; protocol 1 may omit it for the default application.
export function validateRegistration(body) {
  const appId = appIdOf(body),
    channel = body.channel ?? 'apns',
    protocol = body.protocol ?? 1;
  if (
    ![1, 2].includes(protocol) ||
    (protocol === 2 && body.appId === undefined) ||
    !validID(appId) ||
    !validID(body.deviceId) ||
    !validID(body.serverId) ||
    !validID(body.nonce) ||
    body.nonce.length < 32 ||
    !['sandbox', 'production'].includes(body.environment) ||
    typeof body.deviceToken !== 'string' ||
    !(channel === 'apns' ? /^[a-f0-9]{32,512}$/i : /^[A-Za-z0-9_:.-]{20,4096}$/).test(body.deviceToken)
  )
    fail(400, 'Invalid registration');
  return {
    appId,
    channel,
    protocol,
    deviceToken: channel === 'apns' ? body.deviceToken.toLowerCase() : body.deviceToken,
  };
}
export function registrationBinding(body) {
  const { appId, channel, deviceToken } = validateRegistration(body),
    platform = body.platform ?? 'ios';
  if (!['apns', 'fcm'].includes(channel) || platform !== (channel === 'apns' ? 'ios' : 'android'))
    fail(400, 'Invalid registration');
  const kinds = requestedKinds(body).slice().sort();
  return sha256Hex(
    JSON.stringify([
      appId,
      channel,
      platform,
      body.environment,
      body.deviceId,
      body.serverId,
      deviceToken,
      body.nonce,
      kinds,
      body.purpose ?? null,
      body.serverTicket ?? null,
    ]),
  );
}
export class AccessControl {
  constructor({
    db,
    seal,
    open,
    now = Date.now,
    abuse,
    appleVerifier = verifyApple,
    googleVerifier,
    cache = new ConfigCache(db),
  }) {
    Object.assign(this, { db, seal, open, now, abuse, appleVerifier, cache });
    this.google = googleVerifier ?? new GoogleIntegrity({ now });
    this.verifying = 0;
  }
  async policy(appId) {
    if (!validID(appId) || !(await this.cache.application(appId))) fail(404, 'Application not found');
    const row = await this.cache.policy(appId);
    return {
      settings: { ...accessDefaults, ...row?.settings },
      revision: row?.revision ?? 'initial',
      secret: row?.google_secret ?? null,
    };
  }
  async publicPolicy(appId) {
    const p = await this.policy(appId);
    return {
      requireTrustedServers: p.settings.requireTrustedServers,
      iosRequired: p.settings.iosRequired,
      androidRequired: p.settings.androidRequired,
      cloudProjectNumber: p.settings.cloudProjectNumber,
      revision: p.revision,
    };
  }
  async describe(appId) {
    const p = await this.policy(appId);
    return { settings: p.settings, hasGoogleCredential: !!p.secret, revision: p.revision };
  }
  validate(input) {
    // Own keys only: `in` would also accept inherited names such as toString or __proto__.
    if (!isPlainObject(input) || Object.keys(input).some(k => !Object.hasOwn(accessDefaults, k)))
      fail(400, 'Invalid access policy');
    const p = { ...accessDefaults, ...input };
    for (const name of ['requireTrustedServers', 'iosRequired', 'androidRequired'])
      if (typeof p[name] !== 'boolean') fail(400, 'Invalid access policy');
    if (
      !['production', 'development'].includes(p.appleEnvironment) ||
      typeof p.teamId !== 'string' ||
      typeof p.bundleId !== 'string' ||
      typeof p.packageName !== 'string' ||
      typeof p.cloudProjectNumber !== 'string'
    )
      fail(400, 'Invalid access policy');
    if (
      (p.teamId && !/^[A-Z0-9]{10}$/.test(p.teamId)) ||
      (p.bundleId && !/^[A-Za-z0-9.-]{3,200}$/.test(p.bundleId)) ||
      (p.packageName && !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(p.packageName)) ||
      (p.cloudProjectNumber && !/^\d{1,20}$/.test(p.cloudProjectNumber))
    )
      fail(400, 'Invalid access policy');
    if (
      !Array.isArray(p.certificateDigests) ||
      p.certificateDigests.length > 10 ||
      p.certificateDigests.some(d => !isToken43(d))
    )
      fail(400, 'Invalid signing certificate digests');
    if (
      (p.iosRequired && (!p.teamId || !p.bundleId)) ||
      (p.androidRequired && (!p.packageName || !p.cloudProjectNumber || !p.certificateDigests.length))
    )
      fail(400, 'Verification configuration incomplete');
    return p;
  }
  async savePolicy(appId, input) {
    const settings = this.validate(input.settings);
    const credential = input.googleServiceAccount ? googleCredential(input.googleServiceAccount) : null;
    await this.db.transaction(async () => {
      await this.db.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()), 72841104)');
      this.cache.writing();
      // Registrations for this application hold its row FOR SHARE while they commit.
      await this.db.prepare('SELECT 1 FROM applications WHERE id=? FOR UPDATE').get(appId);
      const previous = await this.policy(appId),
        encrypted = credential ? this.seal(JSON.stringify(credential)) : previous.secret;
      if (settings.androidRequired && !encrypted) fail(400, 'Google verification credential required');
      // Saving the stored values again, as the console does when nothing was edited, keeps the revision and every
      // registration. Both sides are normalized over accessDefaults, so their keys are in the same order; a supplied
      // Google credential always counts as a change.
      if (!credential && JSON.stringify(settings) === JSON.stringify(previous.settings)) return;
      await this.db
        .prepare(
          'INSERT INTO access_policies VALUES(?,?,?,?) ON CONFLICT(app_id) DO UPDATE SET settings=excluded.settings,revision=excluded.revision,google_secret=excluded.google_secret',
        )
        .run(appId, JSON.stringify(settings), randomUUID(), encrypted);
      this.cache.invalidate('policy', appId);
      // Registrations before their jobs, the lock order every path keeps.
      await this.db.prepare('DELETE FROM registrations WHERE app_id=?').run(appId);
      await cancelJobs(this.db, this.now(), 'AccessPolicyChanged', 'app_id=?', [appId]);
      await this.db.prepare('DELETE FROM integrity_keys WHERE app_id=?').run(appId);
      await this.db.prepare('DELETE FROM integrity_challenges WHERE app_id=?').run(appId);
    });
    return this.describe(appId);
  }
  async servers() {
    return this.db
      .prepare('SELECT id,name,state,apps,created FROM trusted_servers ORDER BY created DESC LIMIT 1000')
      .all();
  }
  async createServer(body) {
    if (
      !validID(body.id) ||
      typeof body.name !== 'string' ||
      !body.name.trim() ||
      body.name.length > 100 ||
      !Array.isArray(body.apps) ||
      !body.apps.length ||
      body.apps.length > 100 ||
      body.apps.some(id => !validID(id))
    )
      fail(400, 'Invalid server application');
    await this.db.transaction(async () => {
      await this.db.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()), 72841104)');
      this.cache.writing();
      if ((await this.db.prepare('SELECT count(*) n FROM trusted_servers').get()).n >= 1000)
        fail(409, 'Server directory full');
      for (const id of body.apps) await this.policy(id);
      if (await this.db.prepare('SELECT 1 FROM trusted_servers WHERE id=?').get(body.id))
        fail(409, 'Server ID already exists');
      await this.db
        .prepare("INSERT INTO trusted_servers VALUES(?,?,'pending',NULL,?,?,?)")
        .run(body.id, body.name.trim(), JSON.stringify([...new Set(body.apps)]), randomUUID(), this.now());
      this.cache.invalidate('server', body.id);
    });
    return { id: body.id, state: 'pending' };
  }
  async updateServer(id, body) {
    if (!['approve', 'block', 'rotate'].includes(body.action)) fail(400, 'Invalid server action');
    const credential = body.action === 'block' ? null : randomSecret();
    await this.db.transaction(async () => {
      await this.db.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()), 72841104)');
      this.cache.writing();
      const row = await this.db.prepare('SELECT * FROM trusted_servers WHERE id=? FOR UPDATE').get(id);
      if (!row) fail(404, 'Server not found');
      if (body.action === 'rotate' && row.state !== 'approved') fail(409, 'Server is not approved');
      await this.db
        .prepare('UPDATE trusted_servers SET state=?,credential_hash=?,revision=? WHERE id=?')
        .run(credential ? 'approved' : 'blocked', credential ? sha256Hex(credential) : null, randomUUID(), id);
      this.cache.invalidate('server', id);
      await this.db.prepare('DELETE FROM server_tickets WHERE server_id=?').run(id);
      // Locking the server's registrations first lets a send holding one finish, so its job is cancelled too.
      const registrations = await this.db.prepare('SELECT id FROM registrations WHERE server_id=? FOR UPDATE').all(id);
      await cancelJobs(this.db, this.now(), 'ServerAccessChanged', 'registration_id=ANY(?::text[])', [
        registrations.map(r => r.id),
      ]);
      await this.db.prepare('DELETE FROM registrations WHERE server_id=?').run(id);
    });
    return { id, state: credential ? 'approved' : 'blocked', ...(credential ? { credential } : {}) };
  }
  async authenticateServer(credential, appId, serverId) {
    if (!isToken43(credential)) fail(403, 'Server credential required');
    const row = await this.db
      .prepare('SELECT * FROM trusted_servers WHERE credential_hash=?')
      .get(sha256Hex(credential));
    if (!row || row.state !== 'approved' || row.id !== serverId || !row.apps.includes(appId))
      fail(403, 'Server not authorized');
    return row;
  }
  async ticket(credential, body) {
    if (!validID(body.appId) || !validID(body.deviceId) || !validID(body.serverId)) fail(400, 'Invalid ticket request');
    const ticket = randomSecret(),
      expiresAt = this.now() + 300000;
    // No lock: a ticket issued while its server is blocked or rotated carries the old revision and is refused.
    await this.db.transaction(async () => {
      const row = await this.authenticateServer(credential, body.appId, body.serverId);
      await this.policy(body.appId);
      await this.abuse.quota('tickets:global', 20000, DAY, 'server_ticket_quota');
      await this.abuse.quota('tickets:server:' + row.id, 5000, DAY, 'server_ticket_quota');
      if ((await this.db.prepare('SELECT count(*) n FROM server_tickets WHERE expires>?').get(this.now())).n >= 2000)
        fail(503, 'Server ticket capacity reached');
      await this.db
        .prepare('INSERT INTO server_tickets VALUES(?,?,?,?,?,?)')
        .run(sha256Hex(ticket), row.id, body.appId, body.deviceId, row.revision, expiresAt);
    });
    return { ticket, expiresAt };
  }
  async registrationServer(body, policy, consume = false) {
    const row = await this.cache.server(body.serverId);
    if (row?.state === 'blocked') fail(403, 'Server blocked');
    if (!body.serverTicket) {
      if (policy.settings.requireTrustedServers) fail(403, 'Server ticket required');
      return null;
    }
    if (!isToken43(body.serverTicket)) fail(403, 'Invalid server ticket');
    // Consuming locks the ticket: a concurrent use waits, then finds it deleted.
    const ticket = await this.db
      .prepare('SELECT * FROM server_tickets WHERE hash=? AND expires>?' + (consume ? ' FOR UPDATE' : ''))
      .get(sha256Hex(body.serverTicket), this.now());
    if (
      !ticket ||
      !row ||
      row.state !== 'approved' ||
      !row.apps.includes(appIdOf(body)) ||
      ticket.server_id !== body.serverId ||
      ticket.device_id !== body.deviceId ||
      ticket.app_id !== appIdOf(body) ||
      ticket.revision !== row.revision
    )
      fail(403, 'Invalid server ticket');
    if (consume) await this.db.prepare('DELETE FROM server_tickets WHERE hash=?').run(sha256Hex(body.serverTicket));
    return { id: row.id, revision: row.revision };
  }
  async registrationEnabled(appId) {
    if (!this.abuse.settings.registrationEnabled || !(await this.abuse.effective(appId)).registrationEnabled)
      this.abuse.reject('registration_paused', 300, 503);
  }
  async challenge(body, address) {
    const registration = body.registration,
      binding = registrationBinding(registration ?? {}),
      appId = appIdOf(registration),
      channel = registration.channel ?? 'apns';
    if (
      !this.abuse.memory('integrity:challenge:' + address, 20) ||
      !this.abuse.memory('integrity:challenge:global', 300)
    )
      this.abuse.reject('integrity_challenge_rate');
    // A challenge created under a policy that changes meanwhile carries the old revision and cannot be used.
    return this.db.transaction(async () => {
      const policy = await this.policy(appId);
      await this.registrationEnabled(appId);
      await this.registrationServer(registration, policy);
      if (!(channel === 'apns' ? policy.settings.iosRequired : policy.settings.androidRequired))
        return { required: false };
      if (
        (await this.db.prepare('SELECT count(*) n FROM integrity_challenges WHERE expires>?').get(this.now())).n >= 2000
      )
        this.abuse.reject('integrity_challenge_capacity', 60, 503);
      const id = randomUUID(),
        payload = 'relay-register-v1:' + randomSecret() + ':' + binding,
        expiresAt = this.now() + 300000;
      const keyKnown =
        typeof body.keyId === 'string' &&
        !!(await this.db
          .prepare('SELECT 1 FROM integrity_keys WHERE app_id=? AND key_id=? AND revision=? AND expires>?')
          .get(appId, body.keyId, policy.revision, this.now()));
      await this.db
        .prepare('INSERT INTO integrity_challenges VALUES(?,?,?,?,?,?,?)')
        .run(id, appId, channel, binding, payload, policy.revision, expiresAt);
      return {
        required: true,
        id,
        payload,
        expiresAt,
        keyKnown,
        requestHash: createHash('sha256').update(payload).digest('base64url'),
        cloudProjectNumber: policy.settings.cloudProjectNumber,
      };
    });
  }
  async prepareRegistration(body, address) {
    const appId = appIdOf(body),
      channel = body.channel ?? 'apns',
      binding = registrationBinding(body);
    const policy = await this.policy(appId),
      required = channel === 'apns' ? policy.settings.iosRequired : policy.settings.androidRequired;
    await this.registrationEnabled(appId);
    await this.registrationServer(body, policy);
    let verified;
    if (required) {
      const proof = body.integrity;
      if (!proof || !validID(proof.challengeId)) fail(403, 'Application proof required');
      if (
        this.verifying >= 4 ||
        !this.abuse.memory('integrity:verify:' + address, 20) ||
        !this.abuse.memory('integrity:verify:global', 120)
      )
        this.abuse.reject('integrity_verification_rate', 60, 503);
      this.verifying++;
      try {
        // Count failed/remote verification attempts too; these quotas commit independently.
        await this.db.transaction(async () => {
          await this.abuse.quota('integrity:global', 10000, DAY, 'integrity_daily');
          await this.abuse.quota('integrity:app:' + appId, 5000, DAY, 'integrity_daily');
        });
        const challenge = await this.db
          .prepare(
            'DELETE FROM integrity_challenges WHERE id=? AND app_id=? AND binding=? AND channel=? AND revision=? AND expires>? RETURNING *',
          )
          .get(proof.challengeId, appId, binding, channel, policy.revision, this.now());
        if (!challenge) fail(403, 'Application challenge expired or used');
        if (channel === 'apns') {
          const key =
            typeof proof.keyId === 'string'
              ? await this.db
                  .prepare('SELECT * FROM integrity_keys WHERE app_id=? AND key_id=? AND revision=? AND expires>?')
                  .get(appId, proof.keyId, policy.revision, this.now())
              : null;
          const result = await this.appleVerifier({
            proof,
            payload: challenge.payload,
            policy: policy.settings,
            key,
            now: this.now(),
          });
          verified = { keyId: proof.keyId, result, previous: key?.counter ?? null };
        } else {
          if (!policy.secret) fail(503, 'Application verification not configured');
          await this.google.verify({
            proof,
            payload: challenge.payload,
            policy: policy.settings,
            credential: JSON.parse(this.open(policy.secret)),
          });
        }
      } finally {
        this.verifying--;
      }
    }
    // The registration transaction checks the policy revision again under the application row lock.
    return this.db.transaction(async () => {
      if ((await this.policy(appId)).revision !== policy.revision) fail(409, 'Access policy changed');
      const server = await this.registrationServer(body, policy, true);
      if (verified) {
        const { keyId, result, previous } = verified;
        // The row lock serializes assertions of one key, so a replayed assertion cannot pass twice at once; a key
        // attested by two registrations at once is inserted by only one of them.
        const current = await this.db
          .prepare('SELECT * FROM integrity_keys WHERE app_id=? AND key_id=? FOR UPDATE')
          .get(appId, keyId);
        if (current && (previous === null || current.counter !== previous || result.counter <= current.counter))
          fail(403, 'Application assertion replayed');
        if (!current && previous !== null) fail(403, 'Application key expired');
        if (!current && (await this.db.prepare('SELECT count(*) n FROM integrity_keys').get()).n >= 100000)
          this.abuse.reject('integrity_key_capacity', 60, 503);
        const stored = await this.db
          .prepare(
            'INSERT INTO integrity_keys VALUES(?,?,?,?,?,?) ON CONFLICT(app_id,key_id) DO ' +
              (current ? 'UPDATE SET counter=excluded.counter,expires=excluded.expires' : 'NOTHING'),
          )
          .run(appId, keyId, result.publicKey, result.counter, policy.revision, this.now() + 90 * DAY);
        if (!stored.changes) fail(403, 'Application assertion replayed');
      }
      return { revision: policy.revision, server };
    });
  }
  async commitRegistration(body, grant) {
    if ((await this.policy(appIdOf(body))).revision !== grant.revision) fail(409, 'Access policy changed');
    // Read under a share lock, not from the cache: blocking or rotating the server takes its row FOR UPDATE and
    // then deletes its registrations, so it either waits for this registration to commit or is seen by it.
    const row = await this.db.prepare('SELECT * FROM trusted_servers WHERE id=? FOR SHARE').get(body.serverId);
    if (
      row?.state === 'blocked' ||
      (grant.server && (!row || row.state !== 'approved' || row.revision !== grant.server.revision))
    )
      fail(403, 'Server blocked or changed');
  }
  async delivery(req, entry) {
    const policy = await this.policy(entry.app_id);
    const row = await this.cache.server(entry.server_id, { stored: true });
    if (row?.state === 'blocked') fail(403, 'Server blocked');
    if (policy.settings.requireTrustedServers || entry.trusted_server)
      await this.authenticateServer(req.headers['x-relay-server-credential'], entry.app_id, entry.server_id);
  }
  async active(entry) {
    const row = await this.cache.server(entry.server_id, { stored: true });
    return row?.state !== 'blocked' && (!entry.trusted_server || row?.state === 'approved');
  }
}
