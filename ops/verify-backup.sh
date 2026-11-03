#!/bin/sh
# Restore only into a freshly created disposable database; never overwrite relay.
set -eu
umask 077
usage='Usage: sh ops/verify-backup.sh [-i age-identity-file] /absolute/path/to/relay-backup.tar[.age]'
identity=
while getopts i: option; do
  case "$option" in i) identity=$OPTARG;; *) echo "$usage" >&2; exit 2;; esac
done
shift $((OPTIND - 1))
archive=${1:?$usage}
case "$archive" in /*) ;; *) archive="$(pwd)/$archive";; esac
case "$identity" in ''|/*) ;; *) identity="$(pwd)/$identity";; esac
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
# Encrypted bundles (local relay-*.tar.age or downloaded remote copies) are
# decrypted into the private staging directory only.
case "$archive" in
  *.age)
    [ -n "$identity" ] || { echo 'Encrypted bundle: pass the age identity file with -i' >&2; exit 1; }
    command -v age >/dev/null || { echo 'Install age to verify encrypted bundles' >&2; exit 1; }
    mkdir "$stage/decrypted"
    age --decrypt --identity "$identity" --output "$stage/decrypted/bundle.tar" "$archive"
    archive="$stage/decrypted/bundle.tar";;
esac
# Extract only our flat allowlist, rejecting links and unexpected archive members.
[ "$(tar -tf "$archive" | LC_ALL=C sort)" = "$(printf '%s\n' .env SHA256SUMS admin.token database.dump master.key metadata monitor.token | LC_ALL=C sort)" ]
if tar -tvf "$archive" | cut -c1 | tr -d '\n' | tr -d '-' | grep -q .; then echo 'Archive must contain regular files only' >&2; exit 1; fi
tar -xf "$archive" -C "$stage"
(cd "$stage" && if command -v sha256sum >/dev/null; then sha256sum -c SHA256SUMS; else shasum -a 256 -c SHA256SUMS; fi)
# The dump holds the schema named in the bundle metadata (GATEWAY_DATABASE_SCHEMA when it was taken: public by
# default, relay under Compose); the restored gateway must open that schema.
schema=$(sed -n 's/^schema=//p' "$stage/metadata")
case "$schema" in ''|[!a-z_]*|*[!a-z0-9_]*) echo 'Bundle metadata names no valid schema' >&2; exit 1;; esac
# Restore as the gateway's own database role so the check below runs with the
# privileges the gateway really has; only database setup and cleanup use the superuser.
app_user=$(docker compose exec -T gateway node -p 'decodeURIComponent(new URL(process.env.GATEWAY_DATABASE_URL).username)')
docker compose exec -T postgres createdb -U kookaburra -O "$app_user" "$restore_db"
created=true
# A dump of schema public recreates it, so the empty one every new database starts with must go first.
if [ "$schema" = public ]; then docker compose exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U kookaburra -d "$restore_db" -c 'DROP SCHEMA public'; fi
docker compose exec -T postgres pg_restore -U kookaburra --role="$app_user" --exit-on-error --no-owner --no-privileges -d "$restore_db" < "$stage/database.dump"
docker compose exec -T gateway node --input-type=module -e '
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {createGateway} from "/app/src/server.js";
const dataDir=mkdtempSync("/tmp/relay-restore-");
const url=new URL(process.env.GATEWAY_DATABASE_URL);url.pathname="/"+process.argv[1];
let app;
try {
 writeFileSync(dataDir+"/master.key",readFileSync(0),{mode:0o600});
 app=await createGateway({databaseUrl:url.toString(),databaseSchema:process.argv[2],dataDir,autoStart:false});
 await app.applications.list();
 await app.applications.channels.verify();
 console.log("Restore verified: PostgreSQL dump, master-key binding and application decryption");
} finally {await app?.close();rmSync(dataDir,{recursive:true,force:true});}
' "$restore_db" "$schema" < "$stage/master.key"
