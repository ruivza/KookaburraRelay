import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "./helpers.mjs";

test("device proof, scoped credentials, ownership transfer and revocation", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "perch-gateway-"));
  const sent = [];
  const app = (await createGateway({
    dataDir,
    adminToken: "admin".repeat(10),
    providerFactory: () => ({
      async send(device, token, payload) {
        sent.push({ device, token, payload });
        return { status: 200 };
      },
      close() {},
    }),
  }));
  (await app.applications.update("perch-mail", {
    name: "Perch Mail",
    enabled: true,
    apns: {
      keyId: "ABCDEFGHIJ",
      teamId: "0123456789",
      topic: "com.perchmail.app",
      environment: "both",
      privateKey: "fixture",
    },
  }));
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function call(path, body, token, method = body ? "POST" : "GET") {
    const response = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + (token || ""),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  }
  const enrollment = {
    deviceId: "phone",
    serverId: "server",
    deviceToken: "ab".repeat(32),
    environment: "sandbox",
    nonce: "n".repeat(40),
  };
  const scope = { deviceId: "phone", serverId: "server", kind: "sync" };
  try {
    assert.equal((await call("/admin/apps")).status, 401);
    assert.equal((await call("/v1/status")).body.protocol, 1);
    const pending = await call("/v1/registrations", enrollment);
    assert.equal(pending.status, 202);
    assert.equal(pending.body.challenge, undefined);
    assert.equal(pending.body.credential, undefined);
    const proof = sent.at(-1).payload.perchRegistration;
    assert.equal(
      (
        await call(`/v1/registrations/${pending.body.registrationId}/confirm`, {
          nonce: enrollment.nonce,
          challenge: "guessed",
        })
      ).status,
      403,
    );
    const confirmed = await call(
      `/v1/registrations/${proof.id}/confirm`,
      proof,
    );
    assert.equal(confirmed.status, 200);
    const grant = confirmed.body;
    assert.equal(
      (await call("/v1/validate", scope, grant.credential)).status,
      200,
    );
    assert.equal(
      (
        await call(
          "/v1/notify",
          { ...scope, deviceId: "other" },
          grant.credential,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/v1/notify",
          { ...scope, subject: "must not forward" },
          grant.credential,
        )
      ).status,
      200,
    );
    assert.deepEqual(sent.at(-1).payload, {
      aps: { "content-available": 1 },
      perch: { version: 1, deviceId: "phone", appId: "perch-mail" },
    });
    assert.equal(
      (await call("/v1/notify", scope, grant.credential)).status,
      429,
    );
    const stored = (await app.db
      .prepare("SELECT * FROM registrations WHERE id=?")
      .get(proof.id));
    assert.ok(!stored.credentials.includes(grant.credential));
    assert.ok(!stored.token.includes(enrollment.deviceToken));
    // Knowing a token alone does not invalidate the currently proven owner.
    await call("/v1/registrations", { ...enrollment, deviceId: "replacement" });
    assert.equal(
      (await call("/v1/validate", scope, grant.credential)).status,
      200,
    );
    const nextProof = sent.at(-1).payload.perchRegistration;
    const next = (
      await call(`/v1/registrations/${nextProof.id}/confirm`, nextProof)
    ).body;
    assert.equal(
      (await call("/v1/validate", scope, grant.credential)).status,
      410,
    );
    assert.equal(
      (
        await call(
          "/v1/validate",
          { ...scope, deviceId: "replacement" },
          next.credential,
        )
      ).status,
      200,
    );
    await call(
      `/v1/registrations/${next.registrationId}`,
      undefined,
      next.revokeToken,
      "DELETE",
    );
    assert.equal(
      (
        await call(
          "/v1/validate",
          { ...scope, deviceId: "replacement" },
          next.credential,
        )
      ).status,
      410,
    );
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("configuration encrypts the Apple key and never returns it", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const dir = mkdtempSync(join(tmpdir(), "perch-gateway-config-"));
  const app = (await createGateway({ dataDir: dir, adminToken: "operator".repeat(8) }));
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${app.server.address().port}/admin/apps/perch-mail`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + (await app.security.login({token:"operator".repeat(8)})).session,
  };
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const key = privateKey.export({ type: "pkcs8", format: "pem" });
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: "Perch Mail",
        enabled: true,
        apns: {
          privateKey: key,
          environment: "both",
          keyId: "ABCDEFGHIJ",
          teamId: "0123456789",
          topic: "com.perchmail.app",
        },
      }),
    });
    assert.equal(response.status, 200);
    const stored = (await app.db
      .prepare("SELECT secret FROM applications WHERE id='perch-mail'")
      .get()).secret;
    assert.ok(!stored.includes("PRIVATE KEY"));
    const config = (
      await (await fetch(url.replace("/perch-mail", ""), { headers })).json()
    ).applications[0];
    assert.equal(config.ready, true);
    assert.equal(config.apns.hasKey, true);
    assert.equal(config.privateKey, undefined);
    assert.equal(config.key, undefined);
    assert.ok(!JSON.stringify(config).includes(key));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
