import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { generateKeyPairSync, verify } from "node:crypto";
import { APNsProvider } from "../apns.js";
test("APNs uses ES256, cached JWT and private background HTTP/2 payload", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  let now = 1700000000000,
    connections = 0;
  const requests = [];
  const provider = new APNsProvider(
    {
      key: privateKey.export({ format: "pem", type: "pkcs8" }),
      keyId: "ABCDEFGHIJ",
      teamId: "0123456789",
      topic: "com.perchmail.app",
    },
    {
      now: () => now,
      connection: (url) => {
        connections++;
        assert.equal(url, "https://api.sandbox.push.apple.com");
        const session = new EventEmitter();
        session.destroy = () => {
          session.destroyed = true;
        };
        session.request = (headers) => {
          const request = new EventEmitter();
          request.setEncoding = () => {};
          request.destroy = (error) => {
            request.emit("error", error);
            request.emit("close");
          };
          request.end = (payload) => {
            requests.push({ headers, payload: JSON.parse(payload) });
            queueMicrotask(() => {
              request.emit("response", { ":status": 200 });
              request.emit("end");
              request.emit("close");
            });
          };
          return request;
        };
        return session;
      },
    },
  );
  try {
    const device = { id: "device", push_environment: "sandbox" };
    await provider.send(device, "ab".repeat(32));
    now += 10 * 60000;
    await provider.send(device, "ab".repeat(32));
    assert.equal(connections, 1);
    const first = requests[0];
    assert.equal(first.headers["apns-push-type"], "background");
    assert.equal(first.headers["apns-priority"], "5");
    assert.equal(first.headers["apns-topic"], "com.perchmail.app");
    assert.deepEqual(first.payload, {
      aps: { "content-available": 1 },
      perch: { version: 1, deviceId: "device" },
    });
    assert.equal(
      first.headers.authorization,
      requests[1].headers.authorization,
    );
    const parts = first.headers.authorization.slice(7).split(".");
    assert.equal(Buffer.from(parts[2], "base64url").length, 64);
    assert.equal(
      verify(
        "sha256",
        Buffer.from(parts.slice(0, 2).join(".")),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(parts[2], "base64url"),
      ),
      true,
    );
    now += 50 * 60000;
    assert.notEqual(provider.authorization(), parts.join("."));
  } finally {
    provider.close();
  }
});
