#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo 'PRODUCTION_PERMISSIONS_SMOKE_ERROR=run_through_sudo' >&2
  exit 1
fi

helper='/home/salaryops/production-permissions-smoke-helper.js'
evidence_dir='/opt/salary-settlement-admin/evidence/release-gate-current'
status_log='/home/salaryops/production-permissions-smoke-status.log'
run_id="task91-permissions-$(date -u +%Y%m%dT%H%M%SZ)"
run_dir="/opt/salary-settlement-admin/evidence/${run_id}"
work_dir="$(mktemp -d /run/task91-permissions.XXXXXX)"
super_token_file="$work_dir/super.token"
low_token_file="$work_dir/low.token"
user_id_file="$work_dir/user.id"
temporary_password_file="$work_dir/low.password"
temp_active=0
core_complete=0

chmod 0700 "$work_dir"
install -d -m 0750 -o root -g salaryops "$evidence_dir" "$run_dir"
touch "$status_log"
chown root:salaryops "$status_log"
chmod 0640 "$status_log"
exec > >(tee -a "$status_log") 2>&1

cleanup() {
  local exit_code=$?
  set +e
  if [[ -s "$low_token_file" ]]; then
    low_cleanup_code="$(
      curl -sS -o /dev/null -w '%{http_code}' -X POST \
        -H "Authorization: Bearer $(<"$low_token_file")" \
        http://127.0.0.1:3000/auth/logout-all
    )"
    if [[ "$low_cleanup_code" == '200' || "$low_cleanup_code" == '201' || "$low_cleanup_code" == '401' ]]; then
      echo 'PRODUCTION_PERMISSIONS_EMERGENCY_LOW_SESSION_CLEANUP=pass'
    else
      echo 'PRODUCTION_PERMISSIONS_EMERGENCY_LOW_SESSION_CLEANUP=fail'
      exit_code=1
    fi
  fi
  if [[ "$temp_active" -eq 1 && -s "$super_token_file" && -s "$user_id_file" ]]; then
    cleanup_code="$(
      curl -sS -o /dev/null -w '%{http_code}' -X POST \
        -H "Authorization: Bearer $(<"$super_token_file")" \
        "http://127.0.0.1:3000/admin-users/$(<"$user_id_file")/disable"
    )"
    if [[ "$cleanup_code" == '200' || "$cleanup_code" == '201' || "$cleanup_code" == '409' ]]; then
      echo 'PRODUCTION_PERMISSIONS_EMERGENCY_ACCOUNT_DISABLE=pass'
    else
      echo 'PRODUCTION_PERMISSIONS_EMERGENCY_ACCOUNT_DISABLE=fail'
      exit_code=1
    fi
  fi
  if [[ -s "$super_token_file" ]]; then
    super_cleanup_code="$(
      curl -sS -o /dev/null -w '%{http_code}' -X POST \
        -H "Authorization: Bearer $(<"$super_token_file")" \
        http://127.0.0.1:3000/auth/logout
    )"
    if [[ "$super_cleanup_code" == '200' || "$super_cleanup_code" == '201' || "$super_cleanup_code" == '401' ]]; then
      echo 'PRODUCTION_PERMISSIONS_EMERGENCY_SUPER_SESSION_CLEANUP=pass'
    else
      echo 'PRODUCTION_PERMISSIONS_EMERGENCY_SUPER_SESSION_CLEANUP=fail'
      exit_code=1
    fi
  fi
  find "$work_dir" -type f -exec shred -u {} + 2>/dev/null || true
  rm -rf -- "$work_dir"
  if [[ "$core_complete" -ne 1 ]]; then
    echo 'PRODUCTION_PERMISSIONS_SMOKE_COMPLETE=fail'
  fi
  exit "$exit_code"
}
trap cleanup EXIT

check_public_200() {
  local host="$1"
  local path="$2"
  local result
  result="$(curl -sS -o /dev/null -w '%{http_code}|%{ssl_verify_result}' "https://${host}${path}")"
  [[ "$result" == '200|0' ]]
}

echo "PRODUCTION_PERMISSIONS_SMOKE_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo 'PRODUCTION_PERMISSIONS_SMOKE_MODE=existing_account_real_401_403'
echo 'PRODUCTION_PERMISSIONS_REDEPLOYMENT=not_performed'
echo 'PRODUCTION_PERMISSIONS_SERVICE_RESTART=not_performed'
echo 'PRODUCTION_PERMISSIONS_MIGRATION=not_performed'
echo 'PRODUCTION_PERMISSIONS_BUSINESS_DATA_CHANGE=not_performed'

systemctl is-active --quiet nginx
systemctl is-active --quiet docker
systemctl is-active --quiet postgresql
for container in salary-settlement-admin-api-1 salary-settlement-admin-web-1; do
  [[ "$(docker inspect -f '{{.State.Status}}' "$container")" == 'running' ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$container")" == 'healthy' ]]
done
check_public_200 admin-salary.lovemiemie.com /
check_public_200 api-salary.lovemiemie.com /health/live
check_public_200 api-salary.lovemiemie.com /health/ready
echo 'PRODUCTION_PERMISSIONS_PREFLIGHT=pass'

smoke_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
unauth_code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/me)"
node "$helper" check-http UNAUTHENTICATED_401 "$unauth_code" 401

read -rp 'Existing production super_admin username (not logged): ' super_username
read -rsp 'Existing production super_admin password (not logged): ' super_password
echo
super_login_request="$work_dir/super-login.json"
super_login_response="$work_dir/super-login-response.json"
printf '%s\0%s\0' "$super_username" "$super_password" |
  node "$helper" build-login "$super_login_request"
unset super_username super_password
super_login_code="$(
  curl -sS -o "$super_login_response" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -H "User-Agent: production-permissions-smoke/${run_id}" \
    --data-binary "@$super_login_request" \
    http://127.0.0.1:3000/auth/login
)"
rm -f -- "$super_login_request"
node "$helper" check-success-http SUPER_ADMIN_LOGIN "$super_login_code"
node "$helper" inspect-super "$super_login_response" "$super_token_file"
rm -f -- "$super_login_response"
super_token="$(<"$super_token_file")"

super_gate_read="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $super_token" \
    http://127.0.0.1:3000/release-gate
)"
node "$helper" check-http SUPER_ADMIN_RELEASE_GATE_READ "$super_gate_read" 200

active_before="$work_dir/active-before.json"
roles_json="$work_dir/roles.json"
role_file="$work_dir/role.json"
existing_user_json="$work_dir/existing-user.json"
curl -fsS -H "Authorization: Bearer $super_token" \
  'http://127.0.0.1:3000/admin-users?status=active&page=1&pageSize=100' >"$active_before"
node "$helper" admin-summary "$active_before"
curl -fsS -H "Authorization: Bearer $super_token" \
  'http://127.0.0.1:3000/roles?status=active&page=1&pageSize=100' >"$roles_json"
node "$helper" select-minimal-role "$roles_json" "$role_file"
curl -fsS -H "Authorization: Bearer $super_token" \
  'http://127.0.0.1:3000/admin-users?search=task84_permission_smoke&page=1&pageSize=100' >"$existing_user_json"
node "$helper" select-disabled-user "$existing_user_json" "$role_file" "$user_id_file"

node -e "process.stdout.write(require('node:crypto').randomBytes(36).toString('base64url') + 'A1')" >"$temporary_password_file"
chmod 0600 "$temporary_password_file"
reset_request="$work_dir/reset-password.json"
node "$helper" build-password-reset "$temporary_password_file" "$reset_request"
reset_code="$(
  curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $super_token" \
    --data-binary "@$reset_request" \
    "http://127.0.0.1:3000/admin-users/$(<"$user_id_file")/reset-password"
)"
node "$helper" check-success-http LOW_PRIV_ACCOUNT_PASSWORD_RESET "$reset_code"
enable_response="$work_dir/enable-response.json"
enable_code="$(
  curl -sS -o "$enable_response" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $super_token" \
    "http://127.0.0.1:3000/admin-users/$(<"$user_id_file")/enable"
)"
node "$helper" check-success-http LOW_PRIV_ACCOUNT_ENABLE "$enable_code"
node "$helper" inspect-active-account "$enable_response"
temp_active=1

low_login_request="$work_dir/low-login.json"
low_login_response="$work_dir/low-login-response.json"
printf '%s\0' 'task84_permission_smoke' |
  { cat; cat "$temporary_password_file"; printf '\0'; } |
  node "$helper" build-login "$low_login_request"
low_login_code="$(
  curl -sS -o "$low_login_response" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -H "User-Agent: production-permissions-smoke-low/${run_id}" \
    --data-binary "@$low_login_request" \
    http://127.0.0.1:3000/auth/login
)"
rm -f -- "$low_login_request" "$temporary_password_file"
node "$helper" check-success-http LOW_PRIV_LOGIN_HTTP "$low_login_code"
node "$helper" inspect-low "$low_login_response" "$user_id_file" "$low_token_file"
rm -f -- "$low_login_response"
low_token="$(<"$low_token_file")"

low_me_response="$work_dir/low-me.json"
low_me_code="$(
  curl -sS -o "$low_me_response" -w '%{http_code}' \
    -H "Authorization: Bearer $low_token" \
    http://127.0.0.1:3000/me
)"
node "$helper" check-http LOW_PRIV_ME_HTTP "$low_me_code" 200
node "$helper" inspect-me "$low_me_response" "$user_id_file"
release_403="$(
  curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $low_token" \
    http://127.0.0.1:3000/release-gate/run
)"
node "$helper" check-http LOW_PRIV_RELEASE_GATE_RUN_403 "$release_403" 403
admin_403="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $low_token" \
    'http://127.0.0.1:3000/admin-users?page=1&pageSize=1'
)"
node "$helper" check-http LOW_PRIV_ADMIN_ONLY_403 "$admin_403" 403
low_logout_code="$(
  curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $low_token" \
    http://127.0.0.1:3000/auth/logout-all
)"
node "$helper" check-success-http LOW_PRIV_LOGOUT_ALL "$low_logout_code"
unset low_token
rm -f -- "$low_token_file"

disable_response="$work_dir/disable-response.json"
disable_code="$(
  curl -sS -o "$disable_response" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $super_token" \
    "http://127.0.0.1:3000/admin-users/$(<"$user_id_file")/disable"
)"
node "$helper" check-success-http LOW_PRIV_ACCOUNT_DISABLE "$disable_code"
node "$helper" inspect-disabled "$disable_response"
temp_active=0

active_after="$work_dir/active-after.json"
curl -fsS -H "Authorization: Bearer $super_token" \
  'http://127.0.0.1:3000/admin-users?status=active&page=1&pageSize=100' >"$active_after"
node "$helper" admin-summary "$active_after"

evidence_staging="$work_dir/e2e-permissions.json"
node "$helper" write-evidence "$evidence_staging" "$smoke_started_at"
install -m 0640 -o root -g salaryops "$evidence_staging" "$evidence_dir/e2e-permissions.json"
install -m 0640 -o root -g salaryops "$evidence_staging" "$run_dir/e2e-permissions.json"

super_logout_code="$(
  curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $super_token" \
    http://127.0.0.1:3000/auth/logout
)"
node "$helper" check-success-http SUPER_ADMIN_LOGOUT "$super_logout_code"
unset super_token
rm -f -- "$super_token_file"

echo "PRODUCTION_PERMISSIONS_EVIDENCE_DIR=$run_dir"
echo "PRODUCTION_PERMISSIONS_SMOKE_FINISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
core_complete=1
echo 'PRODUCTION_PERMISSIONS_SMOKE_COMPLETE=pass'
