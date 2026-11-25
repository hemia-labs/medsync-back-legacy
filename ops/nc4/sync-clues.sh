#!/bin/sh
set -eu

case "${1:-}" in
    qa|prod) project="medsync-$1" ;;
    *) echo 'Se requiere el ambiente qa o prod.' >&2; exit 1 ;;
esac

run() {
    ids=$(docker ps --filter "label=com.docker.compose.project=$project" \
        --filter 'label=com.docker.compose.service=api' --format '{{.ID}}') || return 75
    # Separamos los identificadores hexadecimales que Docker emite por línea.
    # shellcheck disable=SC2086
    set -- $ids
    case "$#" in
        0) echo "API de $project sin contenedor activo." >&2; return 75 ;;
        1) docker exec "$1" node src/jobs/syncClues.js ;;
        *) echo "Hay varias API activas en $project; revisa el despliegue." >&2; return 1 ;;
    esac
}

run && exit 0
result=$?
if [ "$result" -ne 75 ]; then exit "$result"; fi
echo "Fallo temporal en $project. Se hará un segundo intento en cinco minutos." >&2
sleep 300
run
