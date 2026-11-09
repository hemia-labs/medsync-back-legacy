#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
run_id="medsync-registration-http-$$"
socket_dir="/private/tmp/$run_id"
cleanup() {
  docker rm -f "$run_id-node" "$run_id-mysql" >/dev/null 2>&1 || true
  docker volume rm "$run_id-data" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker volume create --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=512m,mode=1777 "$run_id-data" >/dev/null
docker run -d --name "$run_id-mysql" --network none --read-only --cpus 1 --memory 1g --pids-limit 128 \
  --ulimit nofile=1024:1024 --ulimit fsize=268435456:268435456 \
  --tmpfs /tmp:size=32m --tmpfs /var/run/mysqld:size=8m \
  --mount "type=volume,src=$run_id-data,dst=$socket_dir" \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=yes mysql:8.4 \
  --datadir="$socket_dir/data" --socket="$socket_dir/mysql.sock" --skip-networking \
  --mysqlx=OFF --innodb-buffer-pool-size=64M --innodb-redo-log-capacity=64M >/dev/null
ready=false
for attempt in {1..90}; do
  # The entrypoint's temporary initialization server also answers ping.
  if docker exec "$run_id-mysql" sh -c 'test "$(cat /proc/1/comm)" = mysqld' >/dev/null 2>&1 \
    && docker exec "$run_id-mysql" mysqladmin --socket="$socket_dir/mysql.sock" -uroot ping --silent >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then docker logs --tail 20 "$run_id-mysql"; exit 1; fi
docker run --name "$run_id-node" --network none --read-only --cpus 1 --memory 384m --pids-limit 64 \
  --cap-drop ALL --security-opt no-new-privileges --ulimit nofile=128:128 --ulimit cpu=180:180 \
  --ulimit fsize=1048576:1048576 --tmpfs /tmp:size=32m --workdir /work \
  --mount "type=volume,src=$run_id-data,dst=$socket_dir" \
  --mount "type=bind,src=$repo/src,dst=/work/src,readonly" \
  --mount "type=bind,src=$repo/scripts,dst=/work/scripts,readonly" \
  --mount "type=bind,src=$repo/node_modules,dst=/work/node_modules,readonly" \
  -e NODE_ENV=test -e APP_ENV=test -e DB_NAME=synthetic_unused -e DB_USER=root \
  -e REGISTRATION_QA_ISOLATED=1 -e "REGISTRATION_QA_SOCKET=$socket_dir/mysql.sock" \
  node:22-bookworm-slim sh -c 'node --version && timeout 120s node --max-old-space-size=128 scripts/qa/s24-registration-http-mysql.js && timeout 60s node --max-old-space-size=128 scripts/qa/account-legal-confirmation-mysql.js && timeout 30s node scripts/qa/account-legal-regression.js && timeout 30s node scripts/qa/saas-legal-regression.js && timeout 90s node --max-old-space-size=128 scripts/qa/registration-email-trial-mysql.js && timeout 30s node scripts/qa/registration-recovery-regression.js && timeout 30s node scripts/qa/registration-plans-regression.js'
