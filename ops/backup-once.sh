#!/bin/sh
set -eu
umask 077
root=${BACKUP_DIR:-/backups}
data=${GATEWAY_DATA_DIR:-/gateway-data}
config=${GATEWAY_CONFIG_FILE:-/gateway-config.env}
retention=${BACKUP_RETENTION_DAYS:-14}
# The backup worker passes the age public key from the console's backup settings.
recipient=${BACKUP_AGE_RECIPIENT:-}
case "$retention" in ''|*[!0-9]*) echo 'Invalid backup retention' >&2; exit 1;; esac
[ "$retention" -ge 1 ] && [ "$retention" -le 3650 ]
mkdir -p "$root"
chmod 700 "$root"
stage=$(mktemp -d "$root/.snapshot.XXXXXXXX")
partial=
trap 'rm -rf "$stage"; if [ -n "$partial" ]; then rm -f "$partial"; fi' EXIT HUP INT TERM
for file in master.key admin.token monitor.token; do
  cp "$data/$file" "$stage/$file"
done
[ "$(wc -c < "$stage/master.key" | tr -d ' ')" = 32 ]
cp "$config" "$stage/.env"
pg_dump --no-owner --no-privileges --format=custom --schema=relay --file="$stage/database.dump"
# Key rotation is not implemented, but reject an inconsistent snapshot if an
# operator changes the key file while the transaction snapshot is being dumped.
cmp "$data/master.key" "$stage/master.key"
pg_restore --list "$stage/database.dump" > /dev/null
printf 'format=1\nschema=relay\ncreated=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$stage/metadata"
(cd "$stage" && sha256sum database.dump master.key admin.token monitor.token .env metadata > SHA256SUMS && sha256sum -c SHA256SUMS > /dev/null)
name="relay-$(date -u +%Y%m%dT%H%M%SZ)-${stage##*.}.tar"
if [ -n "$recipient" ]; then
  # Only ciphertext leaves the staging directory; the remote upload reuses this file.
  tar -cf "$stage/bundle.tar" -C "$stage" database.dump master.key admin.token monitor.token .env metadata SHA256SUMS
  name="$name.age"
  partial="$root/.$name.partial"
  age --encrypt --recipient "$recipient" --output "$partial" "$stage/bundle.tar"
else
  echo 'Warning: no age public key in backup settings; this local bundle is not encrypted' >&2
  partial="$root/.$name.partial"
  tar -cf "$partial" -C "$stage" database.dump master.key admin.token monitor.token .env metadata SHA256SUMS
fi
chmod 600 "$partial"
mv "$partial" "$root/$name"
partial=
printf '%s\n' "$(date +%s)" > "$root/.last-success.tmp"
mv "$root/.last-success.tmp" "$root/.last-success"
# Only prune complete bundles after a new complete snapshot has been published.
find "$root" -maxdepth 1 -type f \( -name 'relay-*.tar' -o -name 'relay-*.tar.age' \) -mtime "+$retention" -delete
printf 'Backup completed: %s\n' "$name"
