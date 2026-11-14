#!/usr/bin/env bash
# NC4/L2: aplica el DDL de catálogos en un MySQL desechable y prueba sus garantías (L2-R1, CR-5, CR-6).
# Uso: bash scripts/qa/nc4-catalogs.docker.sh [imagen]   (por defecto mysql:8.4; también probado con mysql:8.0)
set -euo pipefail
cd "$(dirname "$0")/../.."
image="${1:-mysql:8.4}"
container="medsync-nc4-catalogs-test-$$"
trap 'docker stop "$container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$container" -p 127.0.0.1::3306 -e MYSQL_ROOT_PASSWORD=isolated-test-only -e MYSQL_DATABASE=medsync_nc4_test "$image" >/dev/null
for attempt in {1..90}; do
 if docker exec "$container" mysqladmin ping -h127.0.0.1 -uroot -pisolated-test-only --silent >/dev/null 2>&1; then break; fi
 sleep 1
done
sleep 3
NC4_QA_ISOLATED=1 NC4_QA_PORT="$(docker port "$container" 3306 | awk -F: '{print $NF}')" NC4_QA_IMAGE="$image" node scripts/qa/nc4-catalogs-mysql.js
