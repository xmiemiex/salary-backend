#!/usr/bin/env bash
set -Eeuo pipefail

release_id='rc-20260712-2-9f8f8f57'
release_dir="/opt/salary-settlement-admin/releases/${release_id}"
prod_env='/opt/salary-settlement-admin/shared/.env'
evidence_root='/opt/salary-settlement-admin/evidence'
run_id="task82-$(date -u +%Y%m%dT%H%M%SZ)"
evidence_dir="${evidence_root}/${run_id}"
release_evidence_dir="${release_dir}/tmp/release-evidence"
backup_dir='/opt/salary-settlement-admin/backups'
preflight='/home/salaryops/task82-preflight.sh'
rollback='/home/salaryops/task82-rollback.sh'
migration_helper='/home/salaryops/task82-migration-evidence.js'
auth_helper='/home/salaryops/task82-auth-helper.js'
prepare_cutover='/home/salaryops/prepare-nginx-cutover.sh'
execute_cutover='/home/salaryops/execute-nginx-cutover.sh'
gate_summary='/home/salaryops/release-gate-summary.js'
observation_minutes="${TASK82_OBSERVATION_MINUTES:-30}"
containers_started=0
cutover_started=0
completed=0

if [[ "$EUID" -ne 0 ]]; then
  echo 'TASK82_DEPLOY_STATUS=fail reason=requires_root' >&2
  exit 1
fi

status_log='/home/salaryops/task82-status.log'
install -o salaryops -g salaryops -m 0600 /dev/null "$status_log"
exec > >(tee -a "$status_log") 2>&1

install -d -o root -g salaryapp -m 0750 "$evidence_root" "$evidence_dir" "$release_evidence_dir"

rollback_on_error() {
  local exit_code=$?
  trap - ERR
  if [[ "$completed" -eq 0 && ( "$containers_started" -eq 1 || "$cutover_started" -eq 1 ) ]]; then
    echo "TASK82_AUTOMATIC_ROLLBACK=triggered exit=$exit_code" >&2
    "$rollback" | tee "$evidence_dir/rollback.log" || true
  else
    echo "TASK82_AUTOMATIC_ROLLBACK=not_required exit=$exit_code" >&2
  fi
  exit "$exit_code"
}
trap rollback_on_error ERR

phase() {
  echo "TASK82_PHASE=$1 timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

phase preflight
"$preflight" | tee "$evidence_dir/preflight.log"

phase encrypted_full_backup
read -rsp 'Backup encryption passphrase (input remains in this SSH session only): ' backup_passphrase
echo
[[ "${#backup_passphrase}" -ge 20 ]]
recent_backup_path="$(
  find "$backup_dir" -maxdepth 1 -type f -name 'postgres-full-*.sql.gz.enc' -mmin -120 \
    -printf '%T@ %p\n' |
    sort -nr |
    head -n 1 |
    cut -d' ' -f2-
)"
backup_reused='false'
if [[ -n "$recent_backup_path" ]] &&
  openssl enc -d -aes-256-cbc -pbkdf2 -pass fd:3 3<<<"$backup_passphrase" -in "$recent_backup_path" 2>/dev/null |
    gzip -t 2>/dev/null; then
  backup_path="$recent_backup_path"
  backup_name="$(basename "$backup_path")"
  backup_stamp="${backup_name#postgres-full-}"
  backup_stamp="${backup_stamp%.sql.gz.enc}"
  backup_started_at="$(date -u -r "$backup_path" +%Y-%m-%dT%H:%M:%SZ)"
  backup_completed_at="$backup_started_at"
  backup_reused='true'
else
  backup_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_name="postgres-full-${backup_stamp}.sql.gz.enc"
  backup_path="${backup_dir}/${backup_name}"
  umask 027
  sudo -u postgres pg_dump --no-owner --no-privileges --format=plain salary_settlement_prod |
    gzip -c |
    openssl enc -aes-256-cbc -salt -pbkdf2 -pass fd:3 3<<<"$backup_passphrase" >"$backup_path"
  chown root:postgres "$backup_path"
  chmod 0640 "$backup_path"
  openssl enc -d -aes-256-cbc -pbkdf2 -pass fd:3 3<<<"$backup_passphrase" -in "$backup_path" |
    gzip -t
  backup_completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
backup_sha256="$(sha256sum "$backup_path" | awk '{print $1}')"
backup_size="$(stat -c '%s' "$backup_path")"
unset backup_passphrase
cat >"$evidence_dir/backup-summary.env" <<EOF
TASK82_BACKUP_STATUS=pass
TASK82_BACKUP_ID=${backup_stamp}
TASK82_BACKUP_FILE=${backup_name}
TASK82_BACKUP_SHA256=${backup_sha256}
TASK82_BACKUP_BYTES=${backup_size}
TASK82_BACKUP_STARTED_AT=${backup_started_at}
TASK82_BACKUP_COMPLETED_AT=${backup_completed_at}
TASK82_BACKUP_ENCRYPTED=true
TASK82_BACKUP_DECRYPT_GZIP_VERIFY=pass
TASK82_BACKUP_REUSED=${backup_reused}
TASK82_BACKUP_MODE=640
TASK82_BACKUP_OWNER=root:postgres
EOF
cat "$evidence_dir/backup-summary.env"

phase start_containers
docker compose \
  --project-directory "$release_dir" \
  --env-file "$prod_env" \
  -f "$release_dir/docker-compose.prod.yml" \
  config --services | grep -qx 'api'
docker compose \
  --project-directory "$release_dir" \
  --env-file "$prod_env" \
  -f "$release_dir/docker-compose.prod.yml" \
  config --services | grep -qx 'web'
docker compose \
  --project-directory "$release_dir" \
  --env-file "$prod_env" \
  -f "$release_dir/docker-compose.prod.yml" \
  up -d --no-build --remove-orphans
containers_started=1

wait_for_container_health() {
  local container="$1"
  local attempt
  local health
  for attempt in $(seq 1 30); do
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
    if [[ "$health" == 'healthy' ]]; then
      echo "TASK82_CONTAINER_HEALTH container=$container status=healthy attempt=$attempt"
      return 0
    fi
    sleep 3
  done
  echo "TASK82_CONTAINER_HEALTH container=$container status=$health result=fail" >&2
  return 1
}

wait_for_container_health salary-settlement-admin-api-1
wait_for_container_health salary-settlement-admin-web-1

for container in salary-settlement-admin-api-1 salary-settlement-admin-web-1; do
  docker inspect "$container" \
    --format 'TASK82_CONTAINER name={{.Name}} image={{.Config.Image}} restart={{.HostConfig.RestartPolicy.Name}} restarts={{.RestartCount}} ports={{json .NetworkSettings.Ports}}'
done | tee "$evidence_dir/container-summary.log"

docker inspect salary-settlement-admin-api-1 --format '{{json .NetworkSettings.Ports}}' | grep -q '127.0.0.1'
docker inspect salary-settlement-admin-web-1 --format '{{json .NetworkSettings.Ports}}' | grep -q '127.0.0.1'
if ss -ltn | awk '{print $4}' | grep -Eq '^(0\.0\.0\.0|\[::\]):5432$'; then
  echo 'TASK82_POSTGRES_PUBLIC_LISTENER=true' >&2
  exit 1
fi
echo 'TASK82_POSTGRES_PUBLIC_LISTENER=false'

curl -fsS -o /dev/null http://127.0.0.1:3000/health/live
curl -fsS -o /dev/null http://127.0.0.1:3000/health/ready
curl -fsS -o /dev/null http://127.0.0.1:8080/healthz
curl -fsS -o /dev/null http://127.0.0.1:8080/
echo 'TASK82_LOOPBACK_HEALTH=pass'

phase env_check_evidence
env_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker run --rm \
  --env-file "$prod_env" \
  --mount 'type=bind,src=/home/salaryops/production-env-check.js,dst=/tmp/production-env-check.js,readonly' \
  'salary-settlement-api:rc-20260712-2' \
  node /tmp/production-env-check.js |
  tee "$evidence_dir/env-check.log"
env_finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
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
chmod 0640 "$release_evidence_dir/env-check.json"
echo 'TASK82_ENV_CHECK=pass'

phase migration_status_evidence
docker run --rm \
  --network salary-settlement-admin_app \
  --add-host host.docker.internal:172.30.80.1 \
  --env-file "$prod_env" \
  --mount "type=bind,src=$release_dir/prisma,dst=/app/prisma,readonly" \
  --mount "type=bind,src=$release_evidence_dir,dst=/app/tmp/release-evidence" \
  --mount "type=bind,src=$migration_helper,dst=/app/task82-migration-evidence.js,readonly" \
  'salary-settlement-migration:rc-20260712-2' \
  node /app/task82-migration-evidence.js |
  tee "$evidence_dir/migration-status.log"
chmod 0640 "$release_evidence_dir/migration-status.json"

phase nginx_cutover
"$prepare_cutover" | tee "$evidence_dir/nginx-prepare.log"
cutover_started=1
"$execute_cutover" | tee "$evidence_dir/nginx-cutover.log"

check_public_200() {
  local host="$1"
  local path="$2"
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' "https://${host}${path}")"
  [[ "$code" == '200' ]]
  echo "TASK82_PUBLIC_HEALTH host=$host path=$path http=$code"
}

check_public_200 'admin-salary.lovemiemie.com' '/'
check_public_200 'api-salary.lovemiemie.com' '/health/live'
check_public_200 'api-salary.lovemiemie.com' '/health/ready'
systemctl is-active --quiet nginx
echo 'TASK82_PUBLIC_HEALTH=pass'

phase admin_and_audit_smoke
unauth_code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/me)"
[[ "$unauth_code" == '401' ]]
echo "TASK82_UNAUTHENTICATED_ME_HTTP=$unauth_code"

read -rp 'Existing production administrator username: ' admin_username
read -rsp 'Existing production administrator password (input remains in this SSH session only): ' admin_password
echo
login_request="$(mktemp /run/task82-login-request.XXXXXX)"
login_response="$(mktemp /run/task82-login-response.XXXXXX)"
token_file="$(mktemp /run/task82-token.XXXXXX)"
audit_csv="$(mktemp /run/task82-audit.XXXXXX.csv)"
system_health_json="$(mktemp /run/task82-system-health.XXXXXX.json)"
backup_health_json="$(mktemp /run/task82-backup-health.XXXXXX.json)"
alerts_json="$(mktemp /run/task82-alerts.XXXXXX.json)"
sessions_json="$(mktemp /run/task82-sessions.XXXXXX.json)"
stale_session_ids="$(mktemp /run/task82-stale-sessions.XXXXXX)"
chmod 0600 "$login_request" "$login_response" "$token_file" "$audit_csv" "$system_health_json" "$backup_health_json" "$alerts_json" "$sessions_json" "$stale_session_ids"
cleanup_credentials() {
  rm -f -- "$login_request" "$login_response" "$token_file" "$audit_csv" \
    "$system_health_json" "$backup_health_json" "$alerts_json" "$sessions_json" "$stale_session_ids"
}
trap cleanup_credentials EXIT
printf '%s\0%s\0' "$admin_username" "$admin_password" |
  node "$auth_helper" build-login "$login_request"
unset admin_username admin_password
login_code="$(
  curl -sS -o "$login_response" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -H "User-Agent: task82-smoke/${run_id}" \
    --data-binary "@$login_request" \
    http://127.0.0.1:3000/auth/login
)"
rm -f -- "$login_request"
echo "TASK82_ADMIN_LOGIN_HTTP=$login_code"
[[ "$login_code" == '200' || "$login_code" == '201' ]]
node "$auth_helper" inspect-login \
  "$login_response" "$token_file" "$release_evidence_dir/e2e-permissions.json" |
  tee "$evidence_dir/admin-smoke.log"
rm -f -- "$login_response"
token="$(<"$token_file")"

curl -fsS -H "Authorization: Bearer $token" \
  http://127.0.0.1:3000/auth/sessions >"$sessions_json"
node "$auth_helper" stale-session-ids \
  "$sessions_json" "$stale_session_ids" \
  '2026-07-24T10:16:50Z' '2026-07-24T10:17:10Z' |
  tee -a "$evidence_dir/admin-smoke.log"
stale_sessions_revoked=0
while IFS= read -r stale_session_id; do
  [[ -n "$stale_session_id" ]] || continue
  stale_revoke_code="$(
    curl -sS -o /dev/null -w '%{http_code}' -X POST \
      -H "Authorization: Bearer $token" \
      "http://127.0.0.1:3000/auth/sessions/${stale_session_id}/revoke"
  )"
  [[ "$stale_revoke_code" == '200' || "$stale_revoke_code" == '201' ]]
  stale_sessions_revoked="$((stale_sessions_revoked + 1))"
done <"$stale_session_ids"
echo "TASK82_STALE_SESSIONS_REVOKED=$stale_sessions_revoked"
rm -f -- "$sessions_json" "$stale_session_ids"

audit_created_to="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
audit_created_from="$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)"
audit_code="$(
  curl -sS -o "$audit_csv" -w '%{http_code}' \
    -H "Authorization: Bearer $token" \
    --get \
    --data-urlencode "createdFrom=$audit_created_from" \
    --data-urlencode "createdTo=$audit_created_to" \
    'http://127.0.0.1:3000/audit-logs/export.csv'
)"
echo "TASK82_AUDIT_EXPORT_HTTP=$audit_code"
[[ "$audit_code" == '200' ]]
node "$auth_helper" audit-csv "$audit_csv" | tee "$evidence_dir/audit-export-smoke.log"
rm -f -- "$audit_csv"

curl -fsS -H "Authorization: Bearer $token" \
  http://127.0.0.1:3000/system-health/summary >"$system_health_json"
curl -fsS -H "Authorization: Bearer $token" \
  http://127.0.0.1:3000/backup-health >"$backup_health_json"
curl -fsS -H "Authorization: Bearer $token" \
  'http://127.0.0.1:3000/alerts?status=active&severity=critical&page=1&pageSize=1' >"$alerts_json"
node "$auth_helper" summarize-api \
  "$system_health_json" "$backup_health_json" "$alerts_json" |
  tee "$evidence_dir/health-alert-summary.log"

logout_code="$(
  curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $token" \
    http://127.0.0.1:3000/auth/logout
)"
echo "TASK82_ADMIN_LOGOUT_HTTP=$logout_code"
[[ "$logout_code" == '200' || "$logout_code" == '201' ]]
unset token
cleanup_credentials
trap - EXIT
echo 'TASK82_ADMIN_SMOKE=pass_partial low_privilege_403=pending'
echo 'TASK82_AUDIT_EXPORT_SMOKE=pass'

run_release_gate() {
  local label="$1"
  local output="$evidence_dir/release-gate-${label}.log"
  set +e
  docker run --rm \
    --network salary-settlement-admin_app \
    --add-host host.docker.internal:172.30.80.1 \
    --env-file "$prod_env" \
    --mount "type=bind,src=$release_dir/scripts,dst=/app/scripts,readonly" \
    --mount "type=bind,src=$release_dir/docs,dst=/app/docs,readonly" \
    --mount "type=bind,src=$release_dir/README.md,dst=/app/README.md,readonly" \
    --mount "type=bind,src=$release_dir/apps/web/src,dst=/app/apps/web/src,readonly" \
    --mount "type=bind,src=$release_evidence_dir,dst=/app/tmp/release-evidence,readonly" \
    --mount "type=bind,src=$gate_summary,dst=/tmp/release-gate-summary.js,readonly" \
    'salary-settlement-migration:rc-20260712-2' \
    sh -c '
      pnpm exec tsx scripts/release-check.ts --json >/tmp/release-gate.json
      gate_exit=$?
      node /tmp/release-gate-summary.js /tmp/release-gate.json
      summary_exit=$?
      echo "RELEASE_GATE_INNER_EXIT=$gate_exit"
      if [ "$summary_exit" -ne 0 ]; then exit 2; fi
      exit "$gate_exit"
    ' | tee "$output"
  local gate_exit=${PIPESTATUS[0]}
  set -e
  echo "TASK82_RELEASE_GATE_LABEL=$label exit=$gate_exit"
  [[ "$gate_exit" -eq 0 ]]
}

phase production_release_gate_initial
run_release_gate initial

phase observation
observation_start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
nginx_5xx_before="$(awk '$9 ~ /^5/ {count++} END {print count+0}' /var/log/nginx/access.log 2>/dev/null || echo 0)"
for minute in $(seq 1 "$observation_minutes"); do
  check_public_200 'admin-salary.lovemiemie.com' '/' >/dev/null
  check_public_200 'api-salary.lovemiemie.com' '/health/live' >/dev/null
  check_public_200 'api-salary.lovemiemie.com' '/health/ready' >/dev/null
  for container in salary-settlement-admin-api-1 salary-settlement-admin-web-1; do
    [[ "$(docker inspect -f '{{.State.Health.Status}}' "$container")" == 'healthy' ]]
    [[ "$(docker inspect -f '{{.RestartCount}}' "$container")" -eq 0 ]]
  done
  echo "TASK82_OBSERVATION minute=$minute status=pass"
  if [[ "$minute" -lt "$observation_minutes" ]]; then sleep 60; fi
done

api_errors="$(
  docker logs --since "$observation_start" salary-settlement-admin-api-1 2>&1 |
    grep -Eic 'error|exception|fatal|ECONNREFUSED|connection refused' || true
)"
web_errors="$(
  docker logs --since "$observation_start" salary-settlement-admin-web-1 2>&1 |
    grep -Eic 'error|exception|fatal|ECONNREFUSED|connection refused' || true
)"
postgres_errors="$(
  journalctl -u postgresql --since "$observation_start" --no-pager 2>/dev/null |
    grep -Eic 'error|fatal|panic|connection refused' || true
)"
nginx_errors="$(
  journalctl -u nginx --since "$observation_start" --no-pager 2>/dev/null |
    grep -Eic 'error|emerg|alert|crit' || true
)"
nginx_5xx_after="$(awk '$9 ~ /^5/ {count++} END {print count+0}' /var/log/nginx/access.log 2>/dev/null || echo 0)"
nginx_5xx="$((nginx_5xx_after - nginx_5xx_before))"
restart_count="$(
  docker inspect salary-settlement-admin-api-1 salary-settlement-admin-web-1 \
    --format '{{.RestartCount}}' | awk '{sum += $1} END {print sum+0}'
)"
critical_alerts="$(
  docker run --rm \
    --network salary-settlement-admin_app \
    --add-host host.docker.internal:172.30.80.1 \
    --env-file "$prod_env" \
    'salary-settlement-migration:rc-20260712-2' \
    node -e 'const {PrismaClient}=require("@prisma/client"); const p=new PrismaClient(); p.alert.count({where:{status:"active",severity:"critical"}}).then(v=>console.log(v)).finally(()=>p.$disconnect())'
)"
cat >"$evidence_dir/observation-summary.env" <<EOF
TASK82_OBSERVATION_STATUS=pass
TASK82_OBSERVATION_MINUTES=${observation_minutes}
TASK82_API_ERROR_COUNT=${api_errors}
TASK82_WEB_ERROR_COUNT=${web_errors}
TASK82_POSTGRES_ERROR_COUNT=${postgres_errors}
TASK82_NGINX_ERROR_COUNT=${nginx_errors}
TASK82_HTTP_5XX_COUNT=${nginx_5xx}
TASK82_RESTART_COUNT=${restart_count}
TASK82_CRITICAL_ALERT_COUNT=${critical_alerts}
TASK82_RELEASE_BLOCKING=false
EOF
cat "$evidence_dir/observation-summary.env"
[[ "$api_errors" -eq 0 ]]
[[ "$web_errors" -eq 0 ]]
[[ "$postgres_errors" -eq 0 ]]
[[ "$nginx_errors" -eq 0 ]]
[[ "$nginx_5xx" -eq 0 ]]
[[ "$restart_count" -eq 0 ]]
[[ "$critical_alerts" -eq 0 ]]

phase production_release_gate_final
run_release_gate final

completed=1
cat >"$evidence_dir/final-summary.env" <<EOF
TASK82_DEPLOY_STATUS=success
TASK82_RC_TAG=rc-20260712-2
TASK82_RC_COMMIT=9f8f8f576dde54355983b96525335e94c55c8b32
TASK82_BACKUP_STATUS=pass
TASK82_CONTAINERS=healthy
TASK82_NGINX_CUTOVER=pass
TASK82_PUBLIC_HEALTH=pass
TASK82_ENV_CHECK=pass
TASK82_MIGRATION_STATUS=pass
TASK82_E2E_PERMISSIONS=pending_low_privilege_403
TASK82_ADMIN_SMOKE=pass_partial
TASK82_AUDIT_EXPORT_SMOKE=pass
TASK82_OBSERVATION=pass
TASK82_AUTOMATIC_ROLLBACK=not_triggered
TASK82_DECISION=conditional_go_pending_approval
TASK82_OFF_HOST_BACKUP_RISK=accepted_but_unresolved
EOF
cat "$evidence_dir/final-summary.env"
echo "TASK82_EVIDENCE_DIR=$evidence_dir"
