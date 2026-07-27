#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C
umask 027

backup_dir='/opt/salary-settlement-admin/backups'
key_file='/etc/salary-settlement-admin/backup-file-encryption.key'
crypto_tool='/usr/local/libexec/salary-settlement-admin/backup-file-crypto.mjs'
database_helper='/usr/local/libexec/salary-settlement-admin/record-backup-evidence-db.cjs'
api_container='salary-settlement-admin-api-1'

fail() {
  echo "EVIDENCE_SYNC_STATUS=failed"
  echo "EVIDENCE_SYNC_ERROR=$1" >&2
  exit 1
}

backup_name_is_valid() {
  [[ "$1" =~ ^postgres-full-([0-9]{8}T[0-9]{6}Z)\.sql\.gz\.enc$ ]]
}

sidecar_matches() {
  local directory="$1"
  local backup="$2"
  local name="$3"
  local sidecar="${backup}.sha256"
  [[ ! -L "$sidecar" && -f "$sidecar" ]] || return 1
  local lines
  mapfile -t lines <"$sidecar"
  [[ "${#lines[@]}" -eq 1 ]] || return 1
  local expected_hash expected_name unexpected
  read -r expected_hash expected_name unexpected <<<"${lines[0]}"
  [[ -z "${unexpected:-}" ]] || return 1
  expected_name="${expected_name#\*}"
  [[ "$expected_hash" =~ ^[a-f0-9]{64}$ && "$expected_name" == "$name" ]] || return 1
  (cd "$directory" && sha256sum -c --status "$(basename -- "$sidecar")")
}

self_test() {
  backup_name_is_valid 'postgres-full-20260727T120000Z.sql.gz.enc'
  ! backup_name_is_valid 'postgres-full-20260727T120000Z.sql.gz'
  ! backup_name_is_valid '../postgres-full-20260727T120000Z.sql.gz.enc'
  ! backup_name_is_valid 'postgres-full-20260727T120000Z.sql.gz.enc.sha256'

  local fixture script_dir self_test_crypto fixture_key fixture_name fixture_backup
  fixture="$(mktemp -d)"
  case "$(realpath -e "$fixture")" in
    /tmp/* | /var/tmp/*) ;;
    *) return 1 ;;
  esac
  trap 'rm -rf -- "$fixture"' RETURN
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  self_test_crypto="$crypto_tool"
  if [[ ! -f "$self_test_crypto" ]]; then
    self_test_crypto="$script_dir/backup-file-crypto.mjs"
  fi
  [[ -f "$self_test_crypto" && ! -L "$self_test_crypto" ]]
  fixture_key="$fixture/key"
  fixture_name='postgres-full-20260727T120000Z.sql.gz.enc'
  fixture_backup="$fixture/$fixture_name"
  node "$self_test_crypto" generate-key --key-file "$fixture_key" >/dev/null
  printf 'recorder fixture\n' |
    gzip -c |
    node "$self_test_crypto" encrypt \
      --key-file "$fixture_key" --input - --output "$fixture_backup"
  (cd "$fixture" && sha256sum "$fixture_name" >"${fixture_name}.sha256")
  sidecar_matches "$fixture" "$fixture_backup" "$fixture_name"
  printf '%064d  %s\n' 0 "$fixture_name" >"${fixture_backup}.sha256"
  ! sidecar_matches "$fixture" "$fixture_backup" "$fixture_name"
  rm -f -- "${fixture_backup}.sha256"
  ! sidecar_matches "$fixture" "$fixture_backup" "$fixture_name"
  echo 'BACKUP_EVIDENCE_RECORDER_SELF_TEST=pass'
}

if [[ "${1:-}" == '--self-test' ]]; then
  [[ "$#" -eq 1 ]] || fail invalid_arguments
  self_test
  exit 0
fi

[[ "$#" -eq 1 ]] || fail invalid_arguments
[[ "$EUID" -eq 0 ]] || fail requires_root

backup_path="$1"
[[ "$backup_path" == /* ]] || fail backup_path_not_absolute
[[ ! -L "$backup_path" && -f "$backup_path" ]] || fail backup_not_regular_file
resolved_backup="$(realpath -e -- "$backup_path")"
resolved_dir="$(dirname -- "$resolved_backup")"
[[ "$resolved_dir" == "$backup_dir" ]] || fail backup_directory_mismatch

backup_name="$(basename -- "$resolved_backup")"
backup_name_is_valid "$backup_name" || fail backup_name_invalid
stamp="${BASH_REMATCH[1]}"

owner="$(stat -c '%U' "$resolved_backup")"
group="$(stat -c '%G' "$resolved_backup")"
mode="$(stat -c '%a' "$resolved_backup")"
size="$(stat -c '%s' "$resolved_backup")"
mtime_epoch="$(stat -c '%Y' "$resolved_backup")"
[[ "$owner" == 'root' && "$group" == 'postgres' && "$mode" == '640' ]] || fail backup_permissions_invalid
[[ "$size" =~ ^[0-9]+$ && "$size" -gt 0 ]] || fail backup_empty

sidecar="${resolved_backup}.sha256"
[[ ! -L "$sidecar" && -f "$sidecar" ]] || fail sidecar_missing_or_invalid
[[ "$(stat -c '%U' "$sidecar")" == 'root' ]] || fail sidecar_owner_invalid
[[ "$(stat -c '%G' "$sidecar")" == 'postgres' ]] || fail sidecar_group_invalid
[[ "$(stat -c '%a' "$sidecar")" == '640' ]] || fail sidecar_mode_invalid

sidecar_matches "$backup_dir" "$resolved_backup" "$backup_name" || fail checksum_mismatch
read -r expected_hash _ <"$sidecar"
actual_hash="$(sha256sum "$resolved_backup" | awk '{print $1}')"
[[ "$actual_hash" == "$expected_hash" ]] || fail checksum_mismatch

[[ ! -L "$key_file" && -f "$key_file" ]] || fail key_file_invalid
[[ "$(stat -c '%U:%G:%a' "$key_file")" == 'root:root:600' ]] || fail key_permissions_invalid
[[ ! -L "$crypto_tool" && -f "$crypto_tool" ]] || fail crypto_tool_invalid
[[ ! -L "$database_helper" && -f "$database_helper" ]] || fail database_helper_invalid

started_at="$(
  printf '%s' "$stamp" |
    sed -E 's/^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$/\1-\2-\3T\4:\5:\6Z/'
)"
started_epoch="$(date -u -d "$started_at" +%s)" || fail backup_timestamp_invalid
now_epoch="$(date +%s)"
(( mtime_epoch >= started_epoch )) || fail backup_mtime_before_start
(( mtime_epoch - started_epoch <= 21600 )) || fail backup_duration_unreasonable
(( mtime_epoch <= now_epoch + 300 )) || fail backup_mtime_in_future
completed_at="$(date -u -d "@$mtime_epoch" +%Y-%m-%dT%H:%M:%SZ)"

node "$crypto_tool" inspect --key-file "$key_file" --input "$resolved_backup" >/dev/null ||
  fail encrypted_format_invalid
set +e
node "$crypto_tool" decrypt --key-file "$key_file" --input "$resolved_backup" --output - |
  gzip -t
verify_exit=$?
set -e
[[ "$verify_exit" -eq 0 ]] || fail decrypt_or_gzip_verification_failed

docker inspect "$api_container" --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' |
  grep -qx 'true healthy' || fail api_container_not_healthy

set +e
database_output="$(
  docker exec -i "$api_container" node - backup \
    "$backup_name" "$started_at" "$completed_at" "$size" "$actual_hash" \
    <"$database_helper" 2>&1
)"
database_exit=$?
set -e
printf '%s\n' "$database_output"
[[ "$database_exit" -eq 0 ]] || fail database_write_failed
grep -Eq '^EVIDENCE_SYNC_STATUS=(created|no_change)$' <<<"$database_output" ||
  fail database_result_invalid

echo 'EVIDENCE_PHYSICAL_VALIDATION=pass'
echo 'EVIDENCE_CHECKSUM_VALIDATION=match'
echo 'EVIDENCE_DECRYPT_AUTHENTICATION=pass'
echo 'EVIDENCE_GZIP_INTEGRITY=pass'
