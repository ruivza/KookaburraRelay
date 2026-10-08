# Kookaburra Relay

Self-hosted APNs and FCM push gateway with a bilingual admin console and PostgreSQL storage.

## Install

Requires Docker Engine and Docker Compose. Clone the repository, then run:

```sh
./install.sh
```

Open `http://127.0.0.1:3220`. Read the initial admin token locally:

```sh
docker compose exec gateway cat /app/data/admin.token
```

Use HTTPS and restrict administrator access for public deployments. Protect the database and matching `master.key` together.

## Guides

- [Setup](https://github.com/ruivza/KookaburraRelay#readme)
- [Protocol](https://github.com/ruivza/KookaburraRelay/blob/main/NOTIFICATION_PROTOCOL.md)
- [Access policies](https://github.com/ruivza/KookaburraRelay/blob/main/ACCESS_SECURITY.md)
- [Operations and recovery](https://github.com/ruivza/KookaburraRelay/blob/main/docs/OPERATIONS.md)
- [Security](https://github.com/ruivza/KookaburraRelay/blob/main/SECURITY.md)
