import { defaultApp, validID } from './applications.js';
import { channelCatalog } from './channels.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
export async function deviceAPI({ req, path, body, send, applications, db, queue, now, limit, hash, secret, seal, open, bearer, device, abuse }) {
      if (path === "/v1/registrations" && req.method === "POST") {
        const appId = body.appId ?? defaultApp;
        const channel = body.channel ?? "apns";
        if (!channelCatalog.some(c => c.id === channel && c.platform === (body.platform ?? "ios") && c.implemented))
          fail(501, "Push channel not implemented");
        req.gatewayScope = { appId, channel };
        if (
          !validID(appId) ||
          !validID(body.deviceId) ||
          !validID(body.serverId) ||
          !validID(body.nonce) ||
          body.nonce.length < 32 ||
          typeof body.deviceToken !== "string" ||
          (channel === "apns" ? !/^[a-f0-9]{32,512}$/i.test(body.deviceToken) : !/^[A-Za-z0-9_:.-]{20,4096}$/.test(body.deviceToken)) ||
          !["sandbox", "production"].includes(body.environment)
        )
          fail(400, "Invalid registration");
        const release = abuse.reserveChallenge();
        let id;
        try {
        (await limit("enroll-ip:" + appId + ":" + req.clientAddress, 60));
        const normalizedToken = channel === "apns" ? body.deviceToken.toLowerCase() : body.deviceToken;
        const tokenHash = hash(
          appId +
            ":" +
            channel +
            ":" +
            body.environment +
            ":" +
            normalizedToken,
        );
        (await limit("enroll-token:" + tokenHash, 6));
        const route = await applications.resolve(appId, channel, body.environment);
        id = randomUUID();
        const challenge = secret();
        const expiresAt = now() + 300000;
        await db.transaction(async () => {
        await db.query('SELECT pg_advisory_xact_lock(72841104)');
        (await db.prepare(
          "DELETE FROM registrations WHERE token_hash=? AND delivery_hash IS NULL",
        ).run(tokenHash));
        await abuse.registration(appId);
        (await db.prepare(
          `INSERT INTO registrations(id,device_id,server_id,token,token_hash,environment,nonce,challenge_hash,expires,app_id,channel,app_revision)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          body.deviceId,
          body.serverId,
          seal(normalizedToken),
          tokenHash,
          body.environment,
          body.nonce,
          hash(challenge),
          expiresAt,
          appId,
          channel,
          route.revision,
        ));
        });
        const result = await route.adapter.send(
          {
            device_id: body.deviceId,
            environment: body.environment,
            app_id: appId,
          },
          body.deviceToken,
          {
            kind: "challenge",
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
          !(await applications.current({ app_id: appId, app_revision: route.revision }))
        ) {
          (await db.prepare("DELETE FROM registrations WHERE id=?").run(id));
          fail(409, "Application configuration changed");
        }
        if (result.status !== 200) {
          (await db.prepare("DELETE FROM registrations WHERE id=?").run(id));
          fail(502, "Device challenge could not be delivered");
        }
        return send(202, { registrationId: id, expiresAt });
        } catch (error) {
          if (id) await db.prepare('DELETE FROM registrations WHERE id=? AND delivery_hash IS NULL').run(id);
          throw error;
        } finally { release(); }
      }
      const confirm = path.match(
        /^\/v1\/registrations\/([A-Za-z0-9_-]+)\/confirm$/,
      );
      if (confirm && req.method === "POST") {
        (await limit("confirm-ip:" + req.clientAddress, 120));
        const value = await db.transaction(async()=>{
        await db.query('SELECT pg_advisory_xact_lock(72841104)');
        const entry = (await db
          .prepare("SELECT * FROM registrations WHERE id=? AND expires>?")
          .get(confirm[1], now()));
        if (
          !entry ||
          !(await applications.current(entry)) ||
          entry.app_id !== (body.appId ?? defaultApp) ||
          typeof body.challenge !== "string" ||
          body.nonce !== entry.nonce ||
          !timingSafeEqual(
            Buffer.from(hash(body.challenge)),
            Buffer.from(entry.challenge_hash || "0".repeat(64)),
          )
        )
          fail(403, "Invalid device proof");
        req.gatewayScope = { appId: entry.app_id, channel: entry.channel };
        if (entry.credentials)
          return JSON.parse(open(entry.credentials));
        const credentials = {
          registrationId: entry.id,
          appId: entry.app_id,
          credential: secret(),
          revokeToken: secret(),
          expiresAt: now() + 30 * 86400000,
        };
        await db.transaction(async () => {
          for (const old of (await db.prepare('SELECT id FROM registrations WHERE token_hash=? AND id<>?').all(entry.token_hash, entry.id))) (await queue.cancelRegistration(old.id));
          (await db.prepare(
            "DELETE FROM registrations WHERE token_hash=? AND id<>?",
          ).run(entry.token_hash, entry.id));
          (await db.prepare(
            "UPDATE registrations SET delivery_hash=?,revoke_hash=?,credentials=?,expires=? WHERE id=?",
          ).run(
            hash(credentials.credential),
            hash(credentials.revokeToken),
            seal(JSON.stringify(credentials)),
            credentials.expiresAt,
            entry.id,
          ));
        });
        return credentials;
        });
        return send(200,value);
      }
      const revoke = path.match(/^\/v1\/registrations\/([A-Za-z0-9_-]+)$/);
      if (revoke && req.method === "DELETE") {
        if (!/^[A-Za-z0-9_-]{43}$/.test(bearer(req))) return send(200, { revoked: true });
        await db.transaction(async () => {
        await db.query('SELECT pg_advisory_xact_lock(72841103)');
        const owned = (await db.prepare('SELECT id FROM registrations WHERE id=? AND revoke_hash=?').get(revoke[1], hash(bearer(req))));
        if (owned) (await queue.cancelRegistration(owned.id));
        (await db.prepare(
          "DELETE FROM registrations WHERE id=? AND revoke_hash=?",
        ).run(revoke[1], hash(bearer(req))));
        });
        return send(200, { revoked: true });
      }
      if (
        ["/v1/notify", "/v1/validate", "/v1/jobs"].includes(path) &&
        req.method === "POST"
      ) {
        (await limit("send-ip:" + req.clientAddress, 12000));
        const entry = (await device(req, body));
        await limit('send-app:' + entry.app_id, 60000);
        await limit('send-device:' + entry.id, 1200);
        if (path === "/v1/validate") return send(200, { valid: true });
        if (path === '/v1/jobs') return send(202, queue.public((await queue.enqueue(entry, { requestId: body.requestId }))));
        const job = await queue.legacy(entry);
        if (job.state === 'cancelled') return send(410, { reason: 'registration_invalid', taskId: job.id });
        if (job.state === 'accepted') return send(200, { accepted: true, taskId: job.id });
        if (job.reason === 'GatewayQuota') throw Object.assign(Error('Gateway resource limit'), {
          status: 429, reason: 'delivery_attempt_quota', retryAfter: Math.max(1, Math.ceil((job.next_at - now()) / 1000)),
        });
        if (!(await db.prepare('SELECT 1 FROM registrations WHERE id=?').get(entry.id))) return send(410, { reason: 'registration_invalid', taskId: job.id });
        return send(job.status === 429 ? 429 : 503, { reason: 'delivery_failed', taskId: job.id });
      }
      const task = path.match(/^\/v1\/jobs\/([A-Za-z0-9_-]+)$/);
      if (task && req.method === 'GET') {
        if (!/^[A-Za-z0-9_-]{43}$/.test(bearer(req))) fail(410, 'Registration expired or revoked');
        const entry = (await db.prepare('SELECT * FROM registrations WHERE delivery_hash=? AND expires>?').get(hash(bearer(req)), now()));
        if (!entry || !(await applications.current(entry))) fail(410, 'Registration expired or revoked');
        const job = (await queue.get(task[1]));
        if (!job || job.registration_id !== entry.id) fail(404, 'Task not found');
        return send(200, queue.public(job));
      }
      return send(404, { error: 'Not found' });
}
