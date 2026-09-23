import { connect } from "node:http2";
import { createPrivateKey, sign } from "node:crypto";
// HTTP/2 connections and the provider JWT are reused. No device tokens are logged.
export class APNsProvider {
  constructor(configuration, { connection = connect, now = Date.now } = {}) {
    this.configuration = configuration;
    this.connection = connection;
    this.now = now;
    this.sessions = new Map();
    this.key = createPrivateKey(configuration.key);
    if (
      this.key.asymmetricKeyType !== "ec" ||
      this.key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    )
      throw Error("APNs key must use P-256");
  }
  authorization() {
    const now = Math.floor(this.now() / 1000);
    if (this.jwt && now >= this.issued && now - this.issued < 50 * 60)
      return this.jwt;
    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned =
      encode({ alg: "ES256", kid: this.configuration.keyId }) +
      "." +
      encode({ iss: this.configuration.teamId, iat: now });
    const signature = sign("sha256", Buffer.from(unsigned), {
      key: this.key,
      dsaEncoding: "ieee-p1363",
    });
    this.issued = now;
    return (this.jwt = unsigned + "." + signature.toString("base64url"));
  }
  async send(
    device,
    token,
    payload = {
      aps: { "content-available": 1 },
      perch: { version: 1, deviceId: device.id },
    },
  ) {
    const environment = device.push_environment;
    if (
      !["sandbox", "production"].includes(environment) ||
      !/^[a-f0-9]{32,512}$/i.test(token)
    )
      return { status: 400, reason: "BadDeviceToken" };
    let session = this.sessions.get(environment);
    if (!session || session.closed || session.destroyed) {
      session = this.connection(
        environment === "sandbox"
          ? "https://api.sandbox.push.apple.com"
          : "https://api.push.apple.com",
      );
      this.sessions.set(environment, session);
      const discard = () => {
        if (this.sessions.get(environment) === session)
          this.sessions.delete(environment);
        session.destroy();
      };
      session.on("error", discard);
      session.on("goaway", discard);
    }
    return new Promise((resolve, reject) => {
      let status = 0,
        bytes = "";
      const request = session.request({
        ":method": "POST",
        ":path": "/3/device/" + token,
        authorization: "bearer " + this.authorization(),
        "apns-topic": this.configuration.topic,
        "apns-push-type": "background",
        "apns-priority": "5",
        "apns-collapse-id": payload.perchRegistration
          ? "perch-enroll-" + payload.perchRegistration.id
          : "perch-mail-sync",
        "apns-expiration": String(
          Math.floor(this.now() / 1000) +
            (payload.perchRegistration ? 300 : 3600),
        ),
      });
      const timer = setTimeout(
        () => request.destroy(Error("APNs request timed out")),
        10000,
      );
      request.on("response", (headers) => {
        status = headers[":status"];
      });
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        bytes += chunk;
        if (bytes.length > 4096)
          request.destroy(Error("Invalid APNs response"));
      });
      request.on("error", reject);
      request.on("close", () => {
        clearTimeout(timer);
        reject(Error("APNs stream closed before completion"));
      });
      request.on("end", () => {
        let detail = {};
        try {
          detail = JSON.parse(bytes || "{}");
        } catch {
          /* Status remains authoritative. */
        }
        resolve({ status, reason: detail.reason, timestamp: detail.timestamp });
      });
      request.end(JSON.stringify(payload));
    });
  }
  close() {
    for (const session of this.sessions.values()) session.destroy();
    this.sessions.clear();
  }
}
