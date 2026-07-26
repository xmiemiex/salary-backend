#!/usr/bin/env bash
set -uo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo 'TASK85_ERROR=run_through_sudo' >&2
  exit 1
fi

label="${1:-immediate}"
audit_mode="${2:-no-audit}"
case "$label" in
  immediate) horizon_minutes=60 ;;
  t1h) horizon_minutes=60 ;;
  t6h) horizon_minutes=360 ;;
  t12h) horizon_minutes=720 ;;
  t24h) horizon_minutes=1440 ;;
  *) echo 'TASK85_ERROR=invalid_label' >&2; exit 2 ;;
esac
case "$audit_mode" in
  audit|no-audit) ;;
  *) echo 'TASK85_ERROR=invalid_audit_mode' >&2; exit 2 ;;
esac

release_dir='/opt/salary-settlement-admin/releases/rc-20260712-2-9f8f8f57'
prod_env='/opt/salary-settlement-admin/shared/.env'
task84_evidence='/opt/salary-settlement-admin/evidence/task84-20260724T114915Z/release-evidence'
evidence_root='/opt/salary-settlement-admin/evidence/task85-post-go'
helper='/home/salaryops/task85-helper.js'
env_helper='/home/salaryops/production-env-check.js'
migration_helper='/home/salaryops/task82-migration-evidence.js'
api_container='salary-settlement-admin-api-1'
web_container='salary-settlement-admin-web-1'
run_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
run_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run_dir="${evidence_root}/${label}-${run_stamp}"
release_evidence_dir="${run_dir}/release-evidence"
execution_log="${run_dir}/execution.log"
summary_file="${run_dir}/summary.env"

install -d -m 0750 -o root -g salaryops "$evidence_root" "$run_dir" "$release_evidence_dir"
printf '%s\n' "$run_dir" >/home/salaryops/task85-last-run-dir
chown salaryops:salaryops /home/salaryops/task85-last-run-dir
chmod 0600 /home/salaryops/task85-last-run-dir
touch "$execution_log"
chown root:salaryops "$execution_log"
chmod 0640 "$execution_log"
exec > >(tee -a "$execution_log") 2>&1

failures=()
record_failure() {
  failures+=("$1")
}
expect_eq() {
  local name="$1"
  local actual="$2"
  local expected="$3"
  echo "${name}=${actual}"
  if [[ "$actual" != "$expected" ]]; then
    record_failure "$name"
  fi
}

count_matches() {
  local pattern="$1"
  grep -Eic "$pattern" || true
}

nginx_window_counts() {
  local minutes="$1"
  python3 - "$minutes" <<'PY'
import datetime
import re
import sys

minutes = int(sys.argv[1])
now = datetime.datetime.now(datetime.timezone.utc)
cutoff = now - datetime.timedelta(minutes=minutes)
counts = {"5xx": 0, "401": 0, "403": 0, "error": 0}

try:
    with open("/var/log/nginx/access.log", "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            match = re.search(r"\[([^\]]+)\].*\"\s+(\d{3})\s", line)
            if not match:
                continue
            try:
                when = datetime.datetime.strptime(match.group(1), "%d/%b/%Y:%H:%M:%S %z")
            except ValueError:
                continue
            if when < cutoff:
                continue
            status = int(match.group(2))
            if 500 <= status <= 599:
                counts["5xx"] += 1
            if status == 401:
                counts["401"] += 1
            if status == 403:
                counts["403"] += 1
except FileNotFoundError:
    pass

try:
    with open("/var/log/nginx/error.log", "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            match = re.match(r"(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})", line)
            if not match:
                continue
            try:
                when = datetime.datetime.strptime(match.group(1), "%Y/%m/%d %H:%M:%S").replace(tzinfo=datetime.timezone.utc)
            except ValueError:
                continue
            if when >= cutoff:
                counts["error"] += 1
except FileNotFoundError:
    pass

print(counts["5xx"], counts["401"], counts["403"], counts["error"])
PY
}

echo "TASK85_LABEL=$label"
echo "TASK85_STARTED_AT=$run_started"
echo "TASK85_HOSTNAME=$(hostname)"
echo "TASK85_EXECUTOR=salaryops_via_sudo"
echo 'TASK85_REDEPLOYMENT=not_performed'
echo 'TASK85_SERVICE_RESTART=not_performed'
echo 'TASK85_NGINX_SWITCH=not_performed'
echo 'TASK85_MIGRATION_DEPLOY=not_performed'
echo 'TASK85_BUSINESS_DATA_WRITE=not_performed'

nginx_state="$(systemctl is-active nginx 2>/dev/null || true)"
docker_state="$(systemctl is-active docker 2>/dev/null || true)"
postgres_state="$(systemctl is-active postgresql 2>/dev/null || true)"
backup_timer_active="$(systemctl is-active salary-postgres-backup.timer 2>/dev/null || true)"
backup_timer_enabled="$(systemctl is-enabled salary-postgres-backup.timer 2>/dev/null || true)"
failed_units="$(systemctl --failed --no-legend --plain 2>/dev/null | awk 'NF {count++} END {print count+0}')"
expect_eq SERVICE_NGINX "$nginx_state" active
expect_eq SERVICE_DOCKER "$docker_state" active
expect_eq SERVICE_POSTGRESQL "$postgres_state" active
expect_eq FAILED_SYSTEMD_UNITS "$failed_units" 0
expect_eq BACKUP_TIMER_ACTIVE "$backup_timer_active" active
expect_eq BACKUP_TIMER_ENABLED "$backup_timer_enabled" enabled
echo "BACKUP_TIMER_LAST_TRIGGER=$(systemctl show salary-postgres-backup.timer -p LastTriggerUSec --value 2>/dev/null || echo unknown)"
echo "BACKUP_TIMER_NEXT_TRIGGER=$(systemctl show salary-postgres-backup.timer -p NextElapseUSecRealtime --value 2>/dev/null || echo unknown)"

for container in "$api_container" "$web_container"; do
  status="$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo missing)"
  health="$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo missing)"
  restarts="$(docker inspect -f '{{.RestartCount}}' "$container" 2>/dev/null || echo -1)"
  image="$(docker inspect -f '{{.Config.Image}}' "$container" 2>/dev/null || echo missing)"
  safe_name="${container#salary-settlement-admin-}"
  safe_name="${safe_name%-1}"
  safe_name="${safe_name^^}"
  expect_eq "CONTAINER_${safe_name}_STATUS" "$status" running
  expect_eq "CONTAINER_${safe_name}_HEALTH" "$health" healthy
  expect_eq "CONTAINER_${safe_name}_RESTARTS" "$restarts" 0
  echo "CONTAINER_${safe_name}_IMAGE=$image"
done

nginx_target="$(readlink -f /etc/nginx/sites-enabled/salary-baseline 2>/dev/null || echo missing)"
echo "NGINX_TARGET=$nginx_target"
if [[ "$nginx_target" != '/etc/nginx/sites-available/salary-production-rc-20260712-2' ]]; then
  record_failure NGINX_TARGET
fi

public_check() {
  local name="$1"
  local host="$2"
  local path="$3"
  local result
  result="$(curl -sS -o /dev/null -w '%{http_code}|%{ssl_verify_result}' "https://${host}${path}" 2>/dev/null || echo '000|failed')"
  local code="${result%%|*}"
  local tls="${result##*|}"
  expect_eq "PUBLIC_${name}_HTTP" "$code" 200
  expect_eq "PUBLIC_${name}_TLS_VERIFY" "$tls" 0
}
public_check ADMIN admin-salary.lovemiemie.com /
public_check API_LIVE api-salary.lovemiemie.com /health/live
public_check API_READY api-salary.lovemiemie.com /health/ready

public_postgres_listeners="$(
  ss -lntH 2>/dev/null |
    awk '$4 ~ /(^0\.0\.0\.0:5432$|^\[::\]:5432$|^\*:5432$)/ {count++} END {print count+0}'
)"
expect_eq POSTGRES_PUBLIC_LISTENERS "$public_postgres_listeners" 0

disk_used_percent="$(df -P / | awk 'NR==2 {gsub(/%/, "", $5); print $5}')"
memory_used_percent="$(free | awk '/^Mem:/ {printf "%.0f", (($2-$7)/$2)*100}')"
echo "DISK_USED_PERCENT=$disk_used_percent"
echo "MEMORY_USED_PERCENT=$memory_used_percent"
if [[ "$disk_used_percent" -ge 90 ]]; then record_failure DISK_USED_PERCENT; fi
if [[ "$memory_used_percent" -ge 95 ]]; then record_failure MEMORY_USED_PERCENT; fi

read -r nginx_5xx_15 nginx_401_15 nginx_403_15 nginx_error_15 < <(nginx_window_counts 15)
read -r nginx_5xx_horizon nginx_401_horizon nginx_403_horizon nginx_error_horizon < <(nginx_window_counts "$horizon_minutes")
api_errors_15="$(docker logs --since 15m "$api_container" 2>&1 | count_matches 'error|exception|fatal|econnrefused|database connection|too many connections')"
web_errors_15="$(docker logs --since 15m "$web_container" 2>&1 | count_matches 'error|exception|fatal|econnrefused|upstream.*failed')"
db_errors_15="$(journalctl -u postgresql --since '15 minutes ago' --no-pager 2>/dev/null | count_matches 'error|fatal|panic|connection.*failed|too many connections')"
api_errors_horizon="$(docker logs --since "${horizon_minutes}m" "$api_container" 2>&1 | count_matches 'error|exception|fatal|econnrefused|database connection|too many connections')"
web_errors_horizon="$(docker logs --since "${horizon_minutes}m" "$web_container" 2>&1 | count_matches 'error|exception|fatal|econnrefused|upstream.*failed')"
db_errors_horizon="$(journalctl -u postgresql --since "${horizon_minutes} minutes ago" --no-pager 2>/dev/null | count_matches 'error|fatal|panic|connection.*failed|too many connections')"
oom_diskfull_horizon="$(journalctl --since "${horizon_minutes} minutes ago" --no-pager 2>/dev/null | count_matches 'out of memory|oom-killer|no space left on device|disk full')"

echo 'LOG_WINDOW_15M_BEGIN'
echo "NGINX_5XX_COUNT=$nginx_5xx_15"
echo "NGINX_ERROR_COUNT=$nginx_error_15"
echo "NGINX_401_COUNT=$nginx_401_15"
echo "NGINX_403_COUNT=$nginx_403_15"
echo "API_ERROR_COUNT=$api_errors_15"
echo "WEB_ERROR_COUNT=$web_errors_15"
echo "POSTGRES_ERROR_COUNT=$db_errors_15"
echo 'LOG_WINDOW_15M_END'
echo "LOG_WINDOW_HORIZON_MINUTES=$horizon_minutes"
echo "HORIZON_NGINX_5XX_COUNT=$nginx_5xx_horizon"
echo "HORIZON_NGINX_ERROR_COUNT=$nginx_error_horizon"
echo "HORIZON_NGINX_401_COUNT=$nginx_401_horizon"
echo "HORIZON_NGINX_403_COUNT=$nginx_403_horizon"
echo "HORIZON_API_ERROR_COUNT=$api_errors_horizon"
echo "HORIZON_WEB_ERROR_COUNT=$web_errors_horizon"
echo "HORIZON_POSTGRES_ERROR_COUNT=$db_errors_horizon"
echo "HORIZON_OOM_DISK_FULL_COUNT=$oom_diskfull_horizon"

auth_15="$((nginx_401_15 + nginx_403_15))"
auth_horizon="$((nginx_401_horizon + nginx_403_horizon))"
auth_anomaly=false
if [[ "$auth_15" -gt 20 && "$auth_15" -gt "$((auth_horizon / 2))" ]]; then
  auth_anomaly=true
fi
echo "AUTH_401_403_ANOMALY=$auth_anomaly"
if [[ "$nginx_5xx_15" -gt 0 || "$nginx_error_15" -gt 0 || "$api_errors_15" -gt 0 || "$web_errors_15" -gt 0 || "$db_errors_15" -gt 0 || "$oom_diskfull_horizon" -gt 0 || "$auth_anomaly" == true ]]; then
  record_failure LOG_OR_RESOURCE_ANOMALY
fi

if [[ -f "$task84_evidence/e2e-permissions.json" ]]; then
  cp -- "$task84_evidence/e2e-permissions.json" "$release_evidence_dir/e2e-permissions.json"
  chmod 0640 "$release_evidence_dir/e2e-permissions.json"
else
  record_failure TASK84_E2E_EVIDENCE_MISSING
fi

env_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker run --rm \
  --env-file "$prod_env" \
  --mount "type=bind,src=$env_helper,dst=/tmp/production-env-check.js,readonly" \
  salary-settlement-api:rc-20260712-2 \
  node /tmp/production-env-check.js >"$run_dir/env-check.log" 2>&1
env_exit=$?
env_finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
grep -E '^ENV_CHECK_SUMMARY|^ENV_CHECK_FAILED_NAMES' "$run_dir/env-check.log" || true
if [[ "$env_exit" -eq 0 ]]; then
  cat >"$release_evidence_dir/env-check.json" <<EOF
{
  "schemaVersion": 1,
  "type": "env-check",
  "command": "production redacted environment check",
  "startedAt": "${env_started}",
  "finishedAt": "${env_finished}",
  "status": "pass",
  "environment": "production",
  "checkedVariables": 23,
  "invalid": [],
  "missing": []
}
EOF
else
  record_failure ENV_CHECK
fi
chmod 0640 "$run_dir/env-check.log"

docker run --rm \
  --network salary-settlement-admin_app \
  --add-host host.docker.internal:172.30.80.1 \
  --env-file "$prod_env" \
  --mount "type=bind,src=$release_dir/prisma,dst=/app/prisma,readonly" \
  --mount "type=bind,src=$release_evidence_dir,dst=/app/tmp/release-evidence" \
  --mount "type=bind,src=$migration_helper,dst=/app/task82-migration-evidence.js,readonly" \
  salary-settlement-migration:rc-20260712-2 \
  node /app/task82-migration-evidence.js >"$run_dir/migration-status.log" 2>&1
migration_exit=$?
grep -E '^TASK82_MIGRATION_STATUS|^TASK82_MIGRATIONS_' "$run_dir/migration-status.log" || true
if [[ "$migration_exit" -ne 0 ]]; then record_failure MIGRATION_STATUS; fi
chmod 0640 "$run_dir/migration-status.log"

docker run --rm \
  --network salary-settlement-admin_app \
  --add-host host.docker.internal:172.30.80.1 \
  --env-file "$prod_env" \
  --mount "type=bind,src=$helper,dst=/app/task85-helper.js,readonly" \
  salary-settlement-migration:rc-20260712-2 \
  node /app/task85-helper.js db-summary >"$run_dir/database-summary.log" 2>&1
db_summary_exit=$?
cat "$run_dir/database-summary.log"
if [[ "$db_summary_exit" -ne 0 ]]; then record_failure DATABASE_SUMMARY; fi
chmod 0640 "$run_dir/database-summary.log"

docker run --rm \
  --network salary-settlement-admin_app \
  --add-host host.docker.internal:172.30.80.1 \
  --env-file "$prod_env" \
  --mount "type=bind,src=$release_dir/scripts,dst=/app/scripts,readonly" \
  --mount "type=bind,src=$release_dir/docs,dst=/app/docs,readonly" \
  --mount "type=bind,src=$release_dir/README.md,dst=/app/README.md,readonly" \
  --mount "type=bind,src=$release_dir/apps/web/src,dst=/app/apps/web/src,readonly" \
  --mount "type=bind,src=$release_evidence_dir,dst=/app/tmp/release-evidence,readonly" \
  --mount "type=bind,src=$helper,dst=/tmp/task85-helper.js,readonly" \
  salary-settlement-migration:rc-20260712-2 \
  sh -c '
    pnpm exec tsx scripts/release-check.ts --json >/tmp/release-gate.json
    gate_exit=$?
    node /tmp/task85-helper.js gate-summary /tmp/release-gate.json
    helper_exit=$?
    echo "RELEASE_GATE_INNER_EXIT=$gate_exit"
    if [ "$helper_exit" -ne 0 ]; then exit 2; fi
    exit "$gate_exit"
  ' >"$run_dir/release-gate-summary.log" 2>&1
gate_exit=$?
cat "$run_dir/release-gate-summary.log"
if [[ "$gate_exit" -ne 0 ]]; then record_failure RELEASE_GATE; fi
gate_warning="$(awk -F= '$1=="RELEASE_GATE_WARNING" {print $2}' "$run_dir/release-gate-summary.log" | tail -n 1)"
gate_fail="$(awk -F= '$1=="RELEASE_GATE_FAIL" {print $2}' "$run_dir/release-gate-summary.log" | tail -n 1)"
if [[ "${gate_warning:-unknown}" != '0' || "${gate_fail:-unknown}" != '0' ]]; then
  record_failure RELEASE_GATE_REGRESSION
fi
chmod 0640 "$run_dir/release-gate-summary.log"

audit_status=not_requested
audit_count=-1
audit_bytes=-1
audit_sensitive=unknown
if [[ "$audit_mode" == 'audit' ]]; then
  login_request="$(mktemp /run/task85-login-request.XXXXXX)"
  login_response="$(mktemp /run/task85-login-response.XXXXXX)"
  token_file="$(mktemp /run/task85-token.XXXXXX)"
  audit_csv="$(mktemp /run/task85-audit.XXXXXX.csv)"
  chmod 0600 "$login_request" "$login_response" "$token_file" "$audit_csv"
  token=''
  cleanup_audit() {
    if [[ -n "${token:-}" ]]; then
      curl -sS -o /dev/null -X POST -H "Authorization: Bearer $token" http://127.0.0.1:3000/auth/logout || true
    fi
    unset token
    rm -f -- "$login_request" "$login_response" "$token_file" "$audit_csv"
  }
  trap cleanup_audit EXIT
  read -rp 'Existing production super_admin username (not logged): ' admin_username
  read -rsp 'Existing production super_admin password (not logged): ' admin_password
  echo
  printf '%s\0%s\0' "$admin_username" "$admin_password" |
    node "$helper" build-login "$login_request"
  unset admin_username admin_password
  login_code="$(
    curl -sS -o "$login_response" -w '%{http_code}' \
      -H 'Content-Type: application/json' \
      -H "User-Agent: task85-post-go/${label}" \
      --data-binary "@$login_request" \
      http://127.0.0.1:3000/auth/login
  )"
  rm -f -- "$login_request"
  echo "TASK85_ADMIN_LOGIN_HTTP=$login_code"
  if [[ "$login_code" == '200' || "$login_code" == '201' ]]; then
    if node "$helper" inspect-login "$login_response" "$token_file"; then
      token="$(<"$token_file")"
      audit_created_to="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      audit_created_from="$(date -u -d '15 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
      audit_code="$(
        curl -sS -o "$audit_csv" -w '%{http_code}' \
          -H "Authorization: Bearer $token" \
          --get \
          --data-urlencode "createdFrom=$audit_created_from" \
          --data-urlencode "createdTo=$audit_created_to" \
          'http://127.0.0.1:3000/audit-logs/export.csv'
      )"
      echo "TASK85_AUDIT_EXPORT_HTTP=$audit_code"
      if [[ "$audit_code" == '200' ]] && node "$helper" audit-csv "$audit_csv" >"$run_dir/audit-export-smoke.log" 2>&1; then
        cat "$run_dir/audit-export-smoke.log"
        audit_status=pass
        audit_count="$(awk -F= '$1=="TASK85_AUDIT_EXPORTED_COUNT" {print $2}' "$run_dir/audit-export-smoke.log")"
        audit_bytes="$(awk -F= '$1=="TASK85_AUDIT_CSV_BYTES" {print $2}' "$run_dir/audit-export-smoke.log")"
        audit_sensitive="$(awk -F= '$1=="TASK85_AUDIT_SENSITIVE_LEAK" {print $2}' "$run_dir/audit-export-smoke.log")"
      else
        audit_status=fail
        record_failure AUDIT_EXPORT_SMOKE
      fi
    else
      audit_status=fail
      record_failure ADMIN_LOGIN_PERMISSION_CHAIN
    fi
  else
    audit_status=fail
    record_failure ADMIN_LOGIN
  fi
  if [[ -n "$token" ]]; then
    logout_code="$(
      curl -sS -o /dev/null -w '%{http_code}' -X POST \
        -H "Authorization: Bearer $token" \
        http://127.0.0.1:3000/auth/logout
    )"
    echo "TASK85_ADMIN_LOGOUT_HTTP=$logout_code"
    if [[ "$logout_code" != '200' && "$logout_code" != '201' ]]; then
      record_failure ADMIN_LOGOUT
    fi
    token=''
  fi
  cleanup_audit
  trap - EXIT
fi

run_finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
release_blocking=false
status=pass
if [[ "${#failures[@]}" -gt 0 ]]; then
  status=fail
  release_blocking=true
fi
failure_codes=none
if [[ "${#failures[@]}" -gt 0 ]]; then
  failure_codes="$(IFS=,; echo "${failures[*]}")"
fi

cat >"$summary_file" <<EOF
TASK85_STATUS=${status}
TASK85_LABEL=${label}
TASK85_STARTED_AT=${run_started}
TASK85_FINISHED_AT=${run_finished}
TASK85_EVIDENCE_PATH=${run_dir}
TASK85_RELEASE_BLOCKING=${release_blocking}
TASK85_FAILURE_CODES=${failure_codes}
TASK85_PUBLIC_ADMIN_HTTP=$(awk -F= '$1=="PUBLIC_ADMIN_HTTP" {print $2}' "$execution_log" | tail -n 1)
TASK85_PUBLIC_API_LIVE_HTTP=$(awk -F= '$1=="PUBLIC_API_LIVE_HTTP" {print $2}' "$execution_log" | tail -n 1)
TASK85_PUBLIC_API_READY_HTTP=$(awk -F= '$1=="PUBLIC_API_READY_HTTP" {print $2}' "$execution_log" | tail -n 1)
TASK85_NGINX_5XX_15M=${nginx_5xx_15}
TASK85_NGINX_ERROR_15M=${nginx_error_15}
TASK85_API_ERROR_15M=${api_errors_15}
TASK85_WEB_ERROR_15M=${web_errors_15}
TASK85_POSTGRES_ERROR_15M=${db_errors_15}
TASK85_HORIZON_MINUTES=${horizon_minutes}
TASK85_HORIZON_NGINX_5XX=${nginx_5xx_horizon}
TASK85_HORIZON_NGINX_ERROR=${nginx_error_horizon}
TASK85_HORIZON_API_ERROR=${api_errors_horizon}
TASK85_HORIZON_WEB_ERROR=${web_errors_horizon}
TASK85_HORIZON_POSTGRES_ERROR=${db_errors_horizon}
TASK85_HORIZON_OOM_DISK_FULL=${oom_diskfull_horizon}
TASK85_AUTH_401_403_ANOMALY=${auth_anomaly}
TASK85_RELEASE_GATE_PASS=$(awk -F= '$1=="RELEASE_GATE_PASS" {print $2}' "$run_dir/release-gate-summary.log" | tail -n 1)
TASK85_RELEASE_GATE_WARNING=$(awk -F= '$1=="RELEASE_GATE_WARNING" {print $2}' "$run_dir/release-gate-summary.log" | tail -n 1)
TASK85_RELEASE_GATE_FAIL=$(awk -F= '$1=="RELEASE_GATE_FAIL" {print $2}' "$run_dir/release-gate-summary.log" | tail -n 1)
TASK85_RELEASE_GATE_EXIT=${gate_exit}
TASK85_ACTIVE_ADMIN_USERS=$(awk -F= '$1=="ACTIVE_ADMIN_USERS" {print $2}' "$run_dir/database-summary.log")
TASK85_ACTIVE_SUPER_ADMIN_USERS=$(awk -F= '$1=="ACTIVE_SUPER_ADMIN_USERS" {print $2}' "$run_dir/database-summary.log")
TASK85_ACTIVE_LOW_PRIVILEGE_ADMIN_USERS=$(awk -F= '$1=="ACTIVE_LOW_PRIVILEGE_ADMIN_USERS" {print $2}' "$run_dir/database-summary.log")
TASK85_TASK84_TEMP_ACCOUNT_DISABLED=$(awk -F= '$1=="TASK84_TEMP_ACCOUNT_DISABLED" {print $2}' "$run_dir/database-summary.log")
TASK85_TASK84_TEMP_ACCOUNT_ACTIVE=$(awk -F= '$1=="TASK84_TEMP_ACCOUNT_ACTIVE" {print $2}' "$run_dir/database-summary.log")
TASK85_TASK84_TEMP_ACCOUNT_ACTIVE_SESSIONS=$(awk -F= '$1=="TASK84_TEMP_ACCOUNT_ACTIVE_SESSIONS" {print $2}' "$run_dir/database-summary.log")
TASK85_PERMISSIONS=$(awk -F= '$1=="PERMISSIONS" {print $2}' "$run_dir/database-summary.log")
TASK85_ACTIVE_CRITICAL_ALERTS=$(awk -F= '$1=="ACTIVE_CRITICAL_ALERTS" {print $2}' "$run_dir/database-summary.log")
TASK85_BACKUP_TIMER_ACTIVE=${backup_timer_active}
TASK85_BACKUP_TIMER_ENABLED=${backup_timer_enabled}
TASK85_LATEST_FULL_BACKUP_AT=$(awk -F= '$1=="LATEST_FULL_BACKUP_AT" {print $2}' "$run_dir/database-summary.log")
TASK85_LATEST_FULL_BACKUP_AGE_HOURS=$(awk -F= '$1=="LATEST_FULL_BACKUP_AGE_HOURS" {print $2}' "$run_dir/database-summary.log")
TASK85_LATEST_RESTORE_DRILL_AT=$(awk -F= '$1=="LATEST_RESTORE_DRILL_AT" {print $2}' "$run_dir/database-summary.log")
TASK85_LATEST_RESTORE_DRILL_AGE_DAYS=$(awk -F= '$1=="LATEST_RESTORE_DRILL_AGE_DAYS" {print $2}' "$run_dir/database-summary.log")
TASK85_AUDIT_EXPORT_STATUS=${audit_status}
TASK85_AUDIT_EXPORTED_COUNT=${audit_count}
TASK85_AUDIT_CSV_BYTES=${audit_bytes}
TASK85_AUDIT_SENSITIVE_LEAK=${audit_sensitive}
TASK85_OFF_HOST_BACKUP_RISK=accepted_but_unresolved
EOF
chown root:salaryops "$summary_file" "$execution_log" "$run_dir"/*.log 2>/dev/null || true
chmod 0640 "$summary_file" "$execution_log" "$run_dir"/*.log 2>/dev/null || true
chmod 0750 "$run_dir" "$release_evidence_dir"

sensitive_matches="$(
  grep -ERiac \
    'postgres(ql)?://[^[:space:]]+:[^[:space:]]+@|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|Authorization:[[:space:]]*Bearer[[:space:]]+[A-Za-z0-9]|"token"[[:space:]]*:[[:space:]]*"[^"]+"|"password"[[:space:]]*:[[:space:]]*"[^"]+"' \
    "$run_dir" --exclude='*.json' 2>/dev/null |
    awk -F: '{sum += $2} END {print sum+0}'
)"
echo "TASK85_SENSITIVE_LEAK_MATCHES=$sensitive_matches" | tee -a "$summary_file"
cp -- "$summary_file" /home/salaryops/task85-latest-summary.env
chown salaryops:salaryops /home/salaryops/task85-latest-summary.env
chmod 0600 /home/salaryops/task85-latest-summary.env
if [[ "$sensitive_matches" -ne 0 ]]; then
  echo 'TASK85_SENSITIVE_SCAN=fail'
  exit 1
fi
echo 'TASK85_SENSITIVE_SCAN=pass'
cat "$summary_file"
echo "TASK85_EVIDENCE_PATH=$run_dir"

if [[ "$status" != 'pass' ]]; then
  exit 1
fi
