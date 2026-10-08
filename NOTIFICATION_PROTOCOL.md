# Notification protocol

The gateway authorizes applications and devices, routes notifications, limits resources, and adapts APNs / FCM. Business content, key exchange, and client decryption belong to the integrating application.

## Capabilities

| Kind | APNs | FCM |
| --- | --- | --- |
| `sync` | Supported | Supported |
| `alert` | Supported | Supported |
| `encrypted_alert` | Supported | Registration rejected with 501 |

Configure an application's allowed `notifications.kinds` in the console. New applications and legacy grants default to `sync`. Both the grant and the current application configuration must allow each requested kind. Enabling a kind does not upgrade existing credentials. Disabling it cancels its unfinished jobs and pending registrations; confirmed grants remain but cannot use a disabled kind.

```json
{"kinds":["sync","alert","encrypted_alert"],"fallback":{"title":"Notes","body":"You have an update"}}
```

Encrypted fallback alerts always request the system sound; users retain OS-level sound controls. Legacy `fallback.sound:false` is normalized to true. Ordinary alerts retain per-message sound control. Renaming or changing fallback text preserves registrations; application/channel disablement or credential changes revoke them.

## Device registration

Read application readiness and capabilities with `GET /v1/status?appId=notes`; read proof requirements with `GET /v1/access?appId=notes`.

Send `POST /v1/registrations`:

```json
{"appId":"notes","platform":"ios","channel":"apns","deviceId":"device-1","serverId":"server-1","deviceToken":"<APNs token>","environment":"sandbox","nonce":"<at least 32 characters>","kinds":["sync","alert"]}
```

Identifiers use letters, digits, underscores, and hyphens, up to 100 characters. APNs tokens are hexadecimal and normalized to lowercase. FCM uses `platform:"android"`, `channel:"fcm"`, `environment:"production"`; token case is preserved. Instead of `kinds`, `purpose:"alert"` or `purpose:"encrypted_alert"` requests that kind plus `sync`; do not send both fields. Omission requests only `sync`.

When required, add a `serverTicket` and platform `integrity` proof as described in [access policies](ACCESS_SECURITY.md).

HTTP 202 returns a registration ID and expiry, never the reception challenge or credentials. APNs delivers a `perchRegistration` object; FCM delivers the same object as a JSON string in `data.perchRegistration`. The client submits the received proof to `POST /v1/registrations/:id/confirm`. Verify its application, device, server, and nonce before confirming.

Confirmation returns `registrationId`, `appId`, authorized `kinds`, `credential`, `revokeToken`, and `expiresAt`. Give only the delivery credential to the business server; keep the revoke token on the client. Credentials expire after 30 days. Revoke with `DELETE /v1/registrations/:id` using the revoke token as Bearer authorization.

## Sending

Use `Authorization: Bearer <device delivery credential>` and matching `appId`, `deviceId`, `serverId`, and `kind`. Approved-server integrations also send `X-Relay-Server-Credential`. `POST /v1/validate` checks the grant for that scope.

```json
{"appId":"notes","deviceId":"device-1","serverId":"server-1","kind":"alert","alert":{"title":"Reminder","body":"Your meeting starts soon","sound":false}}
```

Use `/v1/notify` for synchronous provider acceptance or `/v1/jobs` for asynchronous delivery. Jobs additionally require a stable `requestId` of 16–100 letters, digits, underscores, or hyphens. HTTP 202 means queued, while HTTP 200 from `/v1/notify` means accepted by the provider. Neither proves delivery. Query `GET /v1/jobs/:id` with the same credentials; job responses omit content. See [queue semantics](docs/OPERATIONS.md#delivery-queue).

Ordinary `alert` requires string title and body, limited to 120 and 400 Unicode code points. They cannot both be blank or contain control characters. `sound` is boolean and defaults to true. The gateway and provider can read ordinary alerts; queued content is encrypted at rest, not end-to-end encrypted.

`sync` cannot carry ordinary or encrypted alert content. One `requestId` with changed content returns 409. Terminal or cancelled jobs clear stored content; retries retain protected content. The final APNs payload cannot exceed 4096 bytes. Honor 429/503 and `Retry-After`; temporary rate limits do not imply permanent credential revocation.

## Encrypted alerts

Send `kind:"encrypted_alert"` with an optional `encryptedNotification` object:

| Field | Validation |
| --- | --- |
| `version` | `1` |
| `keyId` | 64 lowercase hexadecimal characters |
| `id` | 36-character lowercase hexadecimal/hyphen identifier |
| `expires` | Future Unix milliseconds, at most 24 hours ahead |
| `ephemeralKey` | Canonical Base64, 65-byte uncompressed public-key encoding starting with `0x04` |
| `ciphertext` | Canonical Base64, 28–2400 bytes: nonce + ciphertext + tag |

The advertised profile is `p256-hkdf-sha256-aes256gcm-v1`. The sender and client must agree on key identifiers, HKDF parameters, AAD, and plaintext structure. The gateway validates the envelope shape and does not decrypt or validate business content. Omitting the envelope sends only the configured fallback.

APNs uses `mutable-content:1`; the client's Notification Service Extension decrypts and replaces the fallback. Failed decryption or an extension that does not run leaves the fallback visible. Ordinary alerts do not invoke this decryption flow. FCM encrypted alerts require a future adapter and Android decryption integration.

## Provider payloads

Visible APNs alerts carry `relay:{version:1,appId,deviceId,serverId,kind}`; encrypted alerts additionally carry `encryptedNotification`. FCM ordinary alerts put `relay` in `data` as a JSON string. Clients must validate their scope.

Legacy field names remain for compatibility: sync uses `perch`, and reception proof uses `perchRegistration`. FCM encodes both as JSON strings. FCM sync uses normal priority, ordinary alerts use high priority; background delivery may be delayed by the OS.
