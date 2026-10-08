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
| `server.js`, `*-api.js` | HTTP routes, authentication, lifecycle |
| `applications.js`, `channel-store.js`, `channels.js`, `apns.js`, `fcm.js` | Application scopes, credentials, vendor adapters |
| `device-api.js`, `notification.js`, `delivery.js` | Registration proof, payload validation, delivery queue |
| `access.js`, `integrity.js`, `security.js`, `abuse.js` | Server approval, platform proof, admin security, resource limits |
| `database.js`, `schema.sql`, `master-key.js` | PostgreSQL transactions, migrations, encryption |
| `observability.js`, `alerts.js`, `maintenance.js` | Metrics, webhooks, retention |
| `backups.js`, `backup-worker.js`, `s3-storage.js`, `ops/` | Backup scheduling, encryption, upload, restore verification |
| `index.html`, `admin.js`, `*-ui.js`, `i18n.js`, `style.css` | Console; no frontend build step |
| `test/` | Node test suite and browser fixtures |

## Review requirements

- Preserve application, device, server, and notification-kind authorization boundaries.
- Use parameterized database values and bounded input, concurrency, retries, and retention.
- Keep secrets and notification content out of logs, public responses, fixtures, and commits.
- Add regression coverage for security, authorization, data integrity, or retry changes. Run affected tests, then the required CI checks.
- Confirm findings through a second code path, reproduction, or regression test before describing them as defects.
- Update protocol or operations documentation when behavior changes. Describe validation that was actually performed.

Do not commit `.env`, private keys, tokens, runtime data, dumps, or backup archives. Keep example credentials explicitly synthetic. Contributions are provided under the repository's MIT license.
