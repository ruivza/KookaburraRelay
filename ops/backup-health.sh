#!/bin/sh
set -eu
last=$(cat "${BACKUP_DIR:-/backups}/.worker-heartbeat")
[ "$(( $(date +%s) - last ))" -lt 120 ]
