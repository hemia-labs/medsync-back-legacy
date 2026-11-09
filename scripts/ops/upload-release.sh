#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${VPS_HOST:?}" "${VPS_USER:?}" "${VPS_SSH_KEY:?}" "${VPS_KNOWN_HOSTS:?}" "${VPS_APP_DIR:?}" "${RELEASE_ID:?}" "${APP_PORT:?}" "${RUNNER_TEMP:?}"
port="${VPS_PORT:-22}"
[[ "$port" =~ ^[0-9]+$ && "$APP_PORT" =~ ^[0-9]+$ && "$RELEASE_ID" =~ ^[0-9]+-[0-9]+$ ]] || exit 1
[[ "$VPS_HOST" =~ ^[a-zA-Z0-9.-]+$ && "$VPS_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || exit 1
[[ "$VPS_APP_DIR" =~ ^/[a-zA-Z0-9_./-]+$ && "$VPS_APP_DIR" != / && "$VPS_APP_DIR" != *'/../'* && "$VPS_APP_DIR" != */.. ]] || exit 1
key="$RUNNER_TEMP/medsync-deploy-key-$RELEASE_ID"
known="$RUNNER_TEMP/medsync-known-hosts-$RELEASE_ID"
bundle="$RUNNER_TEMP/medsync-release-$RELEASE_ID.tgz"
trap 'rm -f -- "$key" "$known" "$bundle"' EXIT
printf '%s\n' "$VPS_SSH_KEY" > "$key"
printf '%s\n' "$VPS_KNOWN_HOSTS" > "$known"
chmod 600 "$key" "$known"
unset VPS_SSH_KEY VPS_KNOWN_HOSTS
options=(-i "$key" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$known" -o ConnectTimeout=15)
target="$VPS_USER@$VPS_HOST"
destination="$VPS_APP_DIR/releases/$RELEASE_ID"
env_source="${RELEASE_ENV_SOURCE:-bundle}"
files=(src scripts/ops/activate-release.sh package.json package-lock.json ecosystem.config.cjs)
case "$env_source" in
  bundle) files+=(.env) ;;
  server|production) ;;
  *) exit 1 ;;
esac
tar -czf "$bundle" "${files[@]}"
ssh "${options[@]}" -p "$port" "$target" "mkdir -p -- '$destination'"
scp "${options[@]}" -P "$port" "$bundle" "$target:$destination/release.tgz"
ssh "${options[@]}" -p "$port" "$target" "set -eu; tar -xzf '$destination/release.tgz' -C '$destination'; rm -f -- '$destination/release.tgz'; VPS_APP_DIR='$VPS_APP_DIR' RELEASE_ID='$RELEASE_ID' APP_PORT='$APP_PORT' RELEASE_ENV_SOURCE='$env_source' bash '$destination/scripts/ops/activate-release.sh'"
