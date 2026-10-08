# Real-device validation

Automated tests use simulated providers and temporary databases. They do not establish real APNs / FCM delivery, App Attest / Play Integrity success, or cloud backup recovery.

Use a dedicated test application and devices. Prepare a valid HTTPS gateway address reachable from both devices and the business server, configured vendor credentials, and a client implementing the [registration protocol](NOTIFICATION_PROTOCOL.md). Record the gateway revision, device OS, application build, environment, timestamps, and observed results without recording secrets.

## APNs

1. Configure Team ID, Key ID, Bundle ID, and a `.p8` key authorized for the intended APNs environment. Match the client build's topic and environment.
2. Grant the application its required notification kinds. Start with platform proof and server approval disabled in the test application.
3. Install the signed client on a real device, allow notifications when needed, and keep it online and foregrounded for initial registration.
4. Confirm that the client receives the registration challenge and the console shows a verified registration. Allow for delayed background delivery; follow cooldowns instead of repeatedly registering.
5. Trigger a test push and a business event. Check foreground sync, background behavior, and lock-screen alerts as applicable. `accepted` alone is insufficient evidence.
6. For encrypted alerts, validate successful extension decryption and fallback behavior when decryption fails or the extension does not run.

## App Attest

Use a capable real device, matching Team ID and Bundle ID, and the correct App Attest entitlement and policy environment. App Attest and APNs environments are independent; distribution builds such as TestFlight use [production App Attest](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.devicecheck.appattest-environment).

Enable proof for the test application; policy changes revoke registrations and stored attestation keys. Verify first attestation, then revoke only the device registration and verify the assertion path without resaving the policy. Check rejection of missing proof, altered registration parameters, replayed challenges, and reused counters. Confirm that temporary Apple or network failures do not bypass proof.

## FCM and Play Integrity

Configure FCM HTTP v1 credentials and an Android client using the protocol. Verify token case preservation, challenge confirmation, sync data parsing, and ordinary alerts on real devices. Encrypted alerts over FCM are not implemented.

For required Play Integrity, use a Play-distributed application with the configured package, signing certificate, Cloud project number, and entitlement. Verify recognized, licensed device verdicts and rejection of mismatched request hashes, packages, or signatures. Synthetic verdict tests do not establish platform acceptance.

## Server approval and failure cases

Approve the business server's actual ID for the test application and store its credential only on that server. Verify ticket retrieval, one-time registration consumption, and delivery with both device and server credentials before requiring approval. Check that rotation or blocking invalidates registrations and pending work; use a test server only.

Test expired credentials, revoked devices, app disablement, channel changes, 429/503 cooldowns, temporary provider failure, and interrupted sends. Confirm that `unknown` work is not replayed automatically. Review console records and provider/client logs using timestamps and request IDs, with tokens and notification contents removed.
