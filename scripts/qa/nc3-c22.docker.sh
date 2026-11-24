#!/usr/bin/env bash
# NC3/C22: ensayo del retroceso de la base completa en MySQL desechable con testigo local. Solo datos sintéticos.
# Uso: bash scripts/qa/nc3-c22.docker.sh [imagen]   (con NC3_QA_EVIDENCE_DIR=<carpeta> escribe c22-results.json)
set -euo pipefail
cd "$(dirname "$0")/../.."
image="${1:-mysql:8.4}"
container="medsync-nc3-c22-test-$$"
trap 'docker stop "$container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$container" -p 127.0.0.1::3306 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes "$image" >/dev/null
for attempt in {1..90}; do
 if docker exec "$container" mysqladmin ping -h127.0.0.1 -uroot --silent >/dev/null 2>&1; then break; fi
 sleep 1
done
sleep 4
NC3_QA_CONTAINER="$container" NC3_QA_MYSQL_PORT="$(docker port "$container" 3306 | head -1 | awk -F: '{print $NF}')" node scripts/qa/nc3-c22-mysql.js
