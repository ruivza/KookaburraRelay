#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
command -v docker >/dev/null || { echo 'Install Docker and Docker Compose first.' >&2; exit 1; }
docker compose version >/dev/null
umask 077
if [ ! -f .env ]; then
  password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  printf 'POSTGRES_PASSWORD=%s\nGATEWAY_BIND=127.0.0.1\nGATEWAY_PORT=3220\n' "$password" > .env
fi
configured_image=${GATEWAY_IMAGE:-$(sed -n 's/^GATEWAY_IMAGE=//p' .env | tail -n 1)}
if [ -n "$configured_image" ]; then
  docker compose pull gateway postgres
  backup_image=${GATEWAY_BACKUP_IMAGE:-$(sed -n 's/^GATEWAY_BACKUP_IMAGE=//p' .env | tail -n 1)}
  if [ -n "$backup_image" ]; then docker compose pull backup; else docker compose build backup; fi
  docker compose up -d --no-build --wait
else
  docker compose up -d --build --wait
fi
printf '\nKookaburra Relay is ready. Default URL: http://127.0.0.1:3220\n'
printf 'Read the initial admin token locally: docker compose exec gateway cat /app/data/admin.token\n'
printf 'Keep both named volumes; docker compose down -v permanently deletes data.\n'
