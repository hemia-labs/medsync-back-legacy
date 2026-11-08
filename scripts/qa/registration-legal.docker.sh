#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
container="medsync-registration-legal-test-$$"
trap 'docker stop "$container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$container" -p 127.0.0.1::3306 -e MYSQL_ROOT_PASSWORD=isolated-test-only -e MYSQL_DATABASE=medsync_legal_test mysql:8.4 >/dev/null
for attempt in {1..60}; do
 if docker exec "$container" mysqladmin ping -h127.0.0.1 -uroot -pisolated-test-only --silent >/dev/null 2>&1; then break; fi
 sleep 1
done
S26_QA_ISOLATED=1 S26_QA_PORT="$(docker port "$container" 3306 | awk -F: '{print $NF}')" node scripts/qa/registration-legal-mysql.js
