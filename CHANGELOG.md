# Changelog

## 0.2.0 — 2026-11-03

- Count hourly rate limits in memory instead of the `limits` table. They reset on restart; daily quotas stay in PostgreSQL. At most 20,000 enrollment and confirmation keys are tracked; beyond that new enrollments get 503 `limit_capacity`, and other keys never fail on capacity.
- Cache application, channel, notification, access-policy, trusted-server and quota settings in memory, refreshed on every change made through the console or admin API. After editing those tables directly in PostgreSQL, restart the gateway.
- Lock the rows a send, registration, confirmation or revocation depends on instead of taking global locks, so requests for different devices run concurrently. The 10,000-job queue cap is now approximate under concurrency.
- Cut database round trips from 39 to 8 per send and from 25 to 6 per delivery; a test pins at most 12 and 6.
- Run 32 delivery workers by default (`GATEWAY_DELIVERY_WORKERS`), with 4 separate slots for synchronous legacy sends, and 20 pool connections (`GATEWAY_DATABASE_POOL_SIZE`). The ownership lock and cleanup use their own connections.
- Serve console files from memory with an ETag; scripts and styles now send `Cache-Control: no-cache`.
- Apply numbered migrations from `src/migrations/` instead of rerunning the whole schema on every start.
- Store channel key IDs, team IDs, topics, environments, project IDs and client emails in plain columns and encrypt only the private key. Rows from earlier versions are converted on the first start.
- Route requests through a declared route table; audit entries record the response status and duration, and logs record route patterns.
- Run periodic jobs from one scheduler; `/metrics` reports failures and last success per job. Retention cleanup of expired registrations now cancels their queued work.
- Treat nested transactions as savepoints and scope every advisory lock to the gateway's schema.
- Escape values interpolated into console markup by default.
- Format with Prettier and lint with ESLint in CI.

## 0.1.3 — 2026-11-03

- Check each source's request budget before the global one, so one flooding address no longer rate-limits every other client.
- Group IPv6 clients by /64 for per-address rate limits and request admission; clients sharing a /64 now share a budget.
- Reject registrations for unknown applications before creating rate-limit rows, and apply the limit-table capacity check only to unauthenticated enrollment keys, so admin, sender and probe limits no longer fail with 503 when junk registrations fill the table.
- Return the same credentials for a repeated registration confirm only within 10 minutes; later repeats get 403 and the stored copy is erased. Issued credentials keep working.
- Allow at most four concurrent admin token verifications; excess attempts get 503 with `Retry-After` and reason `login_concurrency`.
- Use `admin.token` only to bootstrap the first admin token, replace it with a non-secret note after rotation, and warn at startup when `GATEWAY_ADMIN_TOKEN` differs from the stored token.
- Stop duplicating the encrypted APNs key into `applications.secret` and clear existing copies at startup.
- Log unexpected 500 errors as one line with request ID, method, route and error code.
- Index `registrations(token_hash)` and `registrations(server_id)`.
- Run the gateway and backup worker as the non-superuser role `relay_app` on new installations; existing installations keep the superuser until `ops/create-app-role.sh` migrates them.
- Encrypt local backups as `relay-*.tar.age` when an age public key is configured and upload that file instead of a second copy; verify them with `ops/verify-backup.sh -i`.
- Back up installations whose admin token came from `GATEWAY_ADMIN_TOKEN`, which previously failed on the missing `admin.token`.
- Refuse custom S3 endpoints that resolve to private, loopback or link-local addresses (`StorageEndpointNotPublic`).
- Set memory and process limits for the Compose services and remove the unused `ops/backup-loop.sh`.
- Share JWT signing and Google OAuth token caching between APNs, FCM and Play Integrity.
- Add `npm run test:docker` and `npm run bench`, with a recorded baseline in `docs/PERFORMANCE.md`.
- Keep shell scripts LF in Windows checkouts through `.gitattributes`.

## 0.1.2 — 2026-10-09

- Move backend code and schema to `src/`, console files and assets to `public/`, and CLI tools to `scripts/`.
- Consolidate detailed guides under `docs/` and update links and commands.
- Preserve root `.env` and `data/`, existing Docker volumes, `npm start`, `install.sh`, and public HTTP URLs.

## 0.1.1 — 2026-10-09

- Prepare the standalone gateway for public distribution under MIT.
- Replace deployment-specific notes with concise English setup, protocol, operations, contribution, and security documentation.
- Correct documented notification support, application quota overrides, application integrity checks, and webhook alerts.
- Clear notification content on cancellation and interrupted delivery; remove content retained by earlier terminal jobs.
- Require correctly typed integrity verdicts and encrypted notification identifiers.
- Cache Google OAuth tokens safely and reduce public status queries from seven to three without decrypting vendor credentials.
- Index probe timestamps for history queries and retention.
- Test, scan, and package source archives and amd64/arm64 images through GitHub Actions with pinned actions, SBOM, and provenance.
- Harden console routes, set the Docker data directory to mode 0700, and provide public Docker installation archives with checksums.
