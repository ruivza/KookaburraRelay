import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "./helpers.mjs";

const apns = (topic) => ({
  keyId: "ABCDEFGHIJ",
  teamId: "0123456789",
  topic,
  environment: "both",
  privateKey: "fixture-key",
});
const admin = "local-test-operator".repeat(3);
const scope = (appId) => ({
  appId,
  deviceId: "phone",
  serverId: "server",
  kind: "sync",
});

test("applications isolate routing, ownership, credentials, changes and persisted configuration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-apps-")),
    sent = [];
  const options = {
    dataDir: dir,
    adminToken: admin,
    providerFactory: (config) => ({
      async send(device, token, payload) {
        sent.push({ topic: config.topic, device, token, payload });
        return { status: 200 };
      },
      close() {},
    }),
  };
  let app, base;
  async function start() {
    app = (await createGateway(options));
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function call(
    path,
    body,
    token = admin,
    method = body ? "POST" : "GET",
  ) {
    if(path.startsWith('/admin/') && token===admin) token=(await (await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:admin})})).json()).session;
    const res = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  }
  async function enroll(appId) {
    const result = await call(
      "/v1/registrations",
      {
        appId,
        deviceId: "phone",
        serverId: "server",
        deviceToken: "ab".repeat(32),
        environment: "sandbox",
        platform: "ios",
        channel: "apns",
        nonce: "n".repeat(40),
      },
      "",
    );
    assert.equal(result.status, 202);
    const proof = sent.at(-1).payload.perchRegistration;
    const grant = await call(
      `/v1/registrations/${proof.id}/confirm`,
      proof,
      "",
    );
    assert.equal(grant.status, 200);
    return grant.body;
  }
  await start();
  try {
    assert.equal(
      (await call("/admin/apps", { id: "notes", name: "Notes" })).status,
      201,
    );
    for (const [id, name, topic] of [
      ["perch-mail", "Mail", "com.example.mail"],
      ["notes", "Notes", "com.example.notes"],
    ]) {
      assert.equal(
        (
          await call(
            "/admin/apps/" + id,
            { name, enabled: true, apns: apns(topic) },
            admin,
            "PUT",
          )
        ).status,
        200,
      );
    }
    const mail = await enroll("perch-mail"),
      notes = await enroll("notes");
    assert.equal(
      (await app.db
        .prepare(
          "SELECT count(*) n FROM registrations WHERE delivery_hash IS NOT NULL",
        )
        .get()).n,
      2,
    );
    assert.equal(
      (await call("/v1/notify", scope("notes"), mail.credential)).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/v1/notify",
          { ...scope("notes"), kind: "alert" },
          notes.credential,
        )
      ).status,
      403,
    );
    assert.equal(
      (await call("/v1/notify", scope("notes"), notes.credential)).status,
      200,
    );
    assert.equal(sent.at(-1).topic, "com.example.notes");
    assert.equal(sent.at(-1).payload.perch.appId, "notes");
    assert.equal(
      (await call("/v1/notify", scope("perch-mail"), mail.credential)).status,
      200,
    );
    assert.equal(sent.at(-1).topic, "com.example.mail");
    // Neither a rename nor a duplicate topic error may clear an unrelated application's grant.
    assert.equal(
      (
        await call(
          "/admin/apps/notes",
          { name: "My Notes", enabled: true },
          admin,
          "PUT",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          "/admin/apps/notes",
          { name: "Notes", enabled: true, apns: apns("com.example.mail") },
          admin,
          "PUT",
        )
      ).status,
      409,
    );
    assert.equal(
      (await call("/v1/validate", scope("notes"), notes.credential)).status,
      200,
    );
    assert.equal(
      (
        await call(
          "/v1/registrations",
          { appId: "notes", platform: "android", channel: "fcm" },
          "",
        )
      ).status,
      503,
    );
    const catalog = (await call("/admin/apps")).body;
    assert.equal(
      catalog.channels.find((value) => value.id === "fcm").implemented,
      true,
    );
    assert.ok(!JSON.stringify(catalog).includes("fixture-key"));
    await call(
      "/admin/apps/perch-mail",
      { name: "Mail", enabled: false },
      admin,
      "PUT",
    );
    assert.equal(
      (await call("/v1/validate", scope("perch-mail"), mail.credential)).status,
      410,
    );
    assert.equal(
      (await call("/v1/validate", scope("notes"), notes.credential)).status,
      200,
    );
    await app.close();
    await start();
    assert.equal(
      (await call("/v1/validate", scope("notes"), notes.credential)).status,
      200,
    );
    assert.equal((await call("/v1/status?appId=notes")).body.ready, true);
    assert.equal((await call("/v1/status")).body.ready, false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configuration changes during a challenge cannot activate an obsolete grant", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-app-race-"));
  let release, proof, started;
  const pending = new Promise((resolve) => {
    started = resolve;
  });
  const app = (await createGateway({
    dataDir: dir,
    adminToken: admin,
    providerFactory: () => ({
      send(_device, _token, payload) {
        proof = payload.perchRegistration;
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      close() {},
    }),
  }));
  (await app.applications.update("perch-mail", {
    name: "Mail",
    enabled: true,
    apns: apns("com.example.mail"),
  }));
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const enrolling = post("/v1/registrations", {
      deviceId: "phone",
      serverId: "server",
      deviceToken: "ab".repeat(32),
      environment: "sandbox",
      nonce: "n".repeat(40),
    });
    await pending;
    (await app.applications.update("perch-mail", { name: "Mail", enabled: false }));
    release({ status: 200 });
    assert.equal((await enrolling).status, 409);
    assert.equal(
      (await post(`/v1/registrations/${proof.id}/confirm`, proof)).status,
      403,
    );
    assert.equal(
      (await app.db.prepare("SELECT count(*) n FROM registrations").get()).n,
      0,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
