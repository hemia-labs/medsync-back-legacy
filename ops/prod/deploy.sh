#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

root=/srv/medsync-prod
legacy=/srv/medsync/backend
repository=registry.hemia.cloud/medsync/prod-backend
export DOCKER_CONFIG="$root/docker"
export MEDSYNC_PROD_ENV_FILE="$root/prod.env"
[[ "$EUID" == 0 && -f "$MEDSYNC_PROD_ENV_FILE" && ! -L "$MEDSYNC_PROD_ENV_FILE" &&
   "$(stat -c '%u:%a' "$MEDSYNC_PROD_ENV_FILE")" == 0:600 ]] || {
    echo 'Run as root with a root-owned prod.env (mode 600).' >&2
    exit 1
}

exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another production deployment is running.' >&2; exit 1; }
history="$root/images"
pending="$root/images.next"
trap 'rm -f -- "$pending"' EXIT

valid_digest() { [[ "$1" =~ ^sha256:[a-f0-9]{64}$ ]]; }
is_pm2() { [[ "$1" =~ ^pm2:[0-9]+-[0-9]+$ ]]; }
valid_release() {
    is_pm2 "$1" || { [[ "$1" == "$repository@"* ]] && valid_digest "${1#*@}"; }
}
compose() {
    local image="$1"
    shift
    MEDSYNC_PROD_IMAGE="$image" docker compose --env-file /dev/null \
        --project-name medsync-prod --file "$(dirname "$0")/compose.yml" "$@"
}
pm2() {
    local binary
    binary="$(find /home/medsync-deploy/.nvm/versions/node -path '*/v22.*/bin/pm2' -print | sort -V | tail -1)"
    [[ -x "$binary" && -x "${binary%/*}/node" ]] || return 1
    runuser -u medsync-deploy -- env PATH="${binary%/*}:/usr/bin:/bin" "$binary" "$@"
}
ready() {
    local release="${1#pm2:}" url
    for url in http://127.0.0.1:3009/readyz https://api.medsync.mx/readyz; do
        curl --noproxy '*' --resolve api.medsync.mx:443:127.0.0.1 -fsS --max-time 6 "$url" |
            python3 -c 'import json, sys; data=json.load(sys.stdin); sys.exit(not (data.get("ready") is True and data.get("release") == sys.argv[1]))' "$release" || return 1
    done
}
wait_ready() {
    local attempt
    for attempt in {1..15}; do
        if ready "$1"; then return 0; fi
        sleep 2
    done
    return 1
}
activate() {
    local target="$1" replaced="$2" directory
    if is_pm2 "$target"; then
        directory="$legacy/releases/${target#pm2:}"
        [[ -f "$directory/ecosystem.config.cjs" && ! -L "$directory" ]] || return 1
        if ! is_pm2 "$replaced"; then compose "$replaced" stop api || return 1; fi
        if ! ready "$target"; then
            if pm2 describe medsync-back-legacy >/dev/null 2>&1; then
                pm2 delete medsync-back-legacy || return 1
            fi
            (cd "$directory" && export APP_RELEASE_ID="${target#pm2:}" &&
                pm2 start ecosystem.config.cjs --only medsync-back-legacy --update-env) || return 1
        fi
        pm2 save --force || return 1
        wait_ready "$target"
    else
        if is_pm2 "$replaced"; then
            if pm2 describe medsync-back-legacy >/dev/null 2>&1; then
                pm2 delete medsync-back-legacy || return 1
            fi
            pm2 save --force || return 1
        fi
        compose "$target" up --detach --no-deps --pull never --wait --wait-timeout 85 api &&
            wait_ready "$target"
    fi
}

previous=
if [[ -f "$history" ]]; then
    mapfile -t saved < "$history"
    [[ "${#saved[@]}" == 2 ]] || { echo 'Invalid production history.' >&2; exit 1; }
    current="${saved[0]}"
    previous="${saved[1]}"
    valid_release "$previous" || exit 1
else
    directory="$(readlink -f "$legacy/current")"
    [[ "$directory" == "$legacy/releases/"* && -f "$directory/ecosystem.config.cjs" ]] || exit 1
    current="pm2:${directory##*/}"
fi
valid_release "$current" || { echo 'Invalid active release in production history.' >&2; exit 1; }

case "${1:-}" in
    preflight|deploy)
        [[ "$#" == 2 ]] && valid_digest "$2" || { echo 'Expected sha256:<digest>.' >&2; exit 2; }
        ready "$current" || { echo 'The recorded production release is not healthy.' >&2; exit 1; }
        if is_pm2 "$current"; then pm2 describe medsync-back-legacy >/dev/null; fi
        candidate="$repository@$2"
        compose "$candidate" config --quiet
        docker image inspect "$candidate" >/dev/null 2>&1 || docker pull "$candidate"
        if [[ "$1" == preflight ]]; then printf 'PROD_PREFLIGHT_IMAGE=%s\n' "$candidate"; exit 0; fi
        ;;
    rollback)
        [[ "$#" == 1 && -n "$previous" ]] || { echo 'No previous production release.' >&2; exit 2; }
        candidate="$previous"
        if ! is_pm2 "$candidate"; then docker image inspect "$candidate" >/dev/null; fi
        ;;
    *) echo 'Usage: deploy.sh {preflight|deploy} sha256:<digest> | rollback' >&2; exit 2 ;;
esac
if [[ "$candidate" == "$current" ]]; then printf 'PROD_ACTIVE_RELEASE=%s\n' "$current"; exit 0; fi
if [[ "$1" == deploy ]] && ! is_pm2 "$current"; then docker image inspect "$current" >/dev/null; fi
printf '%s\n%s\n' "$candidate" "$current" > "$pending"

restore() {
    if activate "$current" "$candidate"; then
        printf 'Restored %s\n' "$current" >&2
    else
        printf 'Could not restore %s; check production immediately.\n' "$current" >&2
        return 1
    fi
}
trap 'trap "" INT TERM; restore || true; exit 130' INT TERM
if activate "$candidate" "$current" && mv -f -- "$pending" "$history"; then
    trap - INT TERM
    printf 'PROD_ACTIVE_RELEASE=%s\n' "$candidate"
else
    restore || true
    exit 1
fi
