#!/usr/bin/env bash
# NC2: trazabilidad de accesos al expediente en un MySQL desechable con datos sintéticos.
# Uso: bash scripts/qa/nc2-access-traceability.docker.sh [imagen]   (por defecto mysql:8.4)
# Con NC2_QA_EVIDENCE=<archivo> escribe el resultado en JSON.
set -euo pipefail
cd "$(dirname "$0")/../.."
image="${1:-mysql:8.4}"
container="medsync-nc2-access-test-$$"
trap 'docker stop "$container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$container" -p 127.0.0.1::3306 -e MYSQL_ROOT_PASSWORD=isolated-test-only "$image" >/dev/null
for attempt in {1..90}; do
 if docker exec "$container" mysqladmin ping -h127.0.0.1 -uroot -pisolated-test-only --silent >/dev/null 2>&1; then break; fi
 sleep 1
done
sleep 3
NC2_QA_ISOLATED=1 NC2_QA_PORT="$(docker port "$container" 3306 | head -1 | awk -F: '{print $NF}')" node scripts/qa/nc2-access-traceability-mysql.js
