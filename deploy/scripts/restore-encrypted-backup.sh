#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C
umask 077

backup_dir='/opt/salary-settlement-admin/backups'
key_file='/etc/salary-settlement-admin/backup-file-encryption.key'
crypto_tool='/usr/local/libexec/salary-settlement-admin/backup-file-crypto.mjs'
database_helper='/usr/local/libexec/salary-settlement-admin/record-backup-evidence-db.cjs'
api_container='salary-settlement-admin-api-1'
postgres_image='postgres:16'
bootstrap_role='task90_bootstrap'
bootstrap_database='postgres'

container_name=''
volume_name=''
drill_id=''
restore_log=''
container_created=0
volume_created=0

fail() {
  echo "RESTORE_DRILL_STATUS=failed"
  echo "RESTORE_DRILL_ERROR=$1" >&2
  exit 1
}

cleanup_resources() {
  local cleanup_exit=0
  if [[ "$container_created" -eq 1 ]]; then
    [[ "$container_name" =~ ^task90-restore-[0-9]{8}T[0-9]{6}Z-container$ ]] || return 1
    [[ "$(docker inspect "$container_name" --format '{{index .Config.Labels "task90.restore"}} {{index .Config.Labels "task90.drill"}}' 2>/dev/null)" == "true $drill_id" ]] ||
      return 1
    docker rm -f "$container_name" >/dev/null || cleanup_exit=1
    container_created=0
  fi
  if [[ "$volume_created" -eq 1 ]]; then
    [[ "$volume_name" =~ ^task90-restore-[0-9]{8}T[0-9]{6}Z-volume$ ]] || return 1
    [[ "$(docker volume inspect "$volume_name" --format '{{index .Labels "task90.restore"}} {{index .Labels "task90.drill"}}' 2>/dev/null)" == "true $drill_id" ]] ||
      return 1
    docker volume rm "$volume_name" >/dev/null || cleanup_exit=1
    volume_created=0
  fi
  return "$cleanup_exit"
}

on_exit() {
  local exit_code=$?
  set +e
  cleanup_resources
  local cleanup_exit=$?
  [[ -z "$restore_log" || ! -e "$restore_log" ]] || rm -f -- "$restore_log"
  set -e
  if [[ "$cleanup_exit" -ne 0 ]]; then
    echo 'RESTORE_DRILL_CLEANUP=failed' >&2
    exit 1
  fi
  exit "$exit_code"
}
trap on_exit EXIT

if [[ "${1:-}" == '--self-test' ]]; then
  [[ "$#" -eq 1 ]]
  [[ 'task90-restore-20260727T120000Z-container' =~ ^task90-restore-[0-9]{8}T[0-9]{6}Z-container$ ]]
  [[ 'task90-restore-20260727T120000Z-volume' =~ ^task90-restore-[0-9]{8}T[0-9]{6}Z-volume$ ]]
  [[ "$bootstrap_role" =~ ^[a-z][a-z0-9_]{0,62}$ ]]
  [[ "$bootstrap_database" =~ ^[a-z][a-z0-9_]{0,62}$ ]]
  echo 'RESTORE_ENCRYPTED_BACKUP_SELF_TEST=pass'
  exit 0
fi

[[ "$#" -eq 1 ]] || fail invalid_arguments
[[ "$EUID" -eq 0 ]] || fail requires_root
backup_path="$1"
[[ "$backup_path" == /* && ! -L "$backup_path" && -f "$backup_path" ]] || fail backup_path_invalid
backup_path="$(realpath -e -- "$backup_path")"
[[ "$(dirname -- "$backup_path")" == "$backup_dir" ]] || fail backup_directory_mismatch
backup_name="$(basename -- "$backup_path")"
[[ "$backup_name" =~ ^postgres-full-[0-9]{8}T[0-9]{6}Z\.sql\.gz\.enc$ ]] || fail backup_name_invalid
[[ "$(stat -c '%U:%G:%a' "$backup_path")" == 'root:postgres:640' ]] || fail backup_permissions_invalid
sidecar="${backup_path}.sha256"
[[ ! -L "$sidecar" && -f "$sidecar" ]] || fail sidecar_invalid
(cd "$backup_dir" && sha256sum -c --status "$(basename -- "$sidecar")") || fail checksum_mismatch

[[ "$(stat -c '%U:%G:%a' "$key_file")" == 'root:root:600' ]] || fail key_permissions_invalid
docker image inspect "$postgres_image" >/dev/null 2>&1 || fail postgres_image_missing
docker inspect "$api_container" --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' |
  grep -qx 'true healthy' || fail api_container_not_healthy

node "$crypto_tool" decrypt --key-file "$key_file" --input "$backup_path" --output - |
  gzip -t
echo 'RESTORE_SOURCE_CHECKSUM=match'
echo 'RESTORE_DECRYPT_AUTHENTICATION=pass'
echo 'RESTORE_GZIP_INTEGRITY=pass'

drill_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
drill_start_epoch="$(date +%s)"
drill_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
drill_id="task90-restore-${drill_stamp}"
container_name="${drill_id}-container"
volume_name="${drill_id}-volume"
restore_log="$(mktemp "/run/${drill_id}.restore.XXXXXX.log")"
chmod 0600 "$restore_log"

docker volume create \
  --label task90.restore=true \
  --label "task90.drill=$drill_id" \
  "$volume_name" >/dev/null
volume_created=1

docker run -d \
  --name "$container_name" \
  --network none \
  --label task90.restore=true \
  --label "task90.drill=$drill_id" \
  --mount "type=volume,src=$volume_name,dst=/var/lib/postgresql/data" \
  -e "POSTGRES_USER=$bootstrap_role" \
  -e "POSTGRES_DB=$bootstrap_database" \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$postgres_image" >/dev/null
container_created=1

[[ "$(docker inspect "$container_name" --format '{{.HostConfig.NetworkMode}}')" == 'none' ]] ||
  fail network_mode_not_none
port_bindings="$(docker inspect "$container_name" --format '{{json .HostConfig.PortBindings}}')"
[[ "$port_bindings" == 'null' || "$port_bindings" == '{}' ]] || fail host_port_binding_present

ready=0
for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready \
    -U "$bootstrap_role" -d "$bootstrap_database" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" -eq 1 ]] || fail isolated_postgres_not_ready

set +e
{
  printf '\\set VERBOSITY sqlstate\n'
  node "$crypto_tool" decrypt --key-file "$key_file" --input "$backup_path" --output - |
    gzip -dc
} |
  docker exec -i "$container_name" psql -X -q -v ON_ERROR_STOP=1 \
    -U "$bootstrap_role" -d "$bootstrap_database" \
    >"$restore_log" 2>&1
restore_exit=$?
set -e
if [[ "$restore_exit" -ne 0 ]]; then
  restore_sqlstate_codes="$(
    sed -nE 's/^ERROR:[[:space:]]+([0-9A-Z]{5})$/\1/p' "$restore_log" |
      sort -u |
      paste -sd, -
  )"
  echo "RESTORE_DRILL_SQLSTATE_CODES=${restore_sqlstate_codes:-unavailable}"
  fail isolated_restore_failed
fi
rm -f -- "$restore_log"
restore_log=''

server_version="$(docker exec "$container_name" psql -X -Aqt \
  -U "$bootstrap_role" -d "$bootstrap_database" -c 'SHOW server_version_num')"
[[ "$server_version" =~ ^16[0-9]+$ ]] || fail restored_version_invalid
database_count="$(docker exec "$container_name" psql -X -Aqt \
  -U "$bootstrap_role" -d "$bootstrap_database" -c \
  "SELECT count(*) FROM pg_database WHERE NOT datistemplate")"
role_count="$(docker exec "$container_name" psql -X -Aqt \
  -U "$bootstrap_role" -d "$bootstrap_database" -c \
  "SELECT count(*) FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> '$bootstrap_role'")"
[[ "$database_count" =~ ^[0-9]+$ && "$role_count" =~ ^[0-9]+$ ]] || fail restored_counts_invalid

schema_count=0
table_count=0
migration_count=0
while IFS= read -r database_name; do
  [[ -n "$database_name" ]] || continue
  database_schema_count="$(docker exec "$container_name" psql -X -Aqt \
    -U "$bootstrap_role" -d "$database_name" -c \
    "SELECT count(*) FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'")"
  database_table_count="$(docker exec "$container_name" psql -X -Aqt \
    -U "$bootstrap_role" -d "$database_name" -c \
    "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'")"
  migration_table="$(docker exec "$container_name" psql -X -Aqt \
    -U "$bootstrap_role" -d "$database_name" -c \
    "SELECT COALESCE(to_regclass('public._prisma_migrations')::text, '')")"
  if [[ -n "$migration_table" ]]; then
    database_migration_count="$(docker exec "$container_name" psql -X -Aqt \
      -U "$bootstrap_role" -d "$database_name" -c \
      "SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")"
  else
    database_migration_count=0
  fi
  [[ "$database_schema_count" =~ ^[0-9]+$ && "$database_table_count" =~ ^[0-9]+$ && "$database_migration_count" =~ ^[0-9]+$ ]] ||
    fail restored_counts_invalid
  schema_count=$((schema_count + database_schema_count))
  table_count=$((table_count + database_table_count))
  migration_count=$((migration_count + database_migration_count))
done < <(
  docker exec "$container_name" psql -X -Aqt \
    -U "$bootstrap_role" -d "$bootstrap_database" -c \
    "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname"
)

cleanup_resources || fail cleanup_failed
[[ -z "$(docker ps -a --filter "label=task90.drill=$drill_id" --format '{{.Names}}')" ]] ||
  fail container_cleanup_incomplete
[[ -z "$(docker volume ls --filter "label=task90.drill=$drill_id" --format '{{.Name}}')" ]] ||
  fail volume_cleanup_incomplete

drill_completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
drill_duration_seconds="$(($(date +%s) - drill_start_epoch))"

set +e
database_output="$(
  docker exec -i "$api_container" node - drill \
    "$drill_id" "$backup_name" "$drill_started_at" "$drill_completed_at" \
    "$database_count" "$role_count" "$schema_count" "$table_count" "$migration_count" "$server_version" \
    <"$database_helper" 2>&1
)"
database_exit=$?
set -e
printf '%s\n' "$database_output"
[[ "$database_exit" -eq 0 ]] || fail drill_evidence_write_failed
grep -Eq '^EVIDENCE_SYNC_STATUS=(created|no_change)$' <<<"$database_output" ||
  fail drill_evidence_result_invalid

echo "RESTORE_DRILL_ID=$drill_id"
echo "RESTORE_SOURCE_BACKUP=$backup_name"
echo 'RESTORE_NETWORK_MODE=none'
echo 'RESTORE_HOST_PORT_BINDINGS=none'
echo 'RESTORE_DESTRUCTIVE_TO_PRIMARY=false'
echo 'RESTORE_PRODUCTION_DATABASE_CONTACTED=no'
echo "RESTORE_POSTGRES_VERSION=$server_version"
echo "RESTORE_DATABASE_COUNT=$database_count"
echo "RESTORE_ROLE_COUNT=$role_count"
echo "RESTORE_SCHEMA_COUNT=$schema_count"
echo "RESTORE_TABLE_COUNT=$table_count"
echo "RESTORE_MIGRATION_COUNT=$migration_count"
echo 'RESTORE_RESOURCE_CLEANUP=complete'
echo "RESTORE_DURATION_SECONDS=$drill_duration_seconds"
echo 'RESTORE_DRILL_STATUS=success'
