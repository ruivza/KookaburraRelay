# Access policies

New applications do not require App Attest, Play Integrity, or approved servers. Webhook alerts are disabled by default. Verify integration support before enabling a policy. Saving an access policy revokes the application's registrations, pending jobs, integrity challenges, and stored attestation keys.

## Server approval

1. As administrator, call `POST /admin/servers {id,name,apps:[appId]}`.
2. Call `POST /admin/servers/:id {action:"approve"}`. Save the returned server credential; it is shown only once. `rotate` replaces it and `block` disables the server.
3. The business server uses its credential as Bearer authorization for `POST /v1/server-tickets {appId,serverId,deviceId}`.
4. Give the resulting `{ticket,expiresAt}` to the authenticated client for its own device. The client includes `serverTicket` in registration.
5. For validation, sending, and job queries, the server uses the device delivery Bearer credential plus `X-Relay-Server-Credential`.

Tickets expire after five minutes and are single-use, bound to application, server, device, and credential revision. Only credential and ticket hashes are stored. Device confirmation and revocation do not need the long-lived server credential; never give it to a client.

Enable **Require approved servers** after testing the complete flow. Without this policy, legacy self-reported server IDs remain allowed; blocking one ID cannot prevent an untrusted caller from choosing another. Rotation or blocking revokes that server's tickets, registrations, and pending work. Already submitted pushes cannot be recalled.

The directory holds up to 1,000 servers and 2,000 active tickets. Default ticket quotas are 20,000/day globally and 5,000/day per server.

## Platform proof protocol

1. Prepare the complete registration, including capabilities and any server ticket. Obtain proof without changing these fields afterward.
2. Call `POST /v1/integrity/challenges {registration,keyId?}`. A disabled policy returns `{required:false}`. Otherwise the response contains `id`, `payload`, `expiresAt`, `keyKnown`, `requestHash`, and `cloudProjectNumber`.
3. For Apple, use `SHA256(UTF8(payload))` as `clientDataHash`; attest a new key or assert an existing key according to `keyKnown`.
4. For Android, request a Standard Integrity token using the returned `requestHash` and configured Cloud project number.
5. Include proof in the registration, then complete the separate APNs / FCM reception challenge.

Apple proof is `integrity:{challengeId,keyId,attestation:<canonical Base64>}` or `integrity:{challengeId,keyId,assertion:<canonical Base64>}`. Android proof is `integrity:{challengeId,integrityToken}`.

Integrity challenges expire after five minutes and bind the normalized registration, nonce, token, kinds, and server ticket. A matched challenge is consumed even when verification fails. Retry with a new challenge and, if consumed, a new ticket. Required proof is never bypassed on platform failure.

Limits: 2,000 active integrity challenges; challenge requests 20/source/minute and 300/global/minute; four concurrent verifications, 20/source/minute, 120/global/minute, 10,000/global/day, and 5,000/application/day. Failed verifications count. Temporary rejection includes `Retry-After`.

## App Attest

Set the application's Team ID, Bundle ID, and strict `development` or `production` App Attest environment to match the signed client. The App Attest environment is independent of APNs. TestFlight / App Store builds use [production App Attest](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.devicecheck.appattest-environment). Use `DCAppAttestService` on a supported real device; simulators do not establish attestation support.

The gateway checks Apple's certificate chain, validity, App ID, environment, key ID, challenge binding, and signature. Assertions use a transactionally increasing counter to reject replay. Public keys expire after 90 days, extended on successful verification, with a 100,000-key global limit.

Reference: [Apple validation guide](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server).

## Play Integrity

Configure the package name, Cloud project **number**, allowed signing-certificate SHA-256 digests as unpadded Base64URL, and a service account authorized to decode tokens. Its private key is encrypted and not returned by management APIs. The repository does not include an Android client.

Use the Standard Integrity API, prepare its token provider for the Cloud project, and request a token with the challenge's `requestHash` (`SHA256(payload)` in Base64URL). The gateway uses fixed Google endpoints and requires matching package/hash/signature, a recent timestamp, `PLAY_RECOGNIZED`, `MEETS_DEVICE_INTEGRITY`, and `LICENSED`. This policy excludes unlicensed, modified, or incompatible installations.

References: [Standard Integrity](https://developer.android.com/google/play/integrity/standard), [verdict fields](https://developer.android.com/google/play/integrity/verdicts).

## Resource quotas

`GET/PUT /admin/abuse` manages global settings. `GET/PUT /admin/apps/:id/quotas` manages overrides for `registrationEnabled`, `registrationAppMinute`, `challengeAppDay`, `pendingApp`, `taskAppDay`, `taskDeviceDay`, and `attemptAppDay`. PUT `{}` clears overrides. Global limits and concurrent admission remain effective.

Daily quotas are stored in PostgreSQL and reset at UTC midnight; restarts, re-registration, and configuration changes do not reset use. Device quotas bind application, channel, environment, and token hash. Duplicate job requests do not consume another new-job quota; retry attempts still consume attempt quota.

Defaults include 300/global and 120/application registrations per minute; 10,000/global and 5,000/application reception challenges per day; 2,000/global and 1,000/application pending registrations; and four concurrent reception challenges. New jobs: 100,000/global, 50,000/application, 240/device per day. Delivery attempts: 150,000/global, 75,000/application per day.

Requests also have process-level admission limits before database work: 6,000/global and 600/source per minute, and 64 active handlers. These in-memory limits reset on restart. Resource rejection returns 429 or 503 with a stable `reason` and `Retry-After`; use exponential backoff and jitter.

## Webhook alerts

The console or `GET/PUT /admin/alerts` configures optional alerts. The gateway checks resource rejections, queue depth, oldest waiting time, and failed/unknown jobs each minute. Default thresholds are 100 rejections and 10 failures over five minutes, depth 1,000, oldest wait 300 seconds, and repeat cooldown 900 seconds.

The destination must use public HTTPS on port 443. All DNS answers must be public; the connection uses a verified address and does not follow redirects. The URL and optional signing secret are encrypted; management responses expose only configuration status and hostname.

Events use this JSON shape:

```json
{"id":"<event UUID>","kind":"queue_depth","state":"firing","value":1001,"time":1780000000000,"text":"Kookaburra Relay: queue_depth firing (1001)"}
```

Recovery uses `state:"resolved"`. `X-Relay-Event-ID` matches `id`. When signing is configured, `X-Relay-Signature` is `sha256=<hex HMAC-SHA256 of the raw HTTP body>`. Verify signatures and deduplicate event IDs at the receiver; return 2xx for success. Generic chat webhooks may need an adapter.

Delivery is at least once: timeouts may already have reached the receiver. Failed sends retry up to six total attempts with increasing delays. Pending events survive restart; changing or disabling settings cancels old pending events. The queue holds at most 1,000 events; completed history expires after seven days. A stopped gateway cannot send an outage alert; use independent uptime monitoring.
