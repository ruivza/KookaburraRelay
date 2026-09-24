import { APNsProvider } from "./apns.js";

// Future adapters implement the same send(target, token, message) contract.
// An unimplemented channel is never silently routed through another provider.
export const channelCatalog = [
  {
    id: "apns",
    platform: "ios",
    name: "Apple APNs",
    implemented: true,
    kinds: ["sync", "alert", "encrypted_alert"],
  },
  { id: "fcm", platform: "android", name: "Google FCM", implemented: true, kinds: ["sync", "alert"] },
  ...Object.entries({

    huawei: "华为",
    xiaomi: "小米",
    oppo: "OPPO",
    vivo: "vivo",
    honor: "荣耀",
  }).map(([id, name]) => ({
    id,
    platform: "android",
    name,
    implemented: false,
    kinds: [],
  })),
];

export class APNsChannel {
  constructor(config, factory = (value) => new APNsProvider(value)) {
    this.provider = factory(config);
  }
  send(target, token, message) {
    if (!["challenge", "sync", "alert", "encrypted_alert"].includes(message.kind))
      throw Object.assign(Error("Push message kind not implemented"), {
        status: 501,
      });
    if (["alert", "encrypted_alert"].includes(message.kind)) {
      const encrypted = message.kind === "encrypted_alert";
      const content = encrypted ? message.fallback : message.alert;
      const payload = {
        aps: {alert:{title:content.title,body:content.body},...(encrypted || content.sound ? {sound:"default"} : {}),
          "content-available":1,...(encrypted ? {"mutable-content":1} : {})},
        relay:{version:1,deviceId:target.device_id,appId:target.app_id,serverId:target.server_id,kind:message.kind},
        ...(encrypted && message.encryptedNotification ? {encryptedNotification:message.encryptedNotification} : {})
      };
      if (Buffer.byteLength(JSON.stringify(payload)) > 4096) return Promise.resolve({status:400,reason:'PayloadTooLarge'});
      return this.provider.send({id:target.device_id,push_environment:target.environment},token,payload);
    }
    const payload =
      message.kind === "challenge"
        ? { aps: { "content-available": 1 }, perchRegistration: message.proof }
        : {
            aps: { "content-available": 1 },
            perch: {
              version: 1,
              deviceId: target.device_id,
              appId: target.app_id,
            },
          };
    return this.provider.send(
      { id: target.device_id, push_environment: target.environment },
      token,
      payload,
    );
  }
  close() {
    this.provider.close();
  }
}
