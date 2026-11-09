#!/usr/bin/env bash
set -euo pipefail

image="$1"
baseline='registry.hemia.cloud/medsync/qa-backend@sha256:eb4d37be8930c1719e73c2ad1f394229e4d4df331cdcb65043b0cf32a33f95a8'
legacy="$(realpath /srv/medsync/backend/current)"
name=medsync-back-legacy
pm2_bin="$(find /home/medsync-deploy/.nvm/versions/node -mindepth 3 -maxdepth 3 -path '*/v22.*/bin/pm2' -print | sort -V | tail -1)"
[[ -x "$pm2_bin" && -x "${pm2_bin%/*}/node" && "$legacy" == /srv/medsync/backend/releases/* && -r "$legacy/ecosystem.config.cjs" ]]

pm2_qa() {
    runuser -u medsync-deploy -- env PATH="$(dirname "$pm2_bin"):/usr/bin:/bin" \
        APP_RELEASE_ID="${legacy##*/}" "$pm2_bin" "$@"
}
legacy_ready() {
    curl --noproxy '*' -fsS --max-time 4 http://127.0.0.1:3009/readyz |
        jq -e --arg release "${legacy##*/}" '.ready == true and .release == $release' >/dev/null
}
recover_pm2() {
    trap - EXIT
    local status="$1"
    if MEDSYNC_QA_IMAGE="$baseline" docker compose --env-file /dev/null --project-name medsync-qa --file compose.yml rm --stop --force api &&
       rm -f -- "$MEDSYNC_QA_STATE_DIR/images"; then
        if pm2_qa describe "$name" >/dev/null 2>&1; then
            pm2_qa restart "$name" --update-env
        else
            pm2_qa start "$legacy/ecosystem.config.cjs" --only "$name" --update-env
        fi
        pm2_qa save --force
        for attempt in {1..20}; do
            if legacy_ready; then echo 'PM2 restored on 3009.' >&2; exit "$status"; fi
            sleep 2
        done
    fi
    echo 'Could not confirm PM2 recovery on 3009.' >&2
    exit 1
}

legacy_ready
pm2_qa jlist | jq -e --arg name "$name" '[.[] | select(.name == $name and .pm2_env.status == "online")] | length == 1' >/dev/null
MEDSYNC_QA_IMAGE="$baseline" docker compose --env-file /dev/null --project-name medsync-qa --file compose.yml config --quiet
for ref in "$baseline" "$image"; do
    docker image inspect "$ref" >/dev/null 2>&1 || docker pull "$ref"
done
trap 'recover_pm2 $?' EXIT
trap 'exit 130' HUP INT TERM
pm2_qa stop "$name"
bash deploy.sh "$baseline"
bash deploy.sh "$image"
bash deploy.sh rollback
[[ "$(head -1 "$MEDSYNC_QA_STATE_DIR/images")" == "$baseline" ]]
echo 'Verified QA image rollback on port 3009.'
bash deploy.sh "$image"
pm2_qa delete "$name"
pm2_qa save --force
trap - EXIT
