#!/bin/sh
# Run the check and test suite, or any command, inside throwaway Node 24 and
# PostgreSQL 18 containers. Needs only Docker and a POSIX shell (Linux, macOS,
# or Git Bash on Windows); Node and PostgreSQL need not be installed on the host.
#
#   scripts/test-docker.sh                          npm run check && npm test
#   scripts/test-docker.sh npm run bench -- --jobs 2000
#
# Every run uses its own network and container names and removes them on exit.
# RELAY_TEST_NODE_IMAGE and RELAY_TEST_POSTGRES_IMAGE override the images.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
# Docker Desktop on Windows needs a Windows path for the bind mount.
if host=$(cd "$root" && pwd -W 2>/dev/null); then :; else host=$root; fi
node_image=${RELAY_TEST_NODE_IMAGE:-node:24-alpine}
postgres_image=${RELAY_TEST_POSTGRES_IMAGE:-postgres:18-alpine}
suffix=$(date +%s)-$$-$(od -An -N4 -tx4 /dev/urandom | tr -d ' \n')
net=relay-test-$suffix pg=relay-pg-$suffix runner=relay-run-$suffix
commit=$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)
if ! git -C "$root" diff --quiet HEAD -- 2>/dev/null; then commit=$commit-dirty; fi

cleanup() {
  # A repeated Ctrl-C or a group-wide TERM must not cut cleanup short.
  trap '' INT TERM
  docker rm -f "$runner" "$pg" >/dev/null 2>&1 || true
  # --rm removal can still be in progress; the network goes once nothing is attached.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if docker network rm "$net" >/dev/null 2>&1 || ! docker network inspect "$net" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ $# -eq 0 ]; then set -- sh -c 'npm run check && npm test'; fi

docker network create "$net" >/dev/null
docker run -d --rm --name "$pg" --network "$net" \
  -e POSTGRES_USER=relay -e POSTGRES_PASSWORD=ci-test-password -e POSTGRES_DB=relay \
  "$postgres_image" >/dev/null
# The image's init server listens only on a socket, so TCP readiness means the final server.
tries=0
until docker exec "$pg" pg_isready -q -h 127.0.0.1 -U relay -d relay 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then echo "PostgreSQL did not become ready" >&2; exit 1; fi
  sleep 1
done

# node_modules lives in an anonymous volume so host and container installs never mix.
# Waiting on a background job lets INT/TERM reach the traps at once; cleanup stops the runner.
MSYS_NO_PATHCONV=1 docker run --rm --init --name "$runner" --network "$net" \
  -v "$host:/repo" -v /repo/node_modules -w /repo \
  -e GATEWAY_DATABASE_URL="postgresql://relay:ci-test-password@$pg:5432/relay" \
  -e RELAY_GIT_COMMIT="$commit" \
  "$node_image" sh -c 'apk add --no-cache age >/dev/null && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && exec "$@"' sh "$@" &
wait $!
