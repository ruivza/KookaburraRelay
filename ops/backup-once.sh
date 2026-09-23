#!/bin/sh
set -eu
umask 077
root=${BACKUP_DIR:-/backups}
retention=${BACKUP_RETENTION_DAYS:-14}
case "$retention" in ''|*[!0-9]*) echo 'Invalid backup retention' >&2; exit 1;; esac
[ "$retention" -ge 1 ] && [ "$retention" -le 3650 ]
mkdir -p "$root"
chmod 700 "$root"
stage=$(mktemp -d "$root/.snapshot.XXXXXXXX")
partial=
trap 'rm -rf "$stage"; if [ -n "$partial" ]; then rm -f "$partial"; fi' EXIT HUP INT TERM
for file in master.key admin.token monitor.token; do
  cp "/gateway-data/$file" "$stage/$file"
done
[ "$(wc -c < "$stage/master.key" | tr -d ' ')" = 32 ]
cp /gateway-config.env "$stage/.env"
pg_dump --no-owner --no-privileges --format=custom --schema=relay --file="$stage/database.dump"
# Key rotation is not implemented, but reject an inconsistent snapshot if an
# operator changes the key file while the transaction snapshot is being dumped.
cmp /gateway-data/master.key "$stage/master.key"
pg_restore --list "$stage/database.dump" > /dev/null
printf 'format=1\nschema=relay\ncreated=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$stage/metadata"
(cd "$stage" && sha256sum database.dump master.key admin.token monitor.token .env metadata > SHA256SUMS && sha256sum -c SHA256SUMS > /dev/null)
name="relay-$(date -u +%Y%m%dT%H%M%SZ)-${stage##*.}.tar"
partial="$root/.$name.partial"
tar -cf "$partial" -C "$stage" database.dump master.key admin.token monitor.token .env metadata SHA256SUMS
chmod 600 "$partial"
mv "$partial" "$root/$name"
partial=
printf '%s\n' "$(date +%s)" > "$root/.last-success.tmp"
mv "$root/.last-success.tmp" "$root/.last-success"
# Only prune complete bundles after a new complete snapshot has been published.
find "$root" -maxdepth 1 -type f -name 'relay-*.tar' -mtime "+$retention" -delete
printf 'Backup completed: %s\n' "$name"
