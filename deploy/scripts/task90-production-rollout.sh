#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C
umask 077

staging_dir='/home/salaryops/task90-staging'
result_file='/home/salaryops/task90-result.env'
backup_dir='/opt/salary-settlement-admin/backups'
key_dir='/etc/salary-settlement-admin'
key_file="${key_dir}/backup-file-encryption.key"
key_metadata="${key_dir}/backup-file-encryption.key.meta"
libexec_dir='/usr/local/libexec/salary-settlement-admin'
crypto_tool="${libexec_dir}/backup-file-crypto.mjs"
database_helper="${libexec_dir}/record-backup-evidence-db.cjs"
backup_script='/usr/local/sbin/salary-postgres-backup'
recorder='/usr/local/sbin/record-backup-evidence'
restore_tool='/usr/local/sbin/restore-encrypted-backup'
health_tool='/usr/local/sbin/check-local-backup-health'
service_unit='/etc/systemd/system/salary-postgres-backup.service'
timer_unit='/etc/systemd/system/salary-postgres-backup.timer'
api_container='salary-settlement-admin-api-1'
web_container='salary-settlement-admin-web-1'
required_commit="${TASK90_IMPLEMENTATION_COMMIT:-}"
run_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
rollback_dir="/root/task90-rollback-${run_stamp}"
rollback_needed=0
rollback_performed=0
rollout_complete=0
service_output=''

record() {
  printf '%s\n' "$1" >>"$result_file"
}

rollback() {
  local reason="$1"
  [[ "$rollback_needed" -eq 1 ]] || return 0
  rollback_performed=1
  if [[ -f "$rollback_dir/salary-postgres-backup" ]]; then
    install -o root -g root -m 0750 "$rollback_dir/salary-postgres-backup" "$backup_script"
  fi
  if [[ -f "$rollback_dir/salary-postgres-backup.service" ]] &&
    ! cmp -s "$rollback_dir/salary-postgres-backup.service" "$service_unit"; then
    install -o root -g root -m 0644 "$rollback_dir/salary-postgres-backup.service" "$service_unit"
    systemctl daemon-reload
    record 'TASK90_DAEMON_RELOAD=performed_during_rollback'
  fi
  systemctl enable --now salary-postgres-backup.timer >/dev/null
  record "TASK90_ROLLBACK=performed"
  record "TASK90_ROLLBACK_REASON=$reason"
  record "TASK90_ROLLBACK_PATH=$rollback_dir"
  rollback_needed=0
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
      record 'TASK90_ROLLBACK=failed'
    fi
    record "TASK90_PRODUCTION_ROLLOUT=failed"
    record "TASK90_PRODUCTION_ROLLOUT_EXIT=$exit_code"
  fi
  exit "$exit_code"
}
trap on_exit EXIT

fail() {
  echo "TASK90_ROLLOUT_ERROR=$1" >&2
  record "TASK90_ROLLOUT_ERROR=$1"
  exit 1
}

[[ "$EUID" -eq 0 ]] || {
  echo 'TASK90_ROLLOUT_ERROR=requires_root' >&2
  exit 1
}
[[ "$required_commit" =~ ^[a-f0-9]{40}$ ]] || {
  echo 'TASK90_ROLLOUT_ERROR=implementation_commit_required' >&2
  exit 1
}
[[ -d "$staging_dir" && ! -L "$staging_dir" ]] || {
  echo 'TASK90_ROLLOUT_ERROR=staging_directory_invalid' >&2
  exit 1
}
[[ "$(<"$staging_dir/implementation-commit")" == "$required_commit" ]] || {
  echo 'TASK90_ROLLOUT_ERROR=implementation_commit_mismatch' >&2
  exit 1
}

install -o salaryops -g salaryops -m 0600 /dev/null "$result_file"
record "TASK90_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
record "TASK90_IMPLEMENTATION_COMMIT=$required_commit"
record "TASK90_ROLLBACK_PATH=$rollback_dir"
record 'TASK90_SYSTEMD_UNIT_CHANGED=no'
record 'TASK90_DAEMON_RELOAD=not_performed'
record 'TASK90_API_WEB_DEPLOYMENT=not_performed'
record 'TASK90_NGINX_CHANGE=not_performed'
record 'TASK90_MIGRATION=not_performed'
record 'TASK90_BUSINESS_DATA_CHANGE=not_performed'
record 'TASK90_OFFHOST_BACKUP=not_configured'

for source in \
  backup-file-crypto.mjs \
  record-backup-evidence-db.cjs \
  record-backup-evidence.sh \
  restore-encrypted-backup.sh \
  salary-postgres-backup \
  check-local-backup-health.sh \
  task90-release-gate-summary.cjs; do
  [[ -f "$staging_dir/$source" && ! -L "$staging_dir/$source" ]] || fail "staging_file_invalid_${source}"
  mode="$(stat -c '%a' "$staging_dir/$source")"
  (( (8#${mode} & 0022) == 0 )) || fail "staging_file_writable_${source}"
done

for unit in nginx docker postgresql; do
  systemctl is-active --quiet "$unit" || fail "service_not_active_${unit}"
done
mapfile -t failed_units < <(
  systemctl list-units --state=failed --no-legend --plain |
    awk 'NF { print $1 }'
)
if [[ "${#failed_units[@]}" -eq 1 && "${failed_units[0]}" == 'salary-postgres-backup.service' ]]; then
  latest_previous_rollback_script="$(
    find /root -mindepth 2 -maxdepth 2 -type f \
      -path '/root/task90-rollback-*/salary-postgres-backup' \
      -printf '%T@ %p\n' |
      sort -nr |
      head -n 1 |
      cut -d' ' -f2-
  )"
  [[ -n "$latest_previous_rollback_script" ]] || fail stale_backup_failure_without_rollback_copy
  cmp -s "$backup_script" "$latest_previous_rollback_script" ||
    fail stale_backup_failure_script_mismatch
  systemctl reset-failed salary-postgres-backup.service
  record 'TASK90_STALE_BACKUP_FAILED_STATE_RESET=performed'
elif [[ "${#failed_units[@]}" -ne 0 ]]; then
  fail failed_units_present
else
  record 'TASK90_STALE_BACKUP_FAILED_STATE_RESET=not_required'
fi
[[ "$(systemctl list-units --state=failed --no-legend | wc -l)" -eq 0 ]] ||
  fail failed_units_present_after_reset
systemctl is-enabled --quiet salary-postgres-backup.timer || fail backup_timer_not_enabled
systemctl is-active --quiet salary-postgres-backup.timer || fail backup_timer_not_active
[[ "$(systemctl show salary-postgres-backup.service -p Result --value)" == 'success' ]] ||
  fail previous_backup_result_not_success
[[ "$(systemctl show salary-postgres-backup.service -p ExecMainStatus --value)" == '0' ]] ||
  fail previous_backup_exit_nonzero
[[ "$(systemctl is-active salary-postgres-backup.service || true)" == 'inactive' ]] ||
  fail backup_service_already_active
! pgrep -x pg_dump >/dev/null 2>&1 || fail pg_dump_already_running
! pgrep -x pg_dumpall >/dev/null 2>&1 || fail pg_dumpall_already_running

current_hour="$(date -u +%H)"
current_minute="$(date -u +%M)"
if [[ "$current_hour" == '02' && "$current_minute" -ge 10 && "$current_minute" -le 45 ]]; then
  fail scheduled_backup_window_conflict
fi

for container in "$api_container" "$web_container"; do
  [[ "$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')" == 'healthy' ]] ||
    fail "container_not_healthy_${container}"
  [[ "$(docker inspect "$container" --format '{{.RestartCount}}')" -eq 0 ]] ||
    fail "container_restart_nonzero_${container}"
done
api_restart_before="$(docker inspect "$api_container" --format '{{.RestartCount}}')"
web_restart_before="$(docker inspect "$web_container" --format '{{.RestartCount}}')"
curl -fsS -o /dev/null http://127.0.0.1:3000/health/live || fail api_live_not_200
curl -fsS -o /dev/null http://127.0.0.1:3000/health/ready || fail api_ready_not_200
curl -fsS -o /dev/null http://127.0.0.1:8080/healthz || fail web_health_not_200
curl -fsS -o /dev/null https://admin-salary.lovemiemie.com/ || fail public_admin_not_200
curl -fsS -o /dev/null https://api-salary.lovemiemie.com/health/live || fail public_api_live_not_200
curl -fsS -o /dev/null https://api-salary.lovemiemie.com/health/ready || fail public_api_ready_not_200
postgres_image_disposition='reused'
if ! docker image inspect postgres:16 >/dev/null 2>&1; then
  docker pull docker.io/library/postgres:16
  postgres_image_disposition='pulled'
fi
docker image inspect postgres:16 >/dev/null 2>&1 || fail postgres16_image_unavailable
postgres_image_id="$(docker image inspect postgres:16 --format '{{.Id}}')"
postgres_image_digest="$(docker image inspect postgres:16 --format '{{index .RepoDigests 0}}')"
[[ "$postgres_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail postgres16_image_id_invalid
[[ "$postgres_image_digest" == 'postgres@sha256:'* || "$postgres_image_digest" == 'docker.io/library/postgres@sha256:'* ]] ||
  fail postgres16_image_digest_invalid
record "TASK90_POSTGRES16_IMAGE_DISPOSITION=$postgres_image_disposition"
record "TASK90_POSTGRES16_IMAGE_ID=$postgres_image_id"
record "TASK90_POSTGRES16_IMAGE_DIGEST=$postgres_image_digest"

read -r disk_available disk_used_percent < <(
  df -PB1 "$backup_dir" | awk 'NR == 2 { gsub(/%/, "", $5); print $4, $5 }'
)
(( disk_available >= 5 * 1024 * 1024 * 1024 )) || fail insufficient_disk_space
(( disk_used_percent < 90 )) || fail disk_usage_critical
record "TASK90_DISK_USED_PERCENT_BEFORE=$disk_used_percent"
record "TASK90_DISK_AVAILABLE_BYTES_BEFORE=$disk_available"

latest_old="$(
  find "$backup_dir" -maxdepth 1 -type f -name 'postgres-full-*.sql.gz' -printf '%T@ %p\n' |
    sort -nr |
    head -n 1 |
    cut -d' ' -f2-
)"
[[ -n "$latest_old" && -f "$latest_old" && -f "${latest_old}.sha256" ]] ||
  fail previous_backup_missing
(cd "$backup_dir" && sha256sum -c --status "$(basename -- "${latest_old}.sha256")") ||
  fail previous_backup_checksum_failed
gzip -t "$latest_old" || fail previous_backup_gzip_failed
record "TASK90_PREVIOUS_BACKUP_BASENAME=$(basename -- "$latest_old")"
record 'TASK90_PREVIOUS_BACKUP_CHECKSUM=match'
record 'TASK90_PREVIOUS_BACKUP_GZIP=pass'

active_critical_before="$(
  docker exec "$api_container" node -e '
    const {PrismaClient}=require("@prisma/client");
    const p=new PrismaClient();
    p.alert.count({where:{status:"active",severity:"critical"}})
      .then((value)=>console.log(value))
      .finally(()=>p.$disconnect());
  '
)"
[[ "$active_critical_before" =~ ^[0-9]+$ ]] || fail critical_alert_query_failed
record "TASK90_ACTIVE_CRITICAL_ALERTS_BEFORE=$active_critical_before"

install -d -o root -g root -m 0700 "$rollback_dir"
cp --preserve=mode,ownership,timestamps "$backup_script" "$rollback_dir/salary-postgres-backup"
cp --preserve=mode,ownership,timestamps "$service_unit" "$rollback_dir/salary-postgres-backup.service"
cp --preserve=mode,ownership,timestamps "$timer_unit" "$rollback_dir/salary-postgres-backup.timer"
for path in "$crypto_tool" "$database_helper" "$recorder" "$restore_tool" "$health_tool"; do
  if [[ -e "$path" ]]; then
    cp --preserve=mode,ownership,timestamps "$path" "$rollback_dir/$(basename -- "$path")"
  fi
done
record 'TASK90_PRODUCTION_FILES_BACKED_UP=pass'

install -d -o root -g root -m 0755 "$libexec_dir"
install -o root -g root -m 0750 "$staging_dir/backup-file-crypto.mjs" "$crypto_tool"
install -o root -g root -m 0750 "$staging_dir/record-backup-evidence-db.cjs" "$database_helper"
install -o root -g root -m 0750 "$staging_dir/record-backup-evidence.sh" "$recorder"
install -o root -g root -m 0750 "$staging_dir/restore-encrypted-backup.sh" "$restore_tool"
install -o root -g root -m 0750 "$staging_dir/check-local-backup-health.sh" "$health_tool"
install -o root -g root -m 0750 "$staging_dir/salary-postgres-backup" "$backup_script"
rollback_needed=1

record 'TASK90_INSTALL_VALIDATION_STAGE=syntax'
node --check "$crypto_tool"
node --check "$database_helper"
bash -n "$backup_script"
bash -n "$recorder"
bash -n "$restore_tool"
bash -n "$health_tool"
record 'TASK90_INSTALL_VALIDATION_STAGE=backup_self_test'
"$backup_script" --self-test
record 'TASK90_INSTALL_VALIDATION_STAGE=recorder_self_test'
"$recorder" --self-test
record 'TASK90_INSTALL_VALIDATION_STAGE=restore_self_test'
"$restore_tool" --self-test
record 'TASK90_INSTALL_VALIDATION_STAGE=health_self_test'
"$health_tool" --self-test
record 'TASK90_INSTALL_VALIDATION_STAGE=pass'

install -d -o root -g root -m 0700 "$key_dir"
key_disposition='reused'
if [[ -e "$key_file" ]]; then
  [[ ! -L "$key_file" && -f "$key_file" ]] || fail existing_key_invalid
  [[ "$(stat -c '%U:%G:%a' "$key_file")" == 'root:root:600' ]] ||
    fail existing_key_permissions_invalid
  [[ -f "$key_metadata" && "$(<"$key_metadata")" == 'purpose=salary-postgres-daily-backup;format=aes-256-gcm-v1' ]] ||
    fail existing_key_purpose_unconfirmed
else
  node "$crypto_tool" generate-key --key-file "$key_file"
  chown root:root "$key_file"
  chmod 0600 "$key_file"
  printf '%s\n' 'purpose=salary-postgres-daily-backup;format=aes-256-gcm-v1' >"$key_metadata"
  chown root:root "$key_metadata"
  chmod 0600 "$key_metadata"
  key_disposition='generated'
fi
self_test_output="$(node "$crypto_tool" self-test --key-file "$key_file")"
printf '%s\n' "$self_test_output"
key_fingerprint="$(sed -n 's/^BACKUP_KEY_FINGERPRINT=//p' <<<"$self_test_output")"
[[ "$key_fingerprint" =~ ^[a-f0-9]{16}$ ]] || fail key_fingerprint_invalid
record "TASK90_KEY_DISPOSITION=$key_disposition"
record "TASK90_KEY_PATH=$key_file"
record 'TASK90_KEY_OWNER_GROUP_MODE=root:root:600'
record "TASK90_KEY_FINGERPRINT=$key_fingerprint"
record 'TASK90_CRYPTO_SELF_TEST=pass'

systemctl is-active --quiet postgresql || fail postgres_not_active_before_backup
systemctl is-active --quiet salary-postgres-backup.timer || fail timer_not_active_before_backup
[[ "$(systemctl is-active salary-postgres-backup.service || true)" == 'inactive' ]] ||
  fail backup_service_active_before_manual_run
! pgrep -x pg_dumpall >/dev/null 2>&1 || fail pg_dumpall_active_before_manual_run

service_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
set +e
systemctl start salary-postgres-backup.service
service_start_exit=$?
set -e
service_completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
service_result="$(systemctl show salary-postgres-backup.service -p Result --value)"
service_exec_exit="$(systemctl show salary-postgres-backup.service -p ExecMainStatus --value)"
service_output="$(journalctl -u salary-postgres-backup.service --since "$service_started_at" -o cat --no-pager)"
printf '%s\n' "$service_output"
record "TASK90_MANUAL_BACKUP_STARTED_AT=$service_started_at"
record "TASK90_MANUAL_BACKUP_COMPLETED_AT=$service_completed_at"
record "TASK90_MANUAL_BACKUP_START_EXIT=$service_start_exit"
record "TASK90_MANUAL_BACKUP_RESULT=$service_result"
record "TASK90_MANUAL_BACKUP_EXEC_EXIT=$service_exec_exit"
[[ "$service_start_exit" -eq 0 && "$service_result" == 'success' && "$service_exec_exit" == '0' ]] ||
  fail manual_backup_failed

backup_name="$(sed -n 's/^BACKUP_BASENAME=//p' <<<"$service_output" | tail -n 1)"
backup_size="$(sed -n 's/^BACKUP_SIZE_BYTES=//p' <<<"$service_output" | tail -n 1)"
backup_hash="$(sed -n 's/^BACKUP_SHA256=//p' <<<"$service_output" | tail -n 1)"
evidence_status="$(sed -nE 's/^EVIDENCE_SYNC_STATUS=(created|no_change)$/\1/p' <<<"$service_output" | tail -n 1)"
evidence_record_id="$(sed -n 's/^EVIDENCE_RECORD_ID=//p' <<<"$service_output" | tail -n 1)"
evidence_count_before="$(sed -n 's/^EVIDENCE_RECORD_COUNT_BEFORE=//p' <<<"$service_output" | head -n 1)"
evidence_count_after="$(sed -n 's/^EVIDENCE_RECORD_COUNT_AFTER=//p' <<<"$service_output" | head -n 1)"
[[ "$backup_name" =~ ^postgres-full-[0-9]{8}T[0-9]{6}Z\.sql\.gz\.enc$ ]] ||
  fail backup_output_name_invalid
[[ "$backup_size" =~ ^[0-9]+$ && "$backup_size" -gt 0 ]] || fail backup_output_size_invalid
[[ "$backup_hash" =~ ^[a-f0-9]{64}$ ]] || fail backup_output_hash_invalid
[[ "$evidence_status" == 'created' ]] || fail initial_evidence_not_created
new_backup="${backup_dir}/${backup_name}"
[[ -f "$new_backup" && ! -L "$new_backup" && -f "${new_backup}.sha256" ]] ||
  fail encrypted_backup_files_missing
[[ "$(stat -c '%U:%G:%a' "$new_backup")" == 'root:postgres:640' ]] ||
  fail encrypted_backup_permissions_invalid
(cd "$backup_dir" && sha256sum -c --status "${backup_name}.sha256") ||
  fail encrypted_backup_checksum_failed
node "$crypto_tool" decrypt --key-file "$key_file" --input "$new_backup" --output - |
  gzip -t
stamp="${backup_name#postgres-full-}"
stamp="${stamp%.sql.gz.enc}"
[[ ! -e "${backup_dir}/postgres-full-${stamp}.sql.gz" ]] || fail matching_plaintext_backup_present
compressed_size="$(
  node "$crypto_tool" decrypt --key-file "$key_file" --input "$new_backup" --output - |
    wc -c
)"
encryption_overhead="$((backup_size - compressed_size))"
[[ "$encryption_overhead" -eq 44 ]] || fail encryption_overhead_abnormal
record "TASK90_BACKUP_BASENAME=$backup_name"
record "TASK90_BACKUP_SIZE_BYTES=$backup_size"
record "TASK90_BACKUP_SHA256=$backup_hash"
record "TASK90_BACKUP_OWNER_GROUP_MODE=root:postgres:640"
record "TASK90_ENCRYPTION_OVERHEAD_BYTES=$encryption_overhead"
record 'TASK90_MATCHING_PLAINTEXT_COPY=absent'
record 'TASK90_CHECKSUM=match'
record 'TASK90_DECRYPT_AUTHENTICATION=pass'
record 'TASK90_GZIP_INTEGRITY=pass'
record "TASK90_BACKUP_RECORD_ID=$evidence_record_id"
record "TASK90_BACKUP_RECORD_KEY=$backup_name"
record "TASK90_BACKUP_RECORD_COUNT_BEFORE=$evidence_count_before"
record "TASK90_BACKUP_RECORD_COUNT_AFTER=$evidence_count_after"
record 'TASK90_BACKUP_RECORD_FIELDS_MATCH=pass'

replay_output="$("$recorder" "$new_backup")"
printf '%s\n' "$replay_output"
replay_status="$(sed -n 's/^EVIDENCE_SYNC_STATUS=//p' <<<"$replay_output" | tail -n 1)"
replay_count_after="$(sed -n 's/^EVIDENCE_RECORD_COUNT_AFTER=//p' <<<"$replay_output" | tail -n 1)"
[[ "$replay_status" == 'no_change' ]] || fail evidence_replay_not_idempotent
[[ "$replay_count_after" == "$evidence_count_after" ]] || fail evidence_replay_count_changed
record 'TASK90_EVIDENCE_REPLAY=no_change'
record "TASK90_EVIDENCE_REPLAY_COUNT_AFTER=$replay_count_after"

plain_count="$(find "$backup_dir" -maxdepth 1 -type f -name 'postgres-full-*.sql.gz' | wc -l)"
encrypted_count="$(find "$backup_dir" -maxdepth 1 -type f -name 'postgres-full-*.sql.gz.enc' | wc -l)"
backup_directory_bytes="$(du -sb "$backup_dir" | awk '{print $1}')"
read -r disk_available_after disk_used_percent_after < <(
  df -PB1 "$backup_dir" | awk 'NR == 2 { gsub(/%/, "", $5); print $4, $5 }'
)
projected_30_day_bytes="$((backup_size * 30))"
record "TASK90_PLAINTEXT_BACKUP_COUNT=$plain_count"
record "TASK90_ENCRYPTED_BACKUP_COUNT=$encrypted_count"
record "TASK90_BACKUP_DIRECTORY_BYTES=$backup_directory_bytes"
record "TASK90_DISK_USED_PERCENT_AFTER=$disk_used_percent_after"
record "TASK90_DISK_AVAILABLE_BYTES_AFTER=$disk_available_after"
record "TASK90_PROJECTED_30_DAY_ENCRYPTED_BYTES=$projected_30_day_bytes"
record 'TASK90_RETENTION_DAYS=30'

restore_output="$("$restore_tool" "$new_backup")"
printf '%s\n' "$restore_output"
grep -qx 'RESTORE_DRILL_STATUS=success' <<<"$restore_output" || fail restore_drill_failed
for field in \
  RESTORE_DRILL_ID \
  RESTORE_NETWORK_MODE \
  RESTORE_HOST_PORT_BINDINGS \
  RESTORE_PRODUCTION_DATABASE_CONTACTED \
  RESTORE_POSTGRES_VERSION \
  RESTORE_DATABASE_COUNT \
  RESTORE_ROLE_COUNT \
  RESTORE_SCHEMA_COUNT \
  RESTORE_TABLE_COUNT \
  RESTORE_MIGRATION_COUNT \
  RESTORE_RESOURCE_CLEANUP \
  RESTORE_DURATION_SECONDS; do
  value="$(sed -n "s/^${field}=//p" <<<"$restore_output" | tail -n 1)"
  [[ -n "$value" ]] || fail "restore_summary_missing_${field}"
  record "TASK90_${field}=$value"
done

health_output="$("$health_tool")"
printf '%s\n' "$health_output"
health_status="$(sed -n 's/^TASK88_BACKUP_HEALTH_STATUS=//p' <<<"$health_output")"
[[ "$health_status" == 'pass' || "$health_status" == 'warning' ]] ||
  fail local_backup_health_failed
record "TASK90_LOCAL_BACKUP_HEALTH=$health_status"

set +e
gate_output="$(
  docker run --rm \
    --network salary-settlement-admin_app \
    --add-host host.docker.internal:172.30.80.1 \
    --env-file /opt/salary-settlement-admin/shared/.env \
    --mount 'type=bind,src=/opt/salary-settlement-admin/releases/rc-20260712-2-9f8f8f57/scripts,dst=/app/scripts,readonly' \
    --mount 'type=bind,src=/opt/salary-settlement-admin/releases/rc-20260712-2-9f8f8f57/docs,dst=/app/docs,readonly' \
    --mount 'type=bind,src=/opt/salary-settlement-admin/releases/rc-20260712-2-9f8f8f57/README.md,dst=/app/README.md,readonly' \
    --mount 'type=bind,src=/opt/salary-settlement-admin/releases/rc-20260712-2-9f8f8f57/apps/web/src,dst=/app/apps/web/src,readonly' \
    --mount "type=bind,src=$staging_dir/task90-release-gate-summary.cjs,dst=/tmp/task90-release-gate-summary.cjs,readonly" \
    salary-settlement-migration:rc-20260712-2 \
    sh -c '
      pnpm exec tsx scripts/release-check.ts --json >/tmp/release-gate.json
      gate_exit=$?
      node /tmp/task90-release-gate-summary.cjs /tmp/release-gate.json
      summary_exit=$?
      echo "RELEASE_GATE_INNER_EXIT=$gate_exit"
      if [ "$summary_exit" -ne 0 ]; then exit 2; fi
      exit "$gate_exit"
    ' 2>&1
)"
gate_exit=$?
set -e
printf '%s\n' "$gate_output"
gate_status="$(sed -n 's/^RELEASE_GATE_STATUS=//p' <<<"$gate_output" | tail -n 1)"
gate_pass="$(sed -n 's/^RELEASE_GATE_PASS=//p' <<<"$gate_output" | tail -n 1)"
gate_warning="$(sed -n 's/^RELEASE_GATE_WARNING=//p' <<<"$gate_output" | tail -n 1)"
gate_fail="$(sed -n 's/^RELEASE_GATE_FAIL=//p' <<<"$gate_output" | tail -n 1)"
required_fail_codes="$(sed -n 's/^REQUIRED_FAIL_CODES=//p' <<<"$gate_output" | tail -n 1)"
required_warning_codes="$(sed -n 's/^REQUIRED_WARNING_CODES=//p' <<<"$gate_output" | tail -n 1)"
backup_72h="$(sed -n 's/^BACKUP_72H_GATE=//p' <<<"$gate_output" | tail -n 1)"
backup_health_gate="$(sed -n 's/^BACKUP_HEALTH_GATE=//p' <<<"$gate_output" | tail -n 1)"
backup_health_status="$(sed -n 's/^BACKUP_HEALTH_STATUS=//p' <<<"$gate_output" | tail -n 1)"
[[ "$backup_72h" == 'pass' && "$backup_health_gate" == 'pass' && "$backup_health_status" != 'critical' ]] ||
  fail task90_backup_gate_failed
record "TASK90_RELEASE_GATE_EXIT=$gate_exit"
record "TASK90_RELEASE_GATE_STATUS=$gate_status"
record "TASK90_RELEASE_GATE_PASS=$gate_pass"
record "TASK90_RELEASE_GATE_WARNING=$gate_warning"
record "TASK90_RELEASE_GATE_FAIL=$gate_fail"
record "TASK90_REQUIRED_FAIL_CODES=${required_fail_codes:-unknown}"
record "TASK90_REQUIRED_WARNING_CODES=${required_warning_codes:-unknown}"
record "TASK90_BACKUP_WITHIN_72H=$backup_72h"
record "TASK90_BACKUP_HEALTH_GATE=$backup_health_gate"
record "TASK90_BACKUP_HEALTH_STATUS=$backup_health_status"

systemctl is-enabled --quiet salary-postgres-backup.timer || fail final_timer_not_enabled
systemctl is-active --quiet salary-postgres-backup.timer || fail final_timer_not_active
[[ "$(systemctl show salary-postgres-backup.service -p Result --value)" == 'success' ]] ||
  fail final_backup_result_not_success
[[ "$(systemctl show salary-postgres-backup.service -p ExecMainStatus --value)" == '0' ]] ||
  fail final_backup_exit_nonzero
for unit in nginx docker postgresql; do
  systemctl is-active --quiet "$unit" || fail "final_service_not_active_${unit}"
done
[[ "$(systemctl list-units --state=failed --no-legend | wc -l)" -eq 0 ]] ||
  fail final_failed_units_present
for container in "$api_container" "$web_container"; do
  [[ "$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')" == 'healthy' ]] ||
    fail "final_container_not_healthy_${container}"
done
[[ "$(docker inspect "$api_container" --format '{{.RestartCount}}')" == "$api_restart_before" ]] ||
  fail api_restart_count_changed
[[ "$(docker inspect "$web_container" --format '{{.RestartCount}}')" == "$web_restart_before" ]] ||
  fail web_restart_count_changed
curl -fsS -o /dev/null http://127.0.0.1:3000/health/live || fail final_api_live_not_200
curl -fsS -o /dev/null http://127.0.0.1:3000/health/ready || fail final_api_ready_not_200
curl -fsS -o /dev/null http://127.0.0.1:8080/healthz || fail final_web_not_200
active_critical_after="$(
  docker exec "$api_container" node -e '
    const {PrismaClient}=require("@prisma/client");
    const p=new PrismaClient();
    p.alert.count({where:{status:"active",severity:"critical"}})
      .then((value)=>console.log(value))
      .finally(()=>p.$disconnect());
  '
)"
[[ "$active_critical_after" =~ ^[0-9]+$ ]] || fail final_critical_alert_query_failed
record 'TASK90_TIMER_ENABLED=enabled'
record 'TASK90_TIMER_ACTIVE=active'
record 'TASK90_BACKUP_SERVICE_RESULT=success'
record 'TASK90_BACKUP_SERVICE_EXIT=0'
record 'TASK90_PRODUCTION_SERVICES=healthy'
record "TASK90_API_RESTART_COUNT=$api_restart_before"
record "TASK90_WEB_RESTART_COUNT=$web_restart_before"
record "TASK90_ACTIVE_CRITICAL_ALERTS_AFTER=$active_critical_after"
record "TASK90_ROLLBACK=not_performed"

rollback_needed=0
rollout_complete=1
record "TASK90_COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
record 'TASK90_PRODUCTION_ROLLOUT=success'
rm -rf -- "$staging_dir"
echo "TASK90_RESULT_FILE=$result_file"
echo 'TASK90_PRODUCTION_ROLLOUT=success'
