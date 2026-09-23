#!/bin/sh
set -eu
interval=${BACKUP_INTERVAL_SECONDS:-86400}
case "$interval" in ''|*[!0-9]*) echo 'Invalid backup interval' >&2; exit 1;; esac
[ "$interval" -ge 60 ] && [ "$interval" -le 604800 ]
trap 'exit 0' TERM INT
while :; do
  if sh /ops/backup-once.sh; then delay=$interval; else echo 'Backup failed; retrying in five minutes' >&2; delay=300; fi
  sleep "$delay" & wait $!
done
