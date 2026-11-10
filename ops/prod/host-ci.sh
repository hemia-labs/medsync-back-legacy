#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

command="${SSH_ORIGINAL_COMMAND:-}"
if [[ ! "$command" =~ ^deploy\ (sha256:[a-f0-9]{64})\ ([a-f0-9]{40})$ ]]; then
    echo 'Expected deploy sha256:<digest> <release commit>.' >&2
    exit 2
fi
digest="${BASH_REMATCH[1]}"
revision="${BASH_REMATCH[2]}"
root=/srv/medsync-prod
bash "$root/ci/deploy.sh" preflight "$digest"
image="registry.hemia.cloud/medsync/prod-backend@$digest"
actual="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")"
[[ "$actual" == "$revision" ]] || { echo 'Image and release commit differ.' >&2; exit 1; }
exec bash "$root/ci/deploy.sh" deploy "$digest"
