#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C
umask 077

staging_dir='/home/salaryops/task94-staging'
result_file='/home/salaryops/task94-result.env'
libexec_dir='/usr/local/libexec/salary-settlement-admin'
database_helper="${libexec_dir}/backup-watchdog-db.cjs"
watchdog='/usr/local/sbin/salary-postgres-backup-watchdog'
key_recovery_tool='/usr/local/sbin/backup-key-recovery'
active_key='/etc/salary-settlement-admin/backup-file-encryption.key'
recovery_dir='/var/lib/salary-settlement-admin-key-recovery'
recovery_key="${recovery_dir}/backup-file-encryption.key"
backup_script='/usr/local/sbin/salary-postgres-backup'
api_container='salary-settlement-admin-api-1'
web_container='salary-settlement-admin-web-1'
required_commit="${TASK94_IMPLEMENTATION_COMMIT:-}"
run_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
rollback_dir="/root/task94-rollback-${run_stamp}"
rollback_needed=0
rollout_complete=0
recovery_created=0

record() {
  printf '%s\n' "$1" >>"$result_file"
}

record_output() {
  printf '%s\n' "$1" >>"$result_file"
}

fail() {
  echo "TASK94_ROLLOUT_ERROR=$1" >&2
  record "TASK94_ROLLOUT_ERROR=$1"
  exit 1
}

restore_path() {
  local target="$1"
  local backup
  backup="${rollback_dir}/$(basename -- "$target")"
  if [[ -f "$backup" ]]; then
    install -o root -g root -m "$(stat -c '%a' "$backup")" "$backup" "${target}.task94-rollback"
    mv -T -- "${target}.task94-rollback" "$target"
  else
    rm -f -- "$target"
  fi
}

resolve_synthetic_best_effort() {
  if [[ -x "$watchdog" && -f "$database_helper" ]]; then
    "$watchdog" --synthetic-key-resolve >/dev/null 2>&1 || true
  fi
}

rollback() {
  local reason="$1"
  [[ "$rollback_needed" -eq 1 ]] || return 0
  set +e
  resolve_synthetic_best_effort
  exec 9>'/run/lock/salary-postgres-backup-watchdog.lock'
  flock -w 30 9
  restore_path "$database_helper"
  restore_path "$watchdog"
  restore_path "$key_recovery_tool"
  local rollback_exit=$?
  if [[ "$recovery_created" -eq 1 && "$recovery_dir" == '/var/lib/salary-settlement-admin-key-recovery' ]]; then
    rm -f -- \
      "${recovery_dir}/backup-file-encryption.key" \
      "${recovery_dir}/backup-file-encryption.key.meta" \
      "${recovery_dir}/.create.lock"
    rmdir -- "$recovery_dir" 2>/dev/null || true
  fi
  set -e
  record 'TASK94_ROLLBACK=performed'
  record "TASK94_ROLLBACK_REASON=$reason"
  record "TASK94_ROLLBACK_PATH=$rollback_dir"
  record "TASK94_ROLLBACK_EXIT=$rollback_exit"
  rollback_needed=0
  return "$rollback_exit"
}

on_exit() {
  local exit_code=$?
  trap - EXIT
  if [[ "$exit_code" -ne 0 && "$rollout_complete" -eq 0 ]]; then
    set +e
    rollback "rollout_exit_${exit_code}"
    local rollback_exit=$?
    set -e
    if [[ "$rollback_exit" -ne 0 ]]; then
      record 'TASK94_ROLLBACK=failed'
    fi
    record 'TASK94_PRODUCTION_ROLLOUT=failed'
    record "TASK94_PRODUCTION_ROLLOUT_EXIT=$exit_code"
  fi
  exit "$exit_code"
}
trap on_exit EXIT

[[ "$EUID" -eq 0 ]] || {
  echo 'TASK94_ROLLOUT_ERROR=requires_root' >&2
  exit 1
}
[[ "$required_commit" =~ ^[a-f0-9]{40}$ ]] || {
  echo 'TASK94_ROLLOUT_ERROR=implementation_commit_required' >&2
  exit 1
}
[[ -d "$staging_dir" && ! -L "$staging_dir" ]] || {
  echo 'TASK94_ROLLOUT_ERROR=staging_directory_invalid' >&2
  exit 1
}
[[ "$(<"$staging_dir/implementation-commit")" == "$required_commit" ]] ||
  fail implementation_commit_mismatch
[[ -f "$staging_dir/sha256sums.txt" && ! -L "$staging_dir/sha256sums.txt" ]] ||
  fail checksum_manifest_invalid

install -o salaryops -g salaryops -m 0600 /dev/null "$result_file"
record "TASK94_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
record "TASK94_IMPLEMENTATION_COMMIT=$required_commit"
record "TASK94_ROLLBACK_PATH=$rollback_dir"
record 'TASK94_API_WEB_DEPLOYMENT=not_performed'
record 'TASK94_NGINX_CHANGE=not_performed'
record 'TASK94_MIGRATION=not_performed'
record 'TASK94_BUSINESS_DATA_CHANGE=not_performed'
record 'TASK94_ACTIVE_KEY_CHANGE=not_performed'
record 'TASK94_BACKUP_RETENTION_CHANGE=not_performed'
record 'TASK94_FULL_BACKUP_TRIGGERED=no'
record 'TASK94_OFF_HOST_BACKUP_CHANGE=not_performed'
record 'TASK94_RC_TAG_CHANGE=not_performed'
record 'TASK94_DAEMON_RELOAD=not_performed'

(
  cd "$staging_dir"
  sha256sum -c sha256sums.txt
) || fail staging_checksum_mismatch
record 'TASK94_STAGING_SHA256=pass'

for source in \
  backup-watchdog-db.cjs \
  salary-postgres-backup-watchdog \
  backup-key-recovery \
  task94-production-rollout.sh; do
  [[ -f "$staging_dir/$source" && ! -L "$staging_dir/$source" ]] ||
    fail "staging_file_invalid_${source}"
  mode="$(stat -c '%a' "$staging_dir/$source")"
  (( (8#${mode} & 0022) == 0 )) || fail "staging_file_writable_${source}"
done

systemctl is-enabled --quiet salary-postgres-backup.timer || fail backup_timer_not_enabled_before
systemctl is-active --quiet salary-postgres-backup.timer || fail backup_timer_not_active_before
backup_result_before="$(systemctl show salary-postgres-backup.service -p Result --value)"
backup_exit_before="$(systemctl show salary-postgres-backup.service -p ExecMainStatus --value)"
[[ "$backup_result_before" == 'success' && "$backup_exit_before" == '0' ]] ||
  fail backup_service_not_success_before
systemctl is-enabled --quiet salary-postgres-backup-watchdog.timer ||
  fail watchdog_timer_not_enabled_before
systemctl is-active --quiet salary-postgres-backup-watchdog.timer ||
  fail watchdog_timer_not_active_before
watchdog_result_before="$(systemctl show salary-postgres-backup-watchdog.service -p Result --value)"
watchdog_exit_before="$(systemctl show salary-postgres-backup-watchdog.service -p ExecMainStatus --value)"
[[ "$watchdog_result_before" == 'success' && "$watchdog_exit_before" == '0' ]] ||
  fail watchdog_service_not_success_before
for unit in nginx docker postgresql; do
  systemctl is-active --quiet "$unit" || fail "service_not_active_before_${unit}"
done

api_state_before="$(docker inspect "$api_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
web_state_before="$(docker inspect "$web_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
api_restart_before="$(docker inspect "$api_container" --format '{{.RestartCount}}')"
web_restart_before="$(docker inspect "$web_container" --format '{{.RestartCount}}')"
[[ "$api_state_before" == 'healthy' && "$web_state_before" == 'healthy' ]] ||
  fail containers_not_healthy_before
active_critical_before="$(
  docker exec "$api_container" node -e '
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient();
    prisma.alert.count({ where: { status: "active", severity: "critical" } })
      .then((value) => console.log(value))
      .finally(() => prisma.$disconnect());
  '
)"
[[ "$active_critical_before" =~ ^[0-9]+$ ]] || fail active_critical_before_invalid
record "TASK94_ACTIVE_CRITICAL_BEFORE=$active_critical_before"
record "TASK94_API_RESTART_BEFORE=$api_restart_before"
record "TASK94_WEB_RESTART_BEFORE=$web_restart_before"

[[ -f "$active_key" && ! -L "$active_key" ]] || fail active_key_invalid_before
[[ "$(stat -c '%U:%G:%a' "$active_key")" == 'root:root:600' ]] ||
  fail active_key_permissions_invalid_before
active_identity_before="$(stat -c '%d:%i:%s:%Y:%Z' "$active_key")"
record 'TASK94_ACTIVE_KEY_BASELINE=pass'

install -d -o root -g root -m 0700 "$rollback_dir"
for target in "$database_helper" "$watchdog" "$key_recovery_tool"; do
  if [[ -e "$target" ]]; then
    cp --preserve=mode,ownership,timestamps "$target" "$rollback_dir/$(basename -- "$target")"
  fi
done
record 'TASK94_ROLLBACK_COPY=pass'
rollback_needed=1

install -d -o root -g root -m 0755 "$libexec_dir"
database_temp="${database_helper}.task94-new"
watchdog_temp="${watchdog}.task94-new"
recovery_tool_temp="${key_recovery_tool}.task94-new"
install -o root -g root -m 0750 "$staging_dir/backup-watchdog-db.cjs" "$database_temp"
install -o root -g root -m 0750 "$staging_dir/salary-postgres-backup-watchdog" "$watchdog_temp"
install -o root -g root -m 0750 "$staging_dir/backup-key-recovery" "$recovery_tool_temp"
node --check "$database_temp"
bash -n "$watchdog_temp"
bash -n "$recovery_tool_temp"

exec 9>'/run/lock/salary-postgres-backup-watchdog.lock'
flock -w 30 9 || fail watchdog_install_lock_failed
mv -T -- "$database_temp" "$database_helper"
mv -T -- "$watchdog_temp" "$watchdog"
mv -T -- "$recovery_tool_temp" "$key_recovery_tool"
flock -u 9
node --check "$database_helper"
bash -n "$watchdog"
bash -n "$key_recovery_tool"
"$watchdog" --self-test
record 'TASK94_INSTALLED_VALIDATION=pass'

grep -qx "key_file='/etc/salary-settlement-admin/backup-file-encryption.key'" "$backup_script" ||
  fail backup_active_key_path_changed
if grep -qE 'salary-settlement-admin-key-recovery|recovery_key|backup-key-recovery' "$backup_script"; then
  fail backup_automatic_fallback_detected
fi
record 'TASK94_BACKUP_AUTOMATIC_FALLBACK=absent'

recovery_existed_before=0
[[ -e "$recovery_key" || -L "$recovery_key" ]] && recovery_existed_before=1
create_output="$("$key_recovery_tool" create)"
record_output "$create_output"
if [[ "$recovery_existed_before" -eq 0 ]]; then
  recovery_created=1
fi
[[ -d "$recovery_dir" && ! -L "$recovery_dir" ]] || fail recovery_directory_invalid
[[ "$(stat -c '%U:%G:%a' "$recovery_dir")" == 'root:root:700' ]] ||
  fail recovery_directory_permissions_invalid
[[ -f "$recovery_key" && ! -L "$recovery_key" ]] || fail recovery_key_invalid
[[ "$(stat -c '%U:%G:%a' "$recovery_key")" == 'root:root:600' ]] ||
  fail recovery_key_permissions_invalid
[[ "$(stat -c '%h' "$recovery_key")" == '1' ]] || fail recovery_key_hardlink
[[ "$(stat -c '%d:%i' "$recovery_key")" != "$(stat -c '%d:%i' "$active_key")" ]] ||
  fail recovery_key_hardlink
cmp -s -- "$active_key" "$recovery_key" || fail recovery_key_mismatch
record "TASK94_RECOVERY_DIRECTORY=$recovery_dir"
record "TASK94_RECOVERY_KEY=$recovery_key"
record 'TASK94_RECOVERY_DIRECTORY_OWNER_GROUP_MODE=root:root:700'
record 'TASK94_RECOVERY_KEY_OWNER_GROUP_MODE=root:root:600'
record 'TASK94_RECOVERY_KEY_SYMLINK=no'
record 'TASK94_RECOVERY_KEY_HARDLINK=no'
record 'TASK94_RECOVERY_KEY_BYTE_MATCH=pass'

watchdog_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
systemctl start salary-postgres-backup-watchdog.service
watchdog_result="$(systemctl show salary-postgres-backup-watchdog.service -p Result --value)"
watchdog_exit="$(systemctl show salary-postgres-backup-watchdog.service -p ExecMainStatus --value)"
[[ "$watchdog_result" == 'success' && "$watchdog_exit" == '0' ]] ||
  fail watchdog_service_failed
watchdog_output="$(
  journalctl -u salary-postgres-backup-watchdog.service \
    --since "$watchdog_started_at" -o cat --no-pager |
    grep -E '^TASK(93|94)_' || true
)"
record_output "$watchdog_output"
grep -q '^TASK94_WATCHDOG_ACTIVE_KEY_VALID=true$' <<<"$watchdog_output" ||
  fail watchdog_active_key_not_valid
grep -q '^TASK94_WATCHDOG_RECOVERY_KEY_VALID=true$' <<<"$watchdog_output" ||
  fail watchdog_recovery_key_not_valid
grep -q '^TASK94_WATCHDOG_KEY_MATCH=true$' <<<"$watchdog_output" ||
  fail watchdog_key_mismatch
grep -q '^TASK94_WATCHDOG_RECOVERY_DECRYPT_STATUS=pass$' <<<"$watchdog_output" ||
  fail watchdog_recovery_decrypt_failed

drill_output="$("$key_recovery_tool" drill)"
record_output "$drill_output"
grep -q '^TASK94_RECOVERY_DRILL_STATUS=success$' <<<"$drill_output" ||
  fail recovery_drill_failed
grep -q '^TASK94_RECOVERY_DRILL_AUTHENTICATION=pass$' <<<"$drill_output" ||
  fail recovery_drill_authentication_failed
grep -q '^TASK94_RECOVERY_DRILL_GZIP=pass$' <<<"$drill_output" ||
  fail recovery_drill_gzip_failed
grep -q '^TASK94_RECOVERY_DRILL_CLEANUP=complete$' <<<"$drill_output" ||
  fail recovery_drill_cleanup_failed

baseline_output="$("$watchdog" --baseline)"
record_output "$baseline_output"

synthetic_first="$("$watchdog" --synthetic-key-activate)"
record_output "$synthetic_first"
first_generated="$(sed -n 's/^TASK93_WATCHDOG_GENERATED=//p' <<<"$synthetic_first")"
first_active="$(sed -n 's/^TASK93_WATCHDOG_ACTIVE_COUNT=//p' <<<"$synthetic_first")"
[[ "$first_generated" == '1' && "$first_active" == '1' ]] ||
  fail synthetic_first_create_failed
record 'TASK94_SYNTHETIC_FIRST_CREATED=1'
record 'TASK94_SYNTHETIC_FIRST_ACTIVE=1'

synthetic_second="$("$watchdog" --synthetic-key-activate)"
record_output "$synthetic_second"
second_generated="$(sed -n 's/^TASK93_WATCHDOG_GENERATED=//p' <<<"$synthetic_second")"
second_updated="$(sed -n 's/^TASK93_WATCHDOG_UPDATED=//p' <<<"$synthetic_second")"
second_active="$(sed -n 's/^TASK93_WATCHDOG_ACTIVE_COUNT=//p' <<<"$synthetic_second")"
[[ "$second_generated" == '0' && "$second_updated" == '1' && "$second_active" == '1' ]] ||
  fail synthetic_idempotency_failed
record 'TASK94_SYNTHETIC_SECOND_GENERATED=0'
record 'TASK94_SYNTHETIC_SECOND_UPDATED=1'
record 'TASK94_SYNTHETIC_SECOND_ACTIVE=1'

synthetic_resolved="$("$watchdog" --synthetic-key-resolve)"
record_output "$synthetic_resolved"
resolved_count="$(sed -n 's/^TASK93_WATCHDOG_RESOLVED=//p' <<<"$synthetic_resolved")"
resolved_status="$(sed -n 's/^TASK93_WATCHDOG_STATUS=//p' <<<"$synthetic_resolved")"
resolved_active="$(sed -n 's/^TASK93_WATCHDOG_ACTIVE_COUNT=//p' <<<"$synthetic_resolved")"
[[ "$resolved_count" == '1' && "$resolved_status" == 'resolved' && "$resolved_active" == '0' ]] ||
  fail synthetic_resolution_failed
record 'TASK94_SYNTHETIC_RESOLVED=1'
record 'TASK94_SYNTHETIC_ACTIVE_AFTER_RESOLVE=0'

active_critical_after="$(
  docker exec "$api_container" node -e '
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient();
    prisma.alert.count({ where: { status: "active", severity: "critical" } })
      .then((value) => console.log(value))
      .finally(() => prisma.$disconnect());
  '
)"
[[ "$active_critical_after" == "$active_critical_before" ]] ||
  fail active_critical_baseline_changed
record "TASK94_ACTIVE_CRITICAL_AFTER=$active_critical_after"

health_output="$(/usr/local/sbin/check-local-backup-health)"
record_output "$health_output"
grep -q '^TASK88_BACKUP_HEALTH_STATUS=pass$' <<<"$health_output" ||
  fail backup_health_not_pass

set +e
gate_output="$(/home/salaryops/production-release-gate.sh 2>&1)"
gate_exit=$?
set -e
record_output "$gate_output"
record "TASK94_RELEASE_GATE_EXIT=$gate_exit"
[[ "$gate_exit" -eq 0 ]] || fail release_gate_failed
grep -q '^RELEASE_GATE_FAIL=0$' <<<"$gate_output" || fail release_gate_has_failures

systemctl is-enabled --quiet salary-postgres-backup.timer || fail backup_timer_not_enabled_after
systemctl is-active --quiet salary-postgres-backup.timer || fail backup_timer_not_active_after
[[ "$(systemctl show salary-postgres-backup.service -p Result --value)" == "$backup_result_before" ]] ||
  fail backup_result_changed
[[ "$(systemctl show salary-postgres-backup.service -p ExecMainStatus --value)" == "$backup_exit_before" ]] ||
  fail backup_exit_changed
systemctl is-enabled --quiet salary-postgres-backup-watchdog.timer ||
  fail watchdog_timer_not_enabled_after
systemctl is-active --quiet salary-postgres-backup-watchdog.timer ||
  fail watchdog_timer_not_active_after
for unit in nginx docker postgresql; do
  systemctl is-active --quiet "$unit" || fail "service_not_active_after_${unit}"
done
api_restart_after="$(docker inspect "$api_container" --format '{{.RestartCount}}')"
web_restart_after="$(docker inspect "$web_container" --format '{{.RestartCount}}')"
api_state_after="$(docker inspect "$api_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
web_state_after="$(docker inspect "$web_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
[[ "$api_restart_after" == "$api_restart_before" && "$web_restart_after" == "$web_restart_before" ]] ||
  fail container_restart_changed
[[ "$api_state_after" == 'healthy' && "$web_state_after" == 'healthy' ]] ||
  fail containers_not_healthy_after
[[ "$(stat -c '%d:%i:%s:%Y:%Z' "$active_key")" == "$active_identity_before" ]] ||
  fail active_key_changed

secret_match_count="$(
  grep -IlFf "$active_key" \
    "$database_helper" \
    "$watchdog" \
    "$key_recovery_tool" \
    "$result_file" \
    "$staging_dir"/* 2>/dev/null |
    wc -l
)"
[[ "$secret_match_count" -eq 0 ]] || fail sensitive_information_detected
record 'TASK94_SENSITIVE_INFORMATION_SCAN=pass'

task94_temp_count="$(
  find /run /tmp /home/salaryops -maxdepth 2 \
    \( -name 'task94-*.tmp' -o -name 'task94-*.part' -o -name 'task94-*.key' \) \
    -print 2>/dev/null |
    wc -l
)"
[[ "$task94_temp_count" -eq 0 ]] || fail task94_temporary_residue
record 'TASK94_TEMPORARY_RESIDUE=none'

record 'TASK94_BACKUP_TIMER_ENABLED=enabled'
record 'TASK94_BACKUP_TIMER_ACTIVE=active'
record "TASK94_BACKUP_SERVICE_RESULT=$backup_result_before"
record "TASK94_BACKUP_SERVICE_EXIT=$backup_exit_before"
record 'TASK94_WATCHDOG_TIMER_ENABLED=enabled'
record 'TASK94_WATCHDOG_TIMER_ACTIVE=active'
record "TASK94_WATCHDOG_SERVICE_RESULT=$watchdog_result"
record "TASK94_WATCHDOG_SERVICE_EXIT=$watchdog_exit"
record "TASK94_API_STATE=$api_state_after"
record "TASK94_WEB_STATE=$web_state_after"
record "TASK94_API_RESTART_AFTER=$api_restart_after"
record "TASK94_WEB_RESTART_AFTER=$web_restart_after"
record 'TASK94_CORE_SERVICES=active'
record 'TASK94_ROLLBACK=not_performed'

rollback_needed=0
rollout_complete=1
record "TASK94_COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
record 'TASK94_PRODUCTION_ROLLOUT=success'
rm -rf -- "$staging_dir"
echo 'TASK94_PRODUCTION_ROLLOUT=success'
