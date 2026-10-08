# Operations

## Prebuilt installation

Download the source archive, gateway image archive and backup image archive for your platform from [Releases](https://github.com/ruivza/KookaburraRelay/releases). Verify them against `SHA256SUMS`, extract the source, then load both images:

```sh
docker load -i kookaburra-relay-0.1.2-linux-amd64.tar.gz
docker load -i kookaburra-relay-backup-0.1.2-linux-amd64.tar.gz
```

Use `arm64` archives on ARM hosts. For a fresh installation, run `umask 077; cp .env.example .env` and replace `POSTGRES_PASSWORD` with a long random hex password. Set `GATEWAY_IMAGE=kookaburra-relay:0.1.2` and `GATEWAY_BACKUP_IMAGE=kookaburra-relay-backup:0.1.2`, then run `docker compose up -d --no-build --wait`. Keep an existing deployment's `.env` and data volumes.

GHCR alternatives: `ghcr.io/ruivza/kookaburrarelay:0.1.2` and `ghcr.io/ruivza/kookaburrarelay-backup:0.1.2`. Their package visibility must be public for anonymous pulls; repository visibility does not change it automatically.

## Configuration

| Variable | Purpose |
| --- | --- |
| `GATEWAY_DATABASE_URL` | Required PostgreSQL connection string for direct Node execution |
| `GATEWAY_DATABASE_SCHEMA` | Schema; defaults to `public`, Compose uses `relay` |
| `GATEWAY_HOST`, `GATEWAY_PORT` | Node listen address and port; defaults to `127.0.0.1:3220` |
| `GATEWAY_DATA_DIR` | Master key and initial admin / monitor tokens; defaults to repository-root `data/` |
| `GATEWAY_ADMIN_TOKEN` | Optional initial administrator token, at least 32 characters |
| `GATEWAY_TRUSTED_PROXIES` | Comma-separated verified proxy IP addresses / CIDRs |
| `POSTGRES_PASSWORD` | Required Compose database password |
| `GATEWAY_BIND` | Compose host bind address; defaults to `127.0.0.1` |
| `GATEWAY_IMAGE`, `GATEWAY_BACKUP_IMAGE` | Optional prebuilt images used by `install.sh` |
| `GATEWAY_BACKUP_DIR` | Compose local backup directory; defaults to `./backups` |
| `GATEWAY_BACKUP_INTERVAL_SECONDS`, `GATEWAY_BACKUP_RETENTION_DAYS` | Initial backup schedule; later changes use the console |

Administrator tokens and backup defaults are imported only during their first database initialization. Later environment changes do not replace stored settings. Rotating the admin token invalidates sessions but does not update `admin.token`.

## Network and process ownership

The console, `/auth/login`, `/admin/*`, `/v1/*`, health, and monitoring share port 3220. Backups expose no port; Compose does not publish PostgreSQL. Use an HTTPS reverse proxy and restrict console and management routes. Permit access to the Node listener only from the proxy.

Client IP defaults to the socket address. Trusted proxies enable right-to-left parsing of `X-Forwarded-For`, stopping at the first untrusted address. Configure the addresses the gateway actually sees; do not trust arbitrary origins or an entire private network.

One gateway owns each PostgreSQL schema through an advisory lock. A second instance refuses to start. Ownership loss shuts down the gateway and exits with an error; a process manager may restart it. Graceful shutdown stops scheduling and waits for active work, with a deadline. Horizontal scaling within a schema is not supported.

## Console

The bilingual console has no frontend build step or CDN dependency. Admin API requests require a session obtained from `POST /auth/login {token,code?}`. With two-factor authentication enabled, a missing code returns `requiresSecondFactor:true` without a session. `POST /admin/logout` revokes the session.

Sessions last up to eight hours and are stored in the current tab's `sessionStorage`. Refresh does not extend expiry. Token rotation or two-factor changes revoke all sessions. Sensitive security and backup configuration changes require reauthentication. Recovery codes replace the second factor, not the administrator token.

Application disablement and channel credential or enablement changes revoke that application's registrations and cancel pending jobs. Renaming and fallback-text changes preserve registrations. Disabling a notification kind cancels its pending jobs and pending registrations without expanding any existing grant. Already submitted pushes cannot be recalled.

## Delivery queue

`POST /v1/notify` is synchronous: HTTP 200 means provider acceptance. The gateway records the result but does not retry this interface; callers manage retries and ambiguous failures.

`POST /v1/jobs` is asynchronous: HTTP 202 means queued. Supply a stable `requestId` and reuse it when retrying an uncertain enqueue. Query `/v1/jobs/:id` with the same scoped credentials. Do not send the same work through both interfaces.

- Deduplication is scoped to registration + `requestId` while the job record exists; default retention is 30 days and is configurable.
- Each registration allows one unfinished job and a minimum 60-second interval between new jobs.
- At most 10,000 unfinished jobs and four shared sending slots are allowed. Synchronous requests without a slot return 503 before enqueueing.
- Explicit temporary failures retry with jitter and bounded `Retry-After`, starting at 60 seconds, up to six attempts and a 24-hour deadline.
- Permanent invalid-device errors revoke the registration. Authentication and parameter failures do not retry.
- Connection failures, timeouts, and interrupted sends may already have reached the provider: state is `unknown` and work is not automatically replayed.

States are `queued`, `sending`, `retrying`, `accepted`, `failed`, `unknown`, and `cancelled`. There are no device delivery receipts or exactly-once guarantees.

## Monitoring and retention

`/healthz` checks the process and PostgreSQL, not provider delivery. `/metrics` requires the separate `monitor.token`. It exposes queue, process, delivery, sampling, and backup metrics. Vendor acceptance rates exclude waiting, cancelled, and retrying jobs.

Run `scripts/uptime-probe.mjs` from the repository root on a separate Node.js 24+ host to monitor outages:

```sh
GATEWAY_URL=https://push.example.com \
GATEWAY_MONITOR_TOKEN_FILE=/secure/monitor.token \
PROBE_DATA_DIR=/var/lib/relay-probe \
PROBE_NAME=external-1 \
node scripts/uptime-probe.mjs
```

The probe stores failed samples in local SQLite and replays bounded batches after recovery. Missing samples stay unknown. A probe on the gateway host cannot establish external availability. Optional [webhook alerts](ACCESS_SECURITY.md#webhook-alerts) cannot notify while the gateway itself is stopped.

Retention settings default to daily cleanup: request logs 14 days, error logs 30 days, audit logs 90 days, other history 30 days. Manual cleanup requires a one-use preview. Active jobs, credentials, and configuration are preserved. Deleted PostgreSQL records may release reusable space without immediately shrinking files. Cleanup removes deduplication history and does not replace backups.

## Backup and recovery

Compose starts a backup worker that immediately creates a local archive and normally repeats daily, retaining about 14 days. Later schedule changes use the console. Archives contain a consistent PostgreSQL `relay` snapshot, matching `master.key`, initial admin and monitor tokens, `.env`, metadata, and SHA-256 checksums. Protect the directory and every archive: local backups contain unencrypted secrets.

Create a local backup without remote upload:

```sh
docker compose run --rm --no-deps --entrypoint sh backup /ops/backup-once.sh
```

Verify an archive in a disposable database without overwriting the running database:

```sh
sh ops/verify-backup.sh /absolute/path/relay-backup.tar
```

The script checks archive members and checksums, restores a temporary database, and verifies the master-key binding and application decryption. It requires running PostgreSQL and gateway containers. Actual recovery uses a separate deployment with the matching database, key, and configuration; validate it before directing traffic there. A new key cannot decrypt an old database.

Remote backups are disabled by default. The console supports B2, R2, AWS S3, and compatible HTTPS S3 endpoints using long-lived access keys. Create an `age` key pair offline, store the private identity securely, and give the gateway only its public recipient. Remote archives are `.tar.age`; losing the private identity prevents decryption.

Use a private bucket and narrowly scoped credentials. Connection tests upload a small encrypted object; they do not prove database backup or recovery. Configure remote object and version retention at the storage provider: the gateway does not delete remote objects. Fixed-filename mode requires enabled bucket versioning and permissions to inspect it and read object versions. Keep prefixes unique per gateway.

Decrypt a downloaded archive on the machine holding the identity, then run the restore verification:

```sh
age --decrypt -i backup-identity.txt -o backup.tar backup.tar.age
sh ops/verify-backup.sh /absolute/path/backup.tar
```

Local success, remote upload success, worker health, and successful restore verification are separate results. Validate actual cloud credentials and repeat download/decrypt/restore exercises.

## SQLite migration

Stop the old gateway and save its SQLite database, WAL/SHM files, master key, and tokens. The source must already use the legacy multi-application schema. Prepare an empty PostgreSQL database or schema and keep the original master key in the new gateway data directory.

```sh
node --env-file=.env scripts/migrate-sqlite.mjs /absolute/path/gateway.sqlite
```

Import validates fields in one transaction and refuses an initialized target. PostgreSQL writes make the old SQLite snapshot unsuitable for direct rollback. The external uptime probe still uses SQLite independently.
