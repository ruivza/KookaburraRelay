# Contributing

Use focused pull requests with a clear problem, resulting behavior, and relevant validation. Discuss protocol changes before implementing incompatible behavior. Report vulnerabilities through [SECURITY.md](SECURITY.md).

## Development

Requires Node.js 24+, PostgreSQL, and `age` for backup encryption tests. Install dependencies with `npm ci`. Use a dedicated test database, never production: tests create and delete temporary schemas.

```sh
npm run check
GATEWAY_DATABASE_URL='postgresql://relay_test:replace-me@127.0.0.1:5432/relay_test' npm test
```

CI supplies PostgreSQL 18 and `age`. Browser fixtures in `test/` use simulated providers and a temporary schema; start them only against the test database. Automated tests do not validate real vendor delivery, device signing, or cloud account permissions.

## Code map

| Files | Responsibility |
| --- | --- |
| `src/server.js`, `src/*-api.js` | HTTP routes, authentication, lifecycle |
| `src/applications.js`, `src/channel-store.js`, `src/channels.js`, `src/apns.js`, `src/fcm.js` | Application scopes, credentials, vendor adapters |
| `src/device-api.js`, `src/notification.js`, `src/delivery.js` | Registration proof, payload validation, delivery queue |
| `src/access.js`, `src/integrity.js`, `src/security.js`, `src/abuse.js` | Server approval, platform proof, admin security, resource limits |
| `src/database.js`, `src/schema.sql`, `src/master-key.js` | PostgreSQL transactions, migrations, encryption |
| `src/observability.js`, `src/alerts.js`, `src/maintenance.js` | Metrics, webhooks, retention |
| `src/backups.js`, `src/backup-worker.js`, `src/s3-storage.js`, `ops/` | Backup scheduling, encryption, upload, restore verification |
| `public/index.html`, `public/admin.js`, `public/*-ui.js`, `public/i18n.js`, `public/style.css` | Console; no frontend build step |
| `scripts/` | Source checks, SQLite migration, independent uptime probe |
| `docs/` | Protocols, operations, real-device validation, and review records |
| `test/` | Node test suite and browser fixtures |

## Review requirements

- Preserve application, device, server, and notification-kind authorization boundaries.
- Use parameterized database values and bounded input, concurrency, retries, and retention.
- Keep secrets and notification content out of logs, public responses, fixtures, and commits.
- Add regression coverage for security, authorization, data integrity, or retry changes. Run affected tests, then the required CI checks.
- Confirm findings through a second code path, reproduction, or regression test before describing them as defects.
- Update protocol or operations documentation when behavior changes. Describe validation that was actually performed.

Do not commit `.env`, private keys, tokens, runtime data, dumps, or backup archives. Keep example credentials explicitly synthetic. Contributions are provided under the repository's MIT license.
