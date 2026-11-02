#!/bin/sh
# Runs once, when the PostgreSQL volume is first initialized. Creates the
# non-superuser role used by the gateway and backup worker and gives it schema
# relay. A .env without GATEWAY_DB_USER keeps the superuser; existing volumes
# are migrated with ops/create-app-role.sh instead.
# The image's entrypoint sources this file when it is not executable, so it
# must not call exit or change shell options.
relay_app_role() {
  local app_user=${RELAY_APP_USER:-$POSTGRES_USER}
  [ "$app_user" = "$POSTGRES_USER" ] && return 0
  case "$app_user" in
    [a-z_]*) ;;
    *) echo 'GATEWAY_DB_USER must be a lowercase PostgreSQL identifier' >&2; return 1;;
  esac
  case "$app_user" in
    *[!a-z0-9_]*|postgres|pg_*) echo 'GATEWAY_DB_USER must be a lowercase PostgreSQL identifier' >&2; return 1;;
  esac
  if [ -z "${RELAY_APP_PASSWORD:-}" ] || [ "$RELAY_APP_PASSWORD" = "$POSTGRES_PASSWORD" ]; then
    echo 'GATEWAY_DB_PASSWORD must be set and differ from POSTGRES_PASSWORD' >&2
    return 1
  fi
  psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v app_user="$app_user" -v db="$POSTGRES_DB" <<'SQL'
\getenv app_password RELAY_APP_PASSWORD
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password';
-- The gateway runs CREATE SCHEMA IF NOT EXISTS at startup, which checks this privilege.
GRANT CREATE ON DATABASE :"db" TO :"app_user";
CREATE SCHEMA relay AUTHORIZATION :"app_user";
SQL
}
relay_app_role
