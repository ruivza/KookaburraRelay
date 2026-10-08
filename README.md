# Kookaburra Relay

Independent APNs / FCM push gateway with a bilingual admin console, scoped device credentials, PostgreSQL delivery queues, optional App Attest / Play Integrity verification, monitoring, and encrypted remote backups. No mail server or client application is required to run the gateway.

| Notification | APNs | FCM |
| --- | --- | --- |
| `sync`: background update hint | Yes | Yes |
| `alert`: title, body, optional sound | Yes | Yes |
| `encrypted_alert`: encrypted envelope and fallback alert | Yes | Not implemented |

New applications enable only `sync`. Existing credentials do not gain permissions when more notification kinds are enabled. Vendor acceptance does not prove device delivery. This repository does not include mobile clients.

## Quick start

Requires Docker Engine and Docker Compose.

```sh
./install.sh
```

The installer generates a random PostgreSQL password when `.env` is absent and starts the gateway, database, and backup worker. For an existing `.env`, set `POSTGRES_PASSWORD`; see [.env.example](.env.example).

Open [http://127.0.0.1:3220](http://127.0.0.1:3220) and read the initial admin token locally:

```sh
docker compose exec gateway cat /app/data/admin.token
```

Create an application, configure its APNs or FCM credentials, and enable the required notification kinds. Enable administrator two-factor authentication in Security. Keep credentials, database dumps, and backups private.

Update from source with `docker compose up -d --build --wait`. Back up PostgreSQL, the gateway data volume, and configuration together. `docker compose down -v` deletes stored data. Losing `master.key` makes existing encrypted data unrecoverable.

## Run without Docker

Requires Node.js 24+ and PostgreSQL; Compose and CI use PostgreSQL 18.

```sh
npm ci
export GATEWAY_DATABASE_URL='postgresql://relay:replace-me@127.0.0.1:5432/relay'
export GATEWAY_DATABASE_SCHEMA=relay
npm start
```

Use a dedicated database and account. The service initializes its schema on startup and listens on `127.0.0.1:3220` by default. See [configuration and operations](docs/OPERATIONS.md).

## Deployment

Use an HTTPS reverse proxy for public access and restrict management routes. Configure `GATEWAY_TRUSTED_PROXIES` with the actual proxy addresses only. One gateway instance may use each database schema.

Devices register by confirming a challenge received through APNs / FCM. Business servers receive scoped delivery credentials, never administrator tokens or vendor private keys. App Attest, Play Integrity, and server approval are optional policies and require compatible integrations.

## Documentation

- [Notification and registration protocol](docs/NOTIFICATION_PROTOCOL.md)
- [Application integrity, server approval, quotas, and alerts](docs/ACCESS_SECURITY.md)
- [Operations, monitoring, and backup recovery](docs/OPERATIONS.md)
- [Real-device validation](docs/REAL_DEVICE_TESTING.md)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Changelog](CHANGELOG.md)
- [Release review](docs/REVIEW.md)

GitHub Actions tests and builds gateway and backup images for `linux/amd64` and `linux/arm64`. See the [workflow](.github/workflows/docker.yml); publication status is determined by its run results.

Releases include source archives and Docker installation archives for both platforms. See [prebuilt installation](docs/OPERATIONS.md#prebuilt-installation). GHCR images are also published; their visibility is configured separately on GitHub.

## License

Code and bundled project assets are licensed under the [MIT License](LICENSE). The license does not imply endorsement of derivative projects by the original authors. Third-party dependencies retain their own licenses.
