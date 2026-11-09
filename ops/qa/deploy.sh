#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${MEDSYNC_QA_STATE_DIR:?absolute QA state directory required}"
: "${MEDSYNC_QA_ENV_FILE:?absolute QA environment file required}"
[[ "$MEDSYNC_QA_STATE_DIR" == /* && "$MEDSYNC_QA_ENV_FILE" == /* && -f "$MEDSYNC_QA_ENV_FILE" ]]
compose_file="$(dirname "$0")/compose.yml"
state="$MEDSYNC_QA_STATE_DIR/images"
next="$MEDSYNC_QA_STATE_DIR/images.next"
mkdir -p -- "$MEDSYNC_QA_STATE_DIR"
lock="$MEDSYNC_QA_STATE_DIR/deploy.lock"
mkdir -- "$lock" || { echo 'A QA deployment already holds the lock.' >&2; exit 1; }
trap 'rm -f -- "$next"; rmdir -- "$lock"' EXIT

valid_image() {
    [[ "$1" =~ ^[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64}$ ]] ||
        [[ "${MEDSYNC_QA_LOCAL_TEST:-0}" == 1 && "$1" =~ ^sha256:[a-f0-9]{64}$ ]]
}
history=()
if [[ -f "$state" ]]; then
    while IFS= read -r ref; do
        valid_image "$ref" || { echo 'Invalid QA image history.' >&2; exit 1; }
        history+=("$ref")
    done < "$state"
fi
current="${history[0]:-}"
candidate="${1:-}"
if [[ "$candidate" == rollback ]]; then candidate="${history[1]:-}"; fi
valid_image "$candidate" || { echo 'Pass an image digest or rollback with saved history.' >&2; exit 2; }

compose() {
    local image="$1"
    shift
    MEDSYNC_QA_IMAGE="$image" docker compose --env-file /dev/null --project-name medsync-qa --file "$compose_file" "$@"
}
activate() {
    compose "$1" up --detach --no-deps --pull never --wait --wait-timeout 85 api
}
probe() {
    local url="http://127.0.0.1:3009/readyz"
    local response
    response="$(curl --noproxy '*' --fail --silent --show-error --max-time 5 "$url")" || return 1
    # Docker's health check already parses the JSON. Verify the published port too.
    [[ "$response" == "{\"ready\":true,\"release\":\"$1\"}" ]] || return 1
    if [[ "${MEDSYNC_QA_LOCAL_TEST:-0}" != 1 ]]; then
        curl --noproxy '*' --fail --silent --show-error --max-time 8 \
            --resolve api-test.medsync.mx:443:127.0.0.1 https://api-test.medsync.mx/readyz |
            jq -e --arg image "$1" '.ready == true and .release == $image' >/dev/null
    fi
}
restore_previous() {
    if [[ -n "$current" ]]; then
        if activate "$current" && probe "$current"; then
            echo "Restored $current" >&2
        else
            echo "Rollback failed for $current. Investigate QA immediately." >&2
            return 1
        fi
    else
        compose "$candidate" rm --stop --force api || return 1
        echo 'Removed the failed first container. No previous image was recorded.' >&2
    fi
    for ref in ${history[@]+"${history[@]}"}; do
        if [[ "$ref" == "$candidate" ]]; then return 0; fi
    done
    docker image rm "$candidate" >/dev/null || echo "Could not remove failed image $candidate" >&2
}

if [[ -n "$current" ]]; then docker image inspect "$current" >/dev/null || docker pull "$current"; fi
docker image inspect "$candidate" >/dev/null 2>&1 || docker pull "$candidate"
keep=("$candidate")
for ref in ${history[@]+"${history[@]}"}; do
    if [[ "$ref" != "$candidate" && "${#keep[@]}" -lt 3 ]]; then keep+=("$ref"); fi
done
printf '%s\n' "${keep[@]}" > "$next"
trap 'restore_previous || true; exit 130' INT TERM
if activate "$candidate" && probe "$candidate" && mv -f -- "$next" "$state"; then
    trap - INT TERM
    echo "QA ready on $candidate"
else
    restore_previous || true
    exit 1
fi

for ref in ${history[@]+"${history[@]}"}; do
    retained=false
    for image in "${keep[@]}"; do
        if [[ "$ref" == "$image" ]]; then retained=true; break; fi
    done
    if [[ "$retained" == false ]]; then
        docker image rm "$ref" >/dev/null || echo "Could not remove old image $ref" >&2
    fi
done
