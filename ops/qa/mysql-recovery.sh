#!/usr/bin/env bash
set -euo pipefail
umask 077

mode="${1:-}"
options="${2:-}"
schema="${3:-}"
path="${4:-}"
if [[ $# != 4 || ! -f "$options" || "$options" != /* || ! "$schema" =~ ^[A-Za-z0-9_]+$ || ! -d "$path" ]]; then
    echo 'Usage: mysql-recovery.sh backup|restore /absolute/client.cnf schema directory' >&2
    exit 2
fi
case "$schema" in mysql|sys|information_schema|performance_schema) exit 2 ;; esac

mysql_query() { mysql --defaults-file="$options" --batch --skip-column-names --execute "$1"; }
server_id="$(mysql_query 'SELECT @@server_uuid')"
[[ "$server_id" =~ ^[a-fA-F0-9-]{36}$ ]]
case "$mode" in
    backup)
        [[ "$(mysql_query 'SELECT @@log_bin')" == 1 ]] || { echo 'MySQL binary logging is required.' >&2; exit 1; }
        read -r charset collation <<< "$(mysql_query "SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
            FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$schema'")"
        [[ "$charset" =~ ^[A-Za-z0-9_]+$ && "$collation" =~ ^[A-Za-z0-9_]+$ ]]
        # A staging directory cannot be mistaken for a completed backup.
        output="$(mktemp -d "$path/.mysql-qa-partial.XXXXXX")"
        trap 'rm -f -- "$output"/dump.sql.gz "$output"/manifest "$output"/SHA256SUMS; rmdir -- "$output" 2>/dev/null || true' EXIT
        mysqldump --defaults-file="$options" --single-transaction --quick --source-data=2 \
            --set-gtid-purged=OFF --no-tablespaces --routines --triggers --events --hex-blob "$schema" | gzip -c > "$output/dump.sql.gz"
        gzip -t "$output/dump.sql.gz"
        printf '%s\n' "$schema" "$server_id" "$charset" "$collation" > "$output/manifest"
        (cd "$output" && sha256sum dump.sql.gz manifest > SHA256SUMS)
        suffix="${output##*.}"
        complete="$path/mysql-qa-$(date -u +%Y%m%dT%H%M%SZ)-$suffix"
        mv -- "$output" "$complete"
        trap - EXIT
        printf '%s\n' "$complete"
        ;;
    restore)
        {
            read -r saved_schema
            read -r source_id
            read -r charset
            read -r collation
        } < "$path/manifest"
        [[ "$schema" == "$saved_schema" && "$source_id" =~ ^[a-fA-F0-9-]{36}$ && "$server_id" != "$source_id" ]] ||
            { echo 'Restore requires the original schema name on a different MySQL server.' >&2; exit 1; }
        [[ "$charset" =~ ^[A-Za-z0-9_]+$ && "$collation" =~ ^[A-Za-z0-9_]+$ ]]
        [[ "$(mysql_query 'SELECT @@event_scheduler')" != ON ]] || { echo 'Disable the destination event scheduler first.' >&2; exit 1; }
        (cd "$path" && sha256sum -c SHA256SUMS)
        # CREATE without IF NOT EXISTS prevents writing over an existing schema.
        mysql_query "CREATE DATABASE \`$schema\` CHARACTER SET $charset COLLATE $collation"
        gzip -dc "$path/dump.sql.gz" | mysql --defaults-file="$options" "$schema"
        echo 'Snapshot restored. Validate the isolated target before replay or cutover.'
        ;;
    *) echo 'Use backup or restore.' >&2; exit 2 ;;
esac
