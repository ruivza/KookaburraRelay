import { route } from '../router.js';
import { defaultApp } from '../applications.js';
import { requestedKinds } from '../notification.js';
import { channelCatalog } from '../channels.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { confirmReplay } from '../abuse.js';
import { validateRegistration } from '../access.js';
import { fail, isToken43, randomSecret, sha256Hex } from '../util.js';
export function deviceRoutes({ applications, db, queue, now, limit, seal, open, bearer, device, abuse, access }) {
  return [
    route('POST', '/v1/registrations', {}, async ({ req, body, send }) => {
      const appId = body.appId ?? defaultApp;
      const channel = body.channel ?? 'apns';
      const kinds = requestedKinds(body);
      const purpose = body.purpose ?? (kinds.length === 1 ? kinds[0] : 'scoped');
      const supported = channelCatalog.find(c => c.id === channel)?.kinds ?? [];
      if (kinds.some(k => !supported.includes(k))) fail(501, 'Notification kind not supported by channel');
      if (!channelCatalog.some(c => c.id === channel && c.platform === (body.platform ?? 'ios') && c.implemented))
        fail(501, 'Push channel not implemented');
      req.gatewayScope = { appId, channel };
      const { deviceToken: normalizedToken } = validateRegistration(body);
      // Unknown applications must not create rate-limit rows.
      await applications.row(appId);
      const release = abuse.reserveChallenge();
      let id;
      try {
        await limit('enroll-ip:' + appId + ':' + req.rateKey, 60);
        const tokenHash = sha256Hex(appId + ':' + channel + ':' + body.environment + ':' + normalizedToken);
        await limit('enroll-token:' + tokenHash, 6);
        const accessGrant = await access.prepareRegistration(body, req.rateKey);
        const route = await applications.resolve(appId, channel, body.environment);
        const enabled = await applications.capabilities(appId, channel);
        if (kinds.some(k => !enabled.includes(k))) fail(403, 'Notification capability disabled for application');
        id = randomUUID();
        const challenge = randomSecret();
        const expiresAt = now() + 300000;
        await db.transaction(async () => {
          // Configuration changes to this application take its row FOR UPDATE.
          const application = await db
            .prepare('SELECT enabled,revision FROM applications WHERE id=? FOR SHARE')
            .get(appId);
          await access.commitRegistration(body, accessGrant);
          if (!application?.enabled || application.revision !== route.revision)
            fail(409, 'Application configuration changed');
          const currentKinds = await applications.capabilities(appId, channel);
          if (kinds.some(k => !currentKinds.includes(k))) fail(403, 'Notification capability disabled for application');
          await db.prepare('DELETE FROM registrations WHERE token_hash=? AND delivery_hash IS NULL').run(tokenHash);
          await abuse.registration(appId);
          await db
            .prepare(
              `INSERT INTO registrations(id,device_id,server_id,token,token_hash,environment,nonce,challenge_hash,expires,app_id,channel,app_revision,purpose,kinds,trusted_server)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?)`,
            )
            .run(
              id,
              body.deviceId,
              body.serverId,
              seal(normalizedToken),
              tokenHash,
              body.environment,
              body.nonce,
              sha256Hex(challenge),
              expiresAt,
              appId,
              channel,
              route.revision,
              purpose,
              JSON.stringify(kinds),
              accessGrant.server?.id ?? null,
            );
        });
        const result = await route.adapter.send(
          {
            device_id: body.deviceId,
            environment: body.environment,
            app_id: appId,
          },
          body.deviceToken,
          {
            kind: 'challenge',
            proof: {
              id,
              challenge,
              nonce: body.nonce,
              deviceId: body.deviceId,
              serverId: body.serverId,
              appId,
            },
          },
        );
        if (
          !(await applications.current({ app_id: appId, app_revision: route.revision })) ||
          !(await db.prepare('SELECT 1 FROM registrations WHERE id=?').get(id))
        ) {
          await db.prepare('DELETE FROM registrations WHERE id=?').run(id);
          fail(409, 'Application configuration changed');
        }
        if (result.status !== 200) {
          await db.prepare('DELETE FROM registrations WHERE id=?').run(id);
          fail(502, 'Device challenge could not be delivered');
        }
        return send(202, { registrationId: id, expiresAt });
      } catch (error) {
        if (id) await db.prepare('DELETE FROM registrations WHERE id=? AND delivery_hash IS NULL').run(id);
        throw error;
      } finally {
        release();
      }
    }),
    route(
      'POST',
      '/v1/registrations/:id/confirm',
      { limit: ['confirm-ip', 120, 3600000] },
      async ({ req, body, params, send }) => {
        const appId = body.appId ?? defaultApp;
        const value = await db.transaction(async () => {
          // Application row first, as configuration changes lock it; the registration row keeps concurrent
          // confirmations of one registration from both minting credentials.
          const application =
            typeof appId === 'string'
              ? await db.prepare('SELECT enabled,revision FROM applications WHERE id=? FOR SHARE').get(appId)
              : null;
          const entry = await db
            .prepare('SELECT * FROM registrations WHERE id=? AND expires>? FOR UPDATE')
            .get(params.id, now());
          if (
            !entry ||
            !application?.enabled ||
            application.revision !== entry.app_revision ||
            entry.app_id !== appId ||
            typeof body.challenge !== 'string' ||
            body.nonce !== entry.nonce ||
            !timingSafeEqual(
              Buffer.from(sha256Hex(body.challenge)),
              Buffer.from(entry.challenge_hash || '0'.repeat(64)),
            )
          )
            fail(403, 'Invalid device proof');
          req.gatewayScope = { appId: entry.app_id, channel: entry.channel };
          // A confirmed registration is never re-minted; its grant is returned only within the retry window.
          if (entry.delivery_hash) {
            if (entry.credentials && entry.confirmed_at > now() - confirmReplay)
              return JSON.parse(open(entry.credentials));
            await db.prepare('UPDATE registrations SET credentials=NULL,challenge_hash=NULL WHERE id=?').run(entry.id);
            return null;
          }
          const enabled = await applications.capabilities(entry.app_id, entry.channel);
          if ((entry.kinds ?? ['sync']).some(k => !enabled.includes(k)))
            fail(403, 'Notification capability disabled for application');
          const credentials = {
            registrationId: entry.id,
            appId: entry.app_id,
            purpose: entry.purpose,
            kinds: entry.kinds,
            credential: randomSecret(),
            revokeToken: randomSecret(),
            expiresAt: now() + 30 * 86400000,
          };
          await db.transaction(async () => {
            for (const old of await db
              .prepare('SELECT id FROM registrations WHERE token_hash=? AND id<>?')
              .all(entry.token_hash, entry.id))
              await queue.cancelRegistration(old.id);
            await db.prepare('DELETE FROM registrations WHERE token_hash=? AND id<>?').run(entry.token_hash, entry.id);
            await db
              .prepare(
                'UPDATE registrations SET delivery_hash=?,revoke_hash=?,credentials=?,expires=?,confirmed_at=? WHERE id=?',
              )
              .run(
                sha256Hex(credentials.credential),
                sha256Hex(credentials.revokeToken),
                seal(JSON.stringify(credentials)),
                credentials.expiresAt,
                now(),
                entry.id,
              );
          });
          return credentials;
        });
        if (!value) fail(403, 'Invalid device proof');
        return send(200, value);
      },
    ),
    route('DELETE', '/v1/registrations/:id', { auth: 'device' }, async ({ req, params, send }) => {
      if (!isToken43(bearer(req))) return send(200, { revoked: true });
      await db.transaction(async () => {
        // Waits for a send holding this registration, so the job it queued is cancelled below.
        const owned = await db
          .prepare('SELECT id FROM registrations WHERE id=? AND revoke_hash=? FOR UPDATE')
          .get(params.id, sha256Hex(bearer(req)));
        if (owned) await queue.cancelRegistration(owned.id);
        await db
          .prepare('DELETE FROM registrations WHERE id=? AND revoke_hash=?')
          .run(params.id, sha256Hex(bearer(req)));
      });
      return send(200, { revoked: true });
    }),
    ...['/v1/notify', '/v1/validate', '/v1/jobs'].map(path =>
      route('POST', path, { auth: 'device', limit: ['send-ip', 12000, 3600000] }, async ({ req, body, send }) => {
        const entry = await device(req, body);
        await limit('send-app:' + entry.app_id, 60000);
        await limit('send-device:' + entry.id, 1200);
        if (path === '/v1/validate') return send(200, { valid: true });
        if (path === '/v1/jobs')
          return send(
            202,
            queue.public(
              await queue.enqueue(entry, {
                requestId: body.requestId,
                kind: body.kind,
                notification: body.encryptedNotification,
                alert: body.alert,
              }),
            ),
          );
        const job = await queue.legacy(entry, body.kind, body.encryptedNotification, body.alert);
        if (job.state === 'cancelled') return send(410, { reason: 'registration_invalid', taskId: job.id });
        if (job.state === 'accepted') return send(200, { accepted: true, taskId: job.id });
        if (job.reason === 'GatewayQuota')
          throw Object.assign(Error('Gateway resource limit'), {
            status: 429,
            reason: 'delivery_attempt_quota',
            retryAfter: Math.max(1, Math.ceil((job.next_at - now()) / 1000)),
          });
        if (!(await db.prepare('SELECT 1 FROM registrations WHERE id=?').get(entry.id)))
          return send(410, { reason: 'registration_invalid', taskId: job.id });
        return send(job.status === 429 ? 429 : 503, { reason: 'delivery_failed', taskId: job.id });
      }),
    ),
    route('GET', '/v1/jobs/:id', { auth: 'device' }, async ({ req, params, send }) => {
      if (!isToken43(bearer(req))) fail(410, 'Registration expired or revoked');
      const entry = await db
        .prepare('SELECT * FROM registrations WHERE delivery_hash=? AND expires>?')
        .get(sha256Hex(bearer(req)), now());
      if (!entry || !(await applications.current(entry))) fail(410, 'Registration expired or revoked');
      await access.delivery(req, entry);
      const job = await queue.get(params.id);
      if (!job || job.registration_id !== entry.id) fail(404, 'Task not found');
      return send(200, queue.public(job));
    }),
  ];
}
