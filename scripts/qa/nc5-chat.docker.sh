#!/usr/bin/env bash
# NC5: prueba el chat interno en un MySQL desechable con el DDL exportado del workspace.
# Uso: bash scripts/qa/nc5-chat.docker.sh [imagen]   (por defecto mysql:8.4; también probado con mysql:8.0)
set -euo pipefail
cd "$(dirname "$0")/../.."
image="${1:-mysql:8.4}"
container="medsync-nc5-chat-test-$$"
trap 'docker stop "$container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$container" -p 127.0.0.1::3306 -e MYSQL_ROOT_PASSWORD=isolated-test-only "$image" >/dev/null
for attempt in {1..90}; do
 if docker exec "$container" mysqladmin ping -h127.0.0.1 -uroot -pisolated-test-only --silent >/dev/null 2>&1; then break; fi
 sleep 1
done
sleep 3
NC5_QA_ISOLATED=1 NC5_QA_PORT="$(docker port "$container" 3306 | awk -F: '{print $NF}')" node scripts/qa/nc5-chat-mysql.js
