#!/usr/bin/env bash
set -euo pipefail

version="$(node -p "require('./package.json').version")"
flags=(--latest)

case "$GITHUB_REF_NAME" in
  develop)
    npm run changeset -- version
    next="$(node -p "require('./package.json').version")"
    if [[ "$version" == "$next" ]]; then
      echo "No hay Changesets pendientes para una prerelease."
      exit 0
    fi
    version="$next"
    tag="v${version}-rc.${GITHUB_RUN_NUMBER}"
    target="$GITHUB_SHA"
    flags=(--prerelease --latest=false)
    ;;
  main)
    [[ -f CHANGELOG.md ]] || exit 0
    tag="v${version}"
    # Busca el commit que introdujo la versión en main, incluso al reintentar después.
    target="$(git log --first-parent -1 --format=%H -S "\"version\": \"$version\"" -- package.json)"
    ;;
  *)
    echo "Rama de release inválida: $GITHUB_REF_NAME" >&2
    exit 1
    ;;
esac

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || -z "$target" ]]; then
  echo "Versión base o commit de release inválidos." >&2
  exit 1
fi

if existing="$(git rev-parse --verify --quiet "refs/tags/$tag^{commit}")"; then
  if [[ "$existing" != "$target" ]]; then
    echo "El tag $tag ya apunta a otro commit." >&2
    exit 1
  fi
  if gh release view "$tag" >/dev/null; then
    echo "La release $tag ya existe."
    exit 0
  fi
fi

notes="$(mktemp)"
trap 'rm -f -- "$notes"' EXIT
if [[ "$GITHUB_REF_NAME" == main ]]; then
  git show "$target:CHANGELOG.md"
else
  cat CHANGELOG.md
fi | awk -v heading="## $version" '
  $0 == heading { found = 1; next }
  /^## / { found = 0 }
  found { print }
' > "$notes"
if ! grep -q '[^[:space:]]' "$notes"; then
  echo "No hay notas en CHANGELOG.md para $version." >&2
  exit 1
fi

gh release create "$tag" --target "$target" --title "$tag" --notes-file "$notes" "${flags[@]}"
