#!/usr/bin/env bash
set -Eeuo pipefail
: "${VPS_APP_DIR:?}" "${RELEASE_ID:?}" "${APP_PORT:?}"
[[ "$VPS_APP_DIR" == /* && "$VPS_APP_DIR" != / && "$RELEASE_ID" =~ ^[0-9]+-[0-9]+$ ]] || exit 1
root="$(realpath "$VPS_APP_DIR")"
release="$root/releases/$RELEASE_ID"
[[ -d "$release/src" && ! -L "$release" ]] || exit 1
env_source="${RELEASE_ENV_SOURCE:-bundle}"
case "$env_source" in
  bundle) [[ -f "$release/.env" ]] || exit 1 ;;
  server|production)
    env_file="$root/shared/qa.env"
    if [[ "$env_source" == production ]]; then env_file="$root/shared/.env.production"; fi
    if [[ ! -f "$env_file" || -L "$env_file" || ! -O "$env_file" || "$(stat -c %a "$env_file")" != 600 ]]; then
      echo 'Shared environment must be a regular file owned by the deploy user with mode 600.' >&2
      exit 1
    fi
    ln -s "$env_file" "$release/.env"
    ;;
  *) exit 1 ;;
esac
previous="$(readlink -f "$root/current" || true)"
if [[ ! -f "$previous/ecosystem.config.cjs" ]]; then previous="$root"; fi

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[[ ! -s "$NVM_DIR/nvm.sh" ]] || source "$NVM_DIR/nvm.sh"
nvm use 22
cd "$release"
if [[ "$env_source" == bundle ]]; then chmod 600 .env; fi
if [[ "$env_source" == production ]]; then
  node <<'NODE'
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const env = parseEnv(fs.readFileSync('.env', 'utf8'));
const required = [
  'PORT', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
  'JWT_SECRET', 'REFRESH_TOKEN_SECRET', 'PASSWORD_RESET_CODE_SECRET', 'CORS_ALLOWED_ORIGINS',
];
const missing = required.filter(key => !env[key]?.trim());
if (missing.length) {
  console.error('Missing production environment keys: ' + missing.join(', '));
  process.exit(1);
}
if (env.NODE_ENV !== 'production') {
  console.error('The shared environment must set NODE_ENV=production.');
  process.exit(1);
}
NODE
fi
npm ci --omit=dev
command -v pm2 >/dev/null

# Keep runtime files outside releases; preserve legacy files on the first move.
mkdir -p "$root/shared/logs" "$root/shared/tempFolder"
for item in logs src/tempFolder; do
  destination="$root/shared/$(basename "$item")"
  if [[ -d "$root/$item" && ! -L "$root/$item" ]]; then cp -an "$root/$item/." "$destination/"; fi
  if [[ -d "$release/$item" && ! -L "$release/$item" ]]; then
    cp -an "$release/$item/." "$destination/"
    mv "$release/$item" "$release/$(basename "$item").packaged"
  fi
  ln -s "$destination" "$release/$item"
done

activate_link() {
  ln -s "$1" "$root/current.$RELEASE_ID.tmp"
  mv -Tf "$root/current.$RELEASE_ID.tmp" "$root/current"
}
start_release() {
  cd "$1"
  export APP_RELEASE_ID="$(basename "$1")"
  # Reload keeps PM2's old absolute script/cwd. Recreate only this app so
  # both activation and rollback resolve paths from the selected ecosystem.
  if pm2 describe medsync-back-legacy >/dev/null 2>&1; then
    pm2 delete medsync-back-legacy
  fi
  pm2 start ecosystem.config.cjs --update-env
}
rollback() {
  trap - ERR
  if [[ -f "$previous/ecosystem.config.cjs" ]]; then
    activate_link "$previous"
    start_release "$previous"
    pm2 save
    echo 'Previous release restored; verify its availability before retrying.'
  else
    echo 'No previous release exists. Candidate retained for diagnosis.'
  fi
  exit 1
}
trap rollback ERR
activate_link "$release"
export APP_RELEASE_ID="$RELEASE_ID"
start_release "$release"
for attempt in {1..15}; do
  if curl --max-time 4 -fsS "http://127.0.0.1:$APP_PORT/readyz" | node -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>{try{const r=JSON.parse(s);process.exit(r.ready===true&&r.release===process.env.APP_RELEASE_ID?0:1)}catch(_){process.exit(1)}})'; then
    pm2 save
    trap - ERR
    echo 'Candidate ready; previous release retained.'
    exit 0
  fi
  sleep 2
done
false # ERR trap restores the previous release after a failed readiness check.
