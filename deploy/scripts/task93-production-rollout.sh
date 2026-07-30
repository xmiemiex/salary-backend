#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C
umask 077

staging_dir='/home/salaryops/task93-staging'
result_file='/home/salaryops/task93-result.env'
libexec_dir='/usr/local/libexec/salary-settlement-admin'
database_helper="${libexec_dir}/backup-watchdog-db.cjs"
watchdog='/usr/local/sbin/salary-postgres-backup-watchdog'
service_unit='/etc/systemd/system/salary-postgres-backup-watchdog.service'
failure_unit='/etc/systemd/system/salary-postgres-backup-watchdog-failure.service'
timer_unit='/etc/systemd/system/salary-postgres-backup-watchdog.timer'
api_container='salary-settlement-admin-api-1'
web_container='salary-settlement-admin-web-1'
required_commit="${TASK93_IMPLEMENTATION_COMMIT:-}"
run_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
rollback_dir="/root/task93-rollback-${run_stamp}"
rollback_needed=0
rollout_complete=0
daemon_reloaded=0

record() {
  printf '%s\n' "$1" >>"$result_file"
}

fail() {
  echo "TASK93_ROLLOUT_ERROR=$1" >&2
  record "TASK93_ROLLOUT_ERROR=$1"
  exit 1
}

resolve_synthetic_best_effort() {
  if [[ -x "$watchdog" && -f "$database_helper" ]]; then
    "$watchdog" --synthetic-resolve >/dev/null 2>&1 || true
  fi
}

restore_path() {
  local target="$1"
  local backup="$rollback_dir/$(basename -- "$target")"
  if [[ -f "$backup" ]]; then
    install -o root -g root -m "$(stat -c '%a' "$backup")" "$backup" "$target"
  else
    rm -f -- "$target"
  fi
}

rollback() {
  local reason="$1"
  [[ "$rollback_needed" -eq 1 ]] || return 0
  set +e
  resolve_synthetic_best_effort
  systemctl disable --now salary-postgres-backup-watchdog.timer >/dev/null 2>&1
  restore_path "$database_helper"
  restore_path "$watchdog"
  restore_path "$service_unit"
  restore_path "$failure_unit"
  restore_path "$timer_unit"
  systemctl daemon-reload
  local rollback_exit=$?
  set -e
  record 'TASK93_ROLLBACK=performed'
  record "TASK93_ROLLBACK_REASON=$reason"
  record "TASK93_ROLLBACK_PATH=$rollback_dir"
  record "TASK93_ROLLBACK_EXIT=$rollback_exit"
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
      record 'TASK93_ROLLBACK=failed'
    fi
    record 'TASK93_PRODUCTION_ROLLOUT=failed'
    record "TASK93_PRODUCTION_ROLLOUT_EXIT=$exit_code"
  fi
  exit "$exit_code"
}
trap on_exit EXIT

[[ "$EUID" -eq 0 ]] || {
  echo 'TASK93_ROLLOUT_ERROR=requires_root' >&2
  exit 1
}
[[ "$required_commit" =~ ^[a-f0-9]{40}$ ]] || {
  echo 'TASK93_ROLLOUT_ERROR=implementation_commit_required' >&2
  exit 1
}
[[ -d "$staging_dir" && ! -L "$staging_dir" ]] || {
  echo 'TASK93_ROLLOUT_ERROR=staging_directory_invalid' >&2
  exit 1
}
[[ "$(<"$staging_dir/implementation-commit")" == "$required_commit" ]] ||
  fail implementation_commit_mismatch
[[ -f "$staging_dir/sha256sums.txt" && ! -L "$staging_dir/sha256sums.txt" ]] ||
  fail checksum_manifest_invalid

install -o salaryops -g salaryops -m 0600 /dev/null "$result_file"
record "TASK93_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
record "TASK93_IMPLEMENTATION_COMMIT=$required_commit"
record "TASK93_ROLLBACK_PATH=$rollback_dir"
record 'TASK93_API_WEB_DEPLOYMENT=not_performed'
record 'TASK93_NGINX_CHANGE=not_performed'
record 'TASK93_MIGRATION=not_performed'
record 'TASK93_BUSINESS_DATA_CHANGE=not_performed'
record 'TASK93_BACKUP_CHANGE=not_performed'
record 'TASK93_KEY_CHANGE=not_performed'

(
  cd "$staging_dir"
  sha256sum -c sha256sums.txt
) || fail staging_checksum_mismatch
record 'TASK93_STAGING_SHA256=pass'

for source in \
  backup-watchdog-db.cjs \
  salary-postgres-backup-watchdog \
  salary-postgres-backup-watchdog.service \
  salary-postgres-backup-watchdog-failure.service \
  salary-postgres-backup-watchdog.timer \
  task93-production-rollout.sh; do
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
record "TASK93_ACTIVE_CRITICAL_BEFORE=$active_critical_before"
record "TASK93_API_RESTART_BEFORE=$api_restart_before"
record "TASK93_WEB_RESTART_BEFORE=$web_restart_before"

install -d -o root -g root -m 0700 "$rollback_dir"
for target in "$database_helper" "$watchdog" "$service_unit" "$failure_unit" "$timer_unit"; do
  if [[ -e "$target" ]]; then
    cp --preserve=mode,ownership,timestamps "$target" "$rollback_dir/$(basename -- "$target")"
  fi
done
record 'TASK93_ROLLBACK_COPY=pass'

install -d -o root -g root -m 0755 "$libexec_dir"
install -o root -g root -m 0750 "$staging_dir/backup-watchdog-db.cjs" "$database_helper"
install -o root -g root -m 0750 "$staging_dir/salary-postgres-backup-watchdog" "$watchdog"
install -o root -g root -m 0644 "$staging_dir/salary-postgres-backup-watchdog.service" "$service_unit"
install -o root -g root -m 0644 "$staging_dir/salary-postgres-backup-watchdog-failure.service" "$failure_unit"
install -o root -g root -m 0644 "$staging_dir/salary-postgres-backup-watchdog.timer" "$timer_unit"
rollback_needed=1

node --check "$database_helper"
bash -n "$watchdog"
"$watchdog" --self-test
systemd-analyze verify "$service_unit" "$failure_unit" "$timer_unit"
record 'TASK93_INSTALLED_VALIDATION=pass'

systemctl daemon-reload
daemon_reloaded=1
record 'TASK93_DAEMON_RELOAD=performed'
systemctl enable --now salary-postgres-backup-watchdog.timer
systemctl start salary-postgres-backup-watchdog.service

watchdog_result="$(systemctl show salary-postgres-backup-watchdog.service -p Result --value)"
watchdog_exit="$(systemctl show salary-postgres-backup-watchdog.service -p ExecMainStatus --value)"
[[ "$watchdog_result" == 'success' && "$watchdog_exit" == '0' ]] ||
  fail watchdog_service_failed
systemctl is-enabled --quiet salary-postgres-backup-watchdog.timer ||
  fail watchdog_timer_not_enabled
systemctl is-active --quiet salary-postgres-backup-watchdog.timer ||
  fail watchdog_timer_not_active
record 'TASK93_WATCHDOG_TIMER_ENABLED=enabled'
record 'TASK93_WATCHDOG_TIMER_ACTIVE=active'
record "TASK93_WATCHDOG_SERVICE_RESULT=$watchdog_result"
record "TASK93_WATCHDOG_SERVICE_EXIT=$watchdog_exit"

baseline_output="$("$watchdog" --baseline)"
printf '%s\n' "$baseline_output"
record "$(sed -n 's/^TASK93_WATCHDOG_ACTIVE_CRITICAL=/TASK93_BASELINE_ACTIVE_CRITICAL=/p' <<<"$baseline_output")"
record "$(sed -n 's/^TASK93_WATCHDOG_ACTIVE_WATCHDOG=/TASK93_BASELINE_ACTIVE_WATCHDOG=/p' <<<"$baseline_output")"

synthetic_first="$("$watchdog" --synthetic-activate)"
printf '%s\n' "$synthetic_first"
first_generated="$(sed -n 's/^TASK93_WATCHDOG_GENERATED=//p' <<<"$synthetic_first")"
first_active="$(sed -n 's/^TASK93_WATCHDOG_ACTIVE_COUNT=//p' <<<"$synthetic_first")"
[[ "$first_generated" == '1' && "$first_active" == '1' ]] ||
  fail synthetic_first_create_failed
record 'TASK93_SYNTHETIC_FIRST_CREATED=1'
record 'TASK93_SYNTHETIC_FIRST_ACTIVE=1'

synthetic_second="$("$watchdog" --synthetic-activate)"
printf '%s\n' "$synthetic_second"
second_generated="$(sed -n 's/^TASK93_WATCHDOG_GENERATED=//p' <<<"$synthetic_second")"
second_updated="$(sed -n 's/^TASK93_WATCHDOG_UPDATED=//p' <<<"$synthetic_second")"
second_active="$(sed -n 's/^TASK93_WATCHDOG_ACTIVE_COUNT=//p' <<<"$synthetic_second")"
[[ "$second_generated" == '0' && "$second_updated" == '1' && "$second_active" == '1' ]] ||
  fail synthetic_idempotency_failed
record 'TASK93_SYNTHETIC_SECOND_GENERATED=0'
record 'TASK93_SYNTHETIC_SECOND_UPDATED=1'
record 'TASK93_SYNTHETIC_SECOND_ACTIVE=1'

synthetic_resolved="$("$watchdog" --synthetic-resolve)"
printf '%s\n' "$synthetic_resolved"
resolved_count="$(sed -n 's/^TASK93_WATCHDOG_RESOLVED=//p' <<<"$synthetic_resolved")"
resolved_status="$(sed -n 's/^TASK93_WATCHDOG_STATUS=//p' <<<"$synthetic_resolved")"
resolved_active="$(sed -n 's/^TASK93_WATCHDOG_ACTIVE_COUNT=//p' <<<"$synthetic_resolved")"
[[ "$resolved_count" == '1' && "$resolved_status" == 'resolved' && "$resolved_active" == '0' ]] ||
  fail synthetic_resolution_failed
record 'TASK93_SYNTHETIC_RESOLVED=1'
record 'TASK93_SYNTHETIC_ACTIVE_AFTER_RESOLVE=0'

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
record "TASK93_ACTIVE_CRITICAL_AFTER=$active_critical_after"

systemctl is-enabled --quiet salary-postgres-backup.timer || fail backup_timer_not_enabled_after
systemctl is-active --quiet salary-postgres-backup.timer || fail backup_timer_not_active_after
[[ "$(systemctl show salary-postgres-backup.service -p Result --value)" == "$backup_result_before" ]] ||
  fail backup_result_changed
[[ "$(systemctl show salary-postgres-backup.service -p ExecMainStatus --value)" == "$backup_exit_before" ]] ||
  fail backup_exit_changed
for unit in nginx docker postgresql; do
  systemctl is-active --quiet "$unit" || fail "service_not_active_after_${unit}"
done
[[ "$(docker inspect "$api_container" --format '{{.RestartCount}}')" == "$api_restart_before" ]] ||
  fail api_restart_changed
[[ "$(docker inspect "$web_container" --format '{{.RestartCount}}')" == "$web_restart_before" ]] ||
  fail web_restart_changed
[[ "$(docker inspect "$api_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')" == 'healthy' ]] ||
  fail api_not_healthy_after
[[ "$(docker inspect "$web_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')" == 'healthy' ]] ||
  fail web_not_healthy_after

record 'TASK93_BACKUP_TIMER_ENABLED=enabled'
record 'TASK93_BACKUP_TIMER_ACTIVE=active'
record "TASK93_BACKUP_SERVICE_RESULT=$backup_result_before"
record "TASK93_BACKUP_SERVICE_EXIT=$backup_exit_before"
record "TASK93_API_RESTART_AFTER=$api_restart_before"
record "TASK93_WEB_RESTART_AFTER=$web_restart_before"
record 'TASK93_CORE_SERVICES=active'
record 'TASK93_ROLLBACK=not_performed'

rollback_needed=0
rollout_complete=1
record "TASK93_COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
record 'TASK93_PRODUCTION_ROLLOUT=success'
rm -rf -- "$staging_dir"
echo 'TASK93_PRODUCTION_ROLLOUT=success'
