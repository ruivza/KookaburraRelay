#!/bin/sh
# Move an existing installation off the PostgreSQL superuser. Creates or updates
# the gateway's role, hands it schema relay and the objects in it (nothing
# else), records the credentials in .env and restarts the stack with them.
# Safe to run again; the superuser keeps working for maintenance.
set -eu
umask 077
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
[ -f .env ] || { echo 'No .env found; run install.sh for a new installation' >&2; exit 1; }
setting() { sed -n "s/^$1=//p" .env | tail -n 1; }
user=$(setting GATEWAY_DB_USER); user=${user:-relay_app}
password=$(setting GATEWAY_DB_PASSWORD)
[ -n "$password" ] || password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
case "$user" in
  [a-z_]*) ;;
  *) echo 'GATEWAY_DB_USER must be a lowercase PostgreSQL identifier' >&2; exit 1;;
esac
case "$user" in
  *[!a-z0-9_]*|kookaburra|postgres|pg_*) echo 'GATEWAY_DB_USER must be a lowercase PostgreSQL identifier other than the superuser' >&2; exit 1;;
esac
# The password is part of GATEWAY_DATABASE_URL and a psql literal: keep it URL-safe.
case "$password" in
  *[!A-Za-z0-9._~-]*) echo 'GATEWAY_DB_PASSWORD may contain only letters, digits and ._~-' >&2; exit 1;;
esac
[ "${#password}" -ge 16 ] || { echo 'GATEWAY_DB_PASSWORD must be at least 16 characters' >&2; exit 1; }
[ "$password" != "$(setting POSTGRES_PASSWORD)" ] || { echo 'GATEWAY_DB_PASSWORD must differ from POSTGRES_PASSWORD' >&2; exit 1; }

# Stop the database clients so ownership changes do not wait behind their locks.
docker compose stop backup gateway
if ! {
  cat <<EOF
\\set app_user '$user'
\\set app_password '$password'
SET lock_timeout = '30s';
SELECT format('CREATE ROLE %I', :'app_user') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user') \\gexec
ALTER ROLE :"app_user" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'app_password';
SET relay.app_role = :'app_user';
SET relay.app_schema = relay;
EOF
  cat ops/relay-app-role.sql
} | docker compose exec -T postgres psql -X -q -v ON_ERROR_STOP=1 --single-transaction -U kookaburra -d kookaburra -f -; then
  echo 'Role migration failed; restarting the previous configuration' >&2
  docker compose start gateway backup
  exit 1
fi

# Append rather than rewrite: the last assignment wins for Compose and for setting().
[ -z "$(tail -c 1 .env)" ] || echo >> .env
[ "$(setting GATEWAY_DB_USER)" = "$user" ] || printf 'GATEWAY_DB_USER=%s\n' "$user" >> .env
[ "$(setting GATEWAY_DB_PASSWORD)" = "$password" ] || printf 'GATEWAY_DB_PASSWORD=%s\n' "$password" >> .env
docker compose up -d --wait
printf 'Gateway and backup worker now connect to PostgreSQL as %s.\n' "$user"
