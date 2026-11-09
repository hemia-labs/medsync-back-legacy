#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

root=/srv/medsync-qa
legacy=/srv/medsync/backend
export MEDSYNC_QA_STATE_DIR="$root/state"
export MEDSYNC_QA_ENV_FILE="$root/runtime.env"
export DOCKER_CONFIG="$root/docker"
cd "$root/ci"
exec 9>"$root/ci.lock"
flock -n 9 || { echo 'A QA operation is already running.' >&2; exit 1; }

command="${SSH_ORIGINAL_COMMAND:-}"
if [[ "$command" == rollback ]]; then
    bash deploy.sh rollback
elif [[ "$command" =~ ^deploy\ (sha256:[a-f0-9]{64})$ ]]; then
    image="registry.hemia.cloud/medsync/qa-backend@${BASH_REMATCH[1]}"
    if [[ ! -s "$MEDSYNC_QA_STATE_DIR/images" ]]; then
        bash cutover.sh "$image"
    else
        bash deploy.sh "$image"
    fi
else
    echo 'Allowed commands: deploy sha256:<digest> or rollback.' >&2
    exit 2
fi

read -r active < "$MEDSYNC_QA_STATE_DIR/images"
printf 'QA_RESULT_IMAGE=%s\n' "$active"
