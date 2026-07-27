#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

timer_unit='salary-postgres-backup.timer'
service_unit='salary-postgres-backup.service'
warning_age_seconds=$((36 * 60 * 60))
critical_age_seconds=$((48 * 60 * 60))
warning_disk_percent=80
critical_disk_percent=90

failures=()
warnings=()

fail() {
  failures+=("$1")
}

warn() {
  warnings+=("$1")
}

join_codes() {
  local IFS=,
  printf '%s' "$*"
}

mode_has_bit() {
  local mode="$1"
  local bit="$2"
  (( (8#${mode} & bit) != 0 ))
}

self_test() {
  local fixture
  fixture="$(mktemp -d)"
  case "$fixture" in
    /tmp/* | /var/tmp/*) ;;
    *) echo 'TASK88_BACKUP_HEALTH_SELF_TEST=fail reason=unsafe_temp_path'; return 1 ;;
  esac

  printf 'fixture\n' >"$fixture/backup.sql.gz.source"
  gzip -c "$fixture/backup.sql.gz.source" >"$fixture/backup.sql.gz"
  (
    cd "$fixture"
    sha256sum backup.sql.gz >backup.sql.gz.sha256
    sha256sum -c --status backup.sql.gz.sha256
  )
  gzip -t "$fixture/backup.sql.gz"
  if [[ "$(uname -s)" != MINGW* ]]; then
    chmod 0640 "$fixture/backup.sql.gz" "$fixture/backup.sql.gz.sha256"
    [[ "$(stat -c '%a' "$fixture/backup.sql.gz")" == '640' ]]
  fi
  mode_has_bit 640 0040
  ! mode_has_bit 640 0004
  rm -rf -- "$fixture"
  echo 'TASK88_BACKUP_HEALTH_SELF_TEST=pass'
}

if [[ "${1:-}" == '--self-test' ]]; then
  [[ "$#" -eq 1 ]]
  self_test
  exit 0
fi

if [[ "$#" -ne 0 ]]; then
  echo 'TASK88_BACKUP_HEALTH_STATUS=fail'
  echo 'TASK88_BACKUP_HEALTH_FAILURE_CODES=invalid_arguments'
  exit 2
fi

if [[ "$EUID" -ne 0 ]]; then
  echo 'TASK88_BACKUP_HEALTH_STATUS=fail'
  echo 'TASK88_BACKUP_HEALTH_FAILURE_CODES=requires_root'
  exit 1
fi

echo "TASK88_BACKUP_HEALTH_CHECKED_AT_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "TASK88_BACKUP_TIMER_UNIT=$timer_unit"
echo "TASK88_BACKUP_SERVICE_UNIT=$service_unit"

if ! systemctl cat "$timer_unit" >/dev/null 2>&1; then
  fail timer_missing
fi
if ! systemctl cat "$service_unit" >/dev/null 2>&1; then
  fail service_missing
fi

timer_enabled="$(systemctl is-enabled "$timer_unit" 2>/dev/null || true)"
timer_active="$(systemctl is-active "$timer_unit" 2>/dev/null || true)"
timer_last="$(systemctl show "$timer_unit" -p LastTriggerUSec --value 2>/dev/null || true)"
timer_next="$(systemctl show "$timer_unit" -p NextElapseUSecRealtime --value 2>/dev/null || true)"
service_result="$(systemctl show "$service_unit" -p Result --value 2>/dev/null || true)"
service_exit="$(systemctl show "$service_unit" -p ExecMainStatus --value 2>/dev/null || true)"
service_finished="$(systemctl show "$service_unit" -p InactiveEnterTimestamp --value 2>/dev/null || true)"

echo "TASK88_BACKUP_TIMER_ENABLED=${timer_enabled:-unknown}"
echo "TASK88_BACKUP_TIMER_ACTIVE=${timer_active:-unknown}"
echo "TASK88_BACKUP_TIMER_LAST_TRIGGER=${timer_last:-unknown}"
echo "TASK88_BACKUP_TIMER_NEXT_TRIGGER=${timer_next:-unknown}"
echo "TASK88_BACKUP_SERVICE_RESULT=${service_result:-unknown}"
echo "TASK88_BACKUP_SERVICE_EXIT_CODE=${service_exit:-unknown}"
echo "TASK88_BACKUP_SERVICE_FINISHED=${service_finished:-unknown}"

[[ "$timer_enabled" == 'enabled' ]] || fail timer_not_enabled
[[ "$timer_active" == 'active' ]] || fail timer_not_active
[[ "$service_result" == 'success' ]] || fail last_service_result_not_success
[[ "$service_exit" == '0' ]] || fail last_service_exit_nonzero

exec_value="$(systemctl show "$service_unit" -p ExecStart --value 2>/dev/null || true)"
exec_path="$(sed -n 's/.*path=\([^ ;}]*\).*/\1/p' <<<"$exec_value")"
if [[ -z "$exec_path" || ! -f "$exec_path" ]]; then
  fail backup_command_missing
  exec_path=''
fi

backup_dir="$(systemctl cat "$service_unit" 2>/dev/null | sed -n 's/^ReadWritePaths=//p' | awk 'NF { print $1 }' | tail -n 1)"
if [[ -z "$backup_dir" || "$backup_dir" != /* || "$backup_dir" == '/' || ! -d "$backup_dir" ]]; then
  fail backup_directory_invalid
  backup_dir=''
fi

if [[ -n "$backup_dir" ]]; then
  dir_owner="$(stat -c '%U' "$backup_dir")"
  dir_group="$(stat -c '%G' "$backup_dir")"
  dir_mode="$(stat -c '%a' "$backup_dir")"
  echo "TASK88_BACKUP_DIRECTORY=$backup_dir"
  echo "TASK88_BACKUP_DIRECTORY_OWNER=$dir_owner"
  echo "TASK88_BACKUP_DIRECTORY_GROUP=$dir_group"
  echo "TASK88_BACKUP_DIRECTORY_MODE=$dir_mode"

  [[ "$dir_owner" == 'root' ]] || fail directory_owner_not_root
  mode_has_bit "$dir_mode" 0004 && fail directory_world_readable
  mode_has_bit "$dir_mode" 0002 && fail directory_world_writable
  mode_has_bit "$dir_mode" 0020 && fail directory_group_writable
fi

retention_days=''
if [[ -n "$exec_path" ]]; then
  exec_owner="$(stat -c '%U' "$exec_path")"
  exec_mode="$(stat -c '%a' "$exec_path")"
  [[ "$exec_owner" == 'root' ]] || fail backup_command_owner_not_root
  mode_has_bit "$exec_mode" 0002 && fail backup_command_world_writable
  mode_has_bit "$exec_mode" 0020 && fail backup_command_group_writable

  retention_days="$(
    grep -Eo -- '-mtime[[:space:]]+\+[0-9]+' "$exec_path" 2>/dev/null |
      grep -Eo '[0-9]+' |
      head -n 1 || true
  )"
  if [[ -z "$retention_days" ]]; then
    retention_days="$(
      sed -nE "s/^[[:space:]]*(retention_days|RETENTION_DAYS)=['\"]?([0-9]+).*/\2/p" "$exec_path" |
        head -n 1
    )"
  fi
fi

echo "TASK88_BACKUP_RETENTION_DAYS=${retention_days:-unknown}"
[[ "$retention_days" =~ ^[0-9]+$ ]] || fail retention_not_determined

latest=''
if [[ -n "$backup_dir" ]]; then
  latest="$(
    find "$backup_dir" -maxdepth 1 -type f \
      ! -name '*.sha256' ! -name '*.log' ! -name '*.env' \
      -printf '%T@ %p\n' |
      sort -nr |
      head -n 1 |
      cut -d' ' -f2-
  )"
fi

if [[ -z "$latest" || ! -f "$latest" ]]; then
  fail latest_backup_missing
else
  latest_name="$(basename "$latest")"
  latest_mtime_epoch="$(stat -c '%Y' "$latest")"
  latest_mtime="$(date -u -d "@$latest_mtime_epoch" +%Y-%m-%dT%H:%M:%SZ)"
  latest_age_seconds="$(($(date +%s) - latest_mtime_epoch))"
  latest_size="$(stat -c '%s' "$latest")"
  latest_size_human="$(du -h "$latest" | awk '{print $1}')"
  latest_owner="$(stat -c '%U' "$latest")"
  latest_group="$(stat -c '%G' "$latest")"
  latest_mode="$(stat -c '%a' "$latest")"

  echo "TASK88_LATEST_BACKUP_BASENAME=$latest_name"
  echo "TASK88_LATEST_BACKUP_MTIME_UTC=$latest_mtime"
  echo "TASK88_LATEST_BACKUP_AGE_SECONDS=$latest_age_seconds"
  echo "TASK88_LATEST_BACKUP_SIZE_BYTES=$latest_size"
  echo "TASK88_LATEST_BACKUP_SIZE_HUMAN=$latest_size_human"
  echo "TASK88_LATEST_BACKUP_OWNER=$latest_owner"
  echo "TASK88_LATEST_BACKUP_GROUP=$latest_group"
  echo "TASK88_LATEST_BACKUP_MODE=$latest_mode"

  (( latest_size > 0 )) || fail latest_backup_empty
  [[ "$latest_owner" == 'root' ]] || fail latest_backup_owner_not_root
  mode_has_bit "$latest_mode" 0004 && fail latest_backup_world_readable
  mode_has_bit "$latest_mode" 0002 && fail latest_backup_world_writable
  mode_has_bit "$latest_mode" 0020 && fail latest_backup_group_writable

  if (( latest_age_seconds >= critical_age_seconds )); then
    fail latest_backup_older_than_48h
  elif (( latest_age_seconds >= warning_age_seconds )); then
    warn latest_backup_older_than_36h
  fi

  sidecar="${latest}.sha256"
  if [[ ! -f "$sidecar" ]]; then
    echo 'TASK88_BACKUP_CHECKSUM_SOURCE=missing'
    echo 'TASK88_BACKUP_CHECKSUM_RESULT=unverifiable'
    fail checksum_sidecar_missing
  else
    echo "TASK88_BACKUP_CHECKSUM_SOURCE=sidecar:$(basename "$sidecar")"
    if (cd "$backup_dir" && sha256sum -c --status "$(basename "$sidecar")") 2>/dev/null; then
      echo 'TASK88_BACKUP_CHECKSUM_RESULT=match'
    else
      echo 'TASK88_BACKUP_CHECKSUM_RESULT=mismatch'
      fail checksum_mismatch
    fi
    sidecar_mode="$(stat -c '%a' "$sidecar")"
    echo "TASK88_BACKUP_CHECKSUM_MODE=$sidecar_mode"
    mode_has_bit "$sidecar_mode" 0004 && fail checksum_world_readable
    mode_has_bit "$sidecar_mode" 0002 && fail checksum_world_writable
    mode_has_bit "$sidecar_mode" 0020 && fail checksum_group_writable
  fi

  case "$latest_name" in
    *.sql.gz)
      if gzip -t "$latest" 2>/dev/null; then
        echo 'TASK88_BACKUP_INTEGRITY_RESULT=pass_gzip'
      else
        echo 'TASK88_BACKUP_INTEGRITY_RESULT=fail_gzip'
        fail gzip_integrity_failed
      fi
      ;;
    *)
      echo 'TASK88_BACKUP_INTEGRITY_RESULT=unsupported_format'
      fail unsupported_backup_format
      ;;
  esac
fi

if [[ -n "$backup_dir" ]]; then
  backup_count="$(
    find "$backup_dir" -maxdepth 1 -type f \
      ! -name '*.sha256' ! -name '*.log' ! -name '*.env' |
      wc -l
  )"
  backup_bytes="$(du -sb "$backup_dir" | awk '{print $1}')"
  world_readable="$(find "$backup_dir" -maxdepth 1 -type f -perm -0004 | wc -l)"
  world_writable="$(find "$backup_dir" -maxdepth 1 -type f -perm -0002 | wc -l)"
  group_writable="$(find "$backup_dir" -maxdepth 1 -type f -perm -0020 | wc -l)"
  disk_used="$(df -P "$backup_dir" | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"

  echo "TASK88_BACKUP_FILE_COUNT=$backup_count"
  echo "TASK88_BACKUP_DIRECTORY_BYTES=$backup_bytes"
  echo "TASK88_BACKUP_WORLD_READABLE_FILES=$world_readable"
  echo "TASK88_BACKUP_WORLD_WRITABLE_FILES=$world_writable"
  echo "TASK88_BACKUP_GROUP_WRITABLE_FILES=$group_writable"
  echo "TASK88_BACKUP_FILESYSTEM_USED_PERCENT=$disk_used"

  (( world_readable == 0 )) || fail world_readable_backup_files
  (( world_writable == 0 )) || fail world_writable_backup_files
  (( group_writable == 0 )) || fail group_writable_backup_files
  if (( disk_used >= critical_disk_percent )); then
    fail disk_usage_at_least_90_percent
  elif (( disk_used >= warning_disk_percent )); then
    warn disk_usage_at_least_80_percent
  fi
fi

status=pass
if (( ${#failures[@]} > 0 )); then
  status=fail
elif (( ${#warnings[@]} > 0 )); then
  status=warning
fi

echo "TASK88_BACKUP_HEALTH_STATUS=$status"
echo "TASK88_BACKUP_HEALTH_WARNING_CODES=$(if (( ${#warnings[@]} > 0 )); then join_codes "${warnings[@]}"; else echo none; fi)"
echo "TASK88_BACKUP_HEALTH_FAILURE_CODES=$(if (( ${#failures[@]} > 0 )); then join_codes "${failures[@]}"; else echo none; fi)"

[[ "$status" != 'fail' ]]
