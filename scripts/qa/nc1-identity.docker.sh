#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
image="${1:-mysql:8.0}"
case "$image" in mysql:8.0|mysql:8.4) ;; *) echo 'Use mysql:8.0 or mysql:8.4' >&2; exit 1;; esac
container="nc1-isolated-$$"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker run --rm -d --name "$container" -p 127.0.0.1:33381:3306 -e MYSQL_ROOT_PASSWORD=nc1-synthetic-only "$image" >/dev/null
ready=0
for i in $(seq 1 60); do
 if docker exec "$container" mysql -uroot -pnc1-synthetic-only -N -e "SELECT 1" >/dev/null 2>&1; then ready=1; break; fi
 sleep 1
done
[ "$ready" = 1 ] || { echo 'Isolated MySQL unavailable' >&2; exit 1; }
docker exec "$container" mysql -uroot -pnc1-synthetic-only -N -e 'SELECT VERSION()'
NC1_ISOLATED_QA=1 node --test scripts/qa/nc1-identity.test.js scripts/qa/nc1-identity-mysql.test.js scripts/qa/nc1-patient-flows.test.js scripts/qa/nc1-professional-flow.test.js scripts/qa/nc1-installation.test.js
