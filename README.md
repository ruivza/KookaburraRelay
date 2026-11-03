# Kookaburra Relay

[![CI](https://github.com/ruivza/KookaburraRelay/actions/workflows/docker.yml/badge.svg)](https://github.com/ruivza/KookaburraRelay/actions/workflows/docker.yml)
[![Release](https://img.shields.io/github/v/release/ruivza/KookaburraRelay)](https://github.com/ruivza/KookaburraRelay/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 24+](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](package.json)

Self-hosted push gateway for APNs and FCM. A single service accepts delivery requests from your backend, queues them in PostgreSQL, and forwards them to Apple and Google. Administration happens in a built-in web console (English and Chinese).

## Features

- **APNs and FCM** delivery with per-application credentials and a PostgreSQL-backed queue
- **Scoped credentials**: business servers get delivery tokens, never admin tokens or vendor private keys
- **Device registration** by challenge confirmed over the push channel
- **Optional integrity checks**: App Attest, Play Integrity, and server approval
- **Encrypted alerts** on APNs: the gateway routes opaque envelopes without reading them
- **Admin console** with two-factor authentication, monitoring, quotas, alert webhooks, and audit log
- **Encrypted backups** to local disk or S3-compatible storage, with restore verification
- **Hardened Compose deployment**: read-only root filesystem, dropped capabilities, non-superuser database role

| Notification kind | APNs | FCM |
| --- | --- | --- |
| `sync` (background update hint) | Yes | Yes |
| `alert` (title, body, optional sound) | Yes | Yes |
| `encrypted_alert` (encrypted envelope with fallback alert) | Yes | No |

New applications start with only `sync` enabled. Mobile client libraries are not part of this repository.

## Quick start

Requires Docker Engine with Compose.

```sh
git clone https://github.com/ruivza/KookaburraRelay.git
cd KookaburraRelay
./install.sh
```

The installer writes a `.env` with random database passwords on first run, then starts the gateway, PostgreSQL, and the backup worker. Open <http://127.0.0.1:3220> and sign in with the initial admin token:

```sh
docker compose exec gateway cat /app/data/admin.token
```

Then create an application, add its APNs or FCM credentials, enable the notification kinds it needs, and turn on two-factor authentication under **Security**.

Prebuilt images and installation archives for `linux/amd64` and `linux/arm64` are attached to each [release](https://github.com/ruivza/KookaburraRelay/releases); see [prebuilt installation](docs/OPERATIONS.md#prebuilt-installation).

### Upgrading

```sh
git pull
docker compose up -d --build --wait
```

Back up PostgreSQL, the gateway data volume, and `.env` together. `docker compose down -v` deletes all data, and a lost `master.key` makes encrypted data unrecoverable.

## Running without Docker

Requires Node.js 24+ and PostgreSQL (CI uses PostgreSQL 18).

```sh
npm ci
export GATEWAY_DATABASE_URL='postgresql://relay:replace-me@127.0.0.1:5432/relay'
export GATEWAY_DATABASE_SCHEMA=relay
npm start
```

Use a dedicated database and a non-superuser role that owns the schema and has `CREATE` on the database. The schema is created on startup. The service listens on `127.0.0.1:3220` by default. One gateway instance per schema.

## Configuration

All settings are environment variables. [.env.example](.env.example) lists the Compose defaults; the full reference is in [docs/OPERATIONS.md](docs/OPERATIONS.md#configuration).

For public access, put the gateway behind an HTTPS reverse proxy, restrict the management routes, and set `GATEWAY_TRUSTED_PROXIES` to the proxy's exact addresses.

## Development

```sh
npm ci
npm run check
npm run lint
npm run typecheck
npm run format:check
GATEWAY_DATABASE_URL='postgresql://relay_test:replace-me@127.0.0.1:5432/relay_test' npm test
```

Or run the same checks in throwaway containers with only Docker installed:

```sh
sh scripts/test-docker.sh
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the code map and review requirements.

## Documentation

- [Notification and registration protocol](docs/NOTIFICATION_PROTOCOL.md)
- [Encrypted notifications](docs/ENCRYPTED_NOTIFICATIONS.md)
- [Application integrity, server approval, quotas, and alerts](docs/ACCESS_SECURITY.md)
- [Operations: configuration, monitoring, backup and recovery](docs/OPERATIONS.md)
- [Performance baseline](docs/PERFORMANCE.md)
- [Real-device validation](docs/REAL_DEVICE_TESTING.md)
- [Changelog](CHANGELOG.md)

## Security

Report vulnerabilities as described in [SECURITY.md](SECURITY.md). Do not open public issues for security problems.

## License

[MIT](LICENSE). Third-party dependencies are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
