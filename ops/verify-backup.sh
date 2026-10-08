#!/bin/sh
# Restore only into a freshly created disposable database; never overwrite relay.
set -eu
umask 077
archive=${1:?Usage: sh ops/verify-backup.sh /absolute/path/to/backup.tar}
case "$archive" in /*) ;; *) archive="$(pwd)/$archive";; esac
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
stage=$(mktemp -d)
restore_db="relay_restore_$(date +%s)_$$"
created=false
cleanup() {
  if [ "$created" = true ]; then docker compose exec -T postgres dropdb -U kookaburra --if-exists "$restore_db"; fi
  rm -rf "$stage"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
# Extract only our flat allowlist, rejecting links and unexpected archive members.
[ "$(tar -tf "$archive" | LC_ALL=C sort)" = "$(printf '%s\n' .env SHA256SUMS admin.token database.dump master.key metadata monitor.token | LC_ALL=C sort)" ]
if tar -tvf "$archive" | cut -c1 | tr -d '\n' | tr -d '-' | grep -q .; then echo 'Archive must contain regular files only' >&2; exit 1; fi
tar -xf "$archive" -C "$stage"
(cd "$stage" && if command -v sha256sum >/dev/null; then sha256sum -c SHA256SUMS; else shasum -a 256 -c SHA256SUMS; fi)
docker compose exec -T postgres createdb -U kookaburra "$restore_db"
created=true
docker compose exec -T postgres pg_restore -U kookaburra --exit-on-error --no-owner --no-privileges -d "$restore_db" < "$stage/database.dump"
docker compose exec -T gateway node --input-type=module -e '
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {createGateway} from "/app/src/server.js";
const dataDir=mkdtempSync("/tmp/relay-restore-");
const url=new URL(process.env.GATEWAY_DATABASE_URL);url.pathname="/"+process.argv[1];
let app;
try {
 writeFileSync(dataDir+"/master.key",readFileSync(0),{mode:0o600});
 app=await createGateway({databaseUrl:url.toString(),databaseSchema:"relay",dataDir,adminToken:"restore-verification-only-".repeat(3),autoStart:false});
 await app.applications.list();
 console.log("Restore verified: PostgreSQL dump, master-key binding and application decryption");
} finally {await app?.close();rmSync(dataDir,{recursive:true,force:true});}
' "$restore_db" < "$stage/master.key"
