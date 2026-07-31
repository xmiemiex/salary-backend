#!/usr/bin/env bash
set -Eeuo pipefail

release_tag="${TASK96_RELEASE_TAG:?TASK96_RELEASE_TAG is required}"
commit="${TASK96_COMMIT:?TASK96_COMMIT is required}"
archive_sha256="${TASK96_ARCHIVE_SHA256:?TASK96_ARCHIVE_SHA256 is required}"
staging_dir='/home/salaryops/task96-staging'
archive="${staging_dir}/source.tar.gz"
release_dir="/opt/salary-settlement-admin/releases/${release_tag}"
prod_env='/opt/salary-settlement-admin/shared/.env'
gate='/home/salaryops/production-release-gate.sh'
env_helper='/home/salaryops/production-env-check.js'
auth_helper='/home/salaryops/task96-auth-helper.js'
result_file='/home/salaryops/task96-result.env'
run_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
evidence_dir="/opt/salary-settlement-admin/evidence/task96-${run_stamp}"
rollback_dir="/root/task96-rollback-${run_stamp}"
old_tag=''
old_release_dir=''
services_changed=0
operational_files_changed=0
completed=0

if [[ "$EUID" -ne 0 ]]; then
  echo 'TASK96_DEPLOY_STATUS=fail reason=requires_root' >&2
  exit 1
fi
if [[ ! "$release_tag" =~ ^task96-[0-9a-f]{12}$ ]] || [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]] ||
  [[ "${release_tag#task96-}" != "${commit:0:12}" ]] || [[ ! "$archive_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'TASK96_DEPLOY_STATUS=fail reason=invalid_release_identity' >&2
  exit 1
fi

install -d -o root -g salaryops -m 0750 "$evidence_dir" "$rollback_dir"
install -o salaryops -g salaryops -m 0600 /dev/null "$result_file"

private_files=()
cleanup_private_files() {
  if ((${#private_files[@]})); then rm -f -- "${private_files[@]}"; fi
}

release_dir_for_tag() {
  case "$1" in
    rc-20260712-2) printf '%s\n' '/opt/salary-settlement-admin/releases/rc-20260712-2-9f8f8f57' ;;
    task96-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      printf '/opt/salary-settlement-admin/releases/%s\n' "$1"
      ;;
    *) return 1 ;;
  esac
}

read_release_tag() {
  awk -F= '$1 == "RELEASE_IMAGE_TAG" { value=$2 } END { gsub(/^[[:space:]\"'\'' ]+|[[:space:]\"'\'' ]+$/, "", value); print value }' "$prod_env"
}

write_release_tag() {
  local next_tag="$1"
  local temp
  temp="$(mktemp "$(dirname "$prod_env")/.task96-env.XXXXXX")"
  chmod 0600 "$temp"
  awk -v tag="$next_tag" '
    BEGIN { changed=0 }
    /^RELEASE_IMAGE_TAG=/ { print "RELEASE_IMAGE_TAG=" tag; changed=1; next }
    { print }
    END { if (!changed) exit 42 }
  ' "$prod_env" >"$temp"
  chown --reference="$prod_env" "$temp"
  chmod --reference="$prod_env" "$temp"
  mv -T -- "$temp" "$prod_env"
}

wait_for_health() {
  local container="$1"
  local attempt status
  for attempt in $(seq 1 40); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
    if [[ "$status" == 'healthy' ]]; then
      echo "TASK96_CONTAINER_HEALTH container=$container status=healthy attempt=$attempt"
      return 0
    fi
    sleep 3
  done
  echo "TASK96_CONTAINER_HEALTH container=$container status=$status result=fail" >&2
  return 1
}

rollback_on_error() {
  local exit_code=$?
  trap - ERR
  cleanup_private_files
  if [[ "$completed" -eq 0 && ( "$services_changed" -eq 1 || "$operational_files_changed" -eq 1 ) ]]; then
    echo "TASK96_AUTOMATIC_ROLLBACK=triggered exit=$exit_code" >&2
    if [[ -n "$old_tag" ]]; then write_release_tag "$old_tag" || true; fi
    if [[ -f "$rollback_dir/production-env-check.js" ]]; then
      install -o root -g root -m 0755 "$rollback_dir/production-env-check.js" "$env_helper" || true
    fi
    if [[ -f "$rollback_dir/production-release-gate.sh" ]]; then
      install -o root -g root -m 0755 "$rollback_dir/production-release-gate.sh" "$gate" || true
    fi
    if [[ -n "$old_release_dir" && -d "$old_release_dir" ]]; then
      RELEASE_IMAGE_TAG="$old_tag" docker compose \
        --project-directory "$old_release_dir" --env-file "$prod_env" \
        -f "$old_release_dir/docker-compose.prod.yml" up -d --no-build --no-deps api web || true
      wait_for_health salary-settlement-admin-api-1 || true
      wait_for_health salary-settlement-admin-web-1 || true
    fi
    cat >"$result_file" <<EOF
TASK96_DEPLOY_STATUS=failed_rolled_back
TASK96_RELEASE_TAG=${release_tag}
TASK96_COMMIT=${commit}
TASK96_AUTOMATIC_ROLLBACK=triggered
TASK96_FAILURE_EXIT=${exit_code}
EOF
  else
    echo "TASK96_AUTOMATIC_ROLLBACK=not_required exit=$exit_code" >&2
    cat >"$result_file" <<EOF
TASK96_DEPLOY_STATUS=failed_before_service_change
TASK96_RELEASE_TAG=${release_tag}
TASK96_COMMIT=${commit}
TASK96_AUTOMATIC_ROLLBACK=not_required
TASK96_FAILURE_EXIT=${exit_code}
EOF
  fi
  chown salaryops:salaryops "$result_file"
  chmod 0600 "$result_file"
  exit "$exit_code"
}
trap rollback_on_error ERR

echo "TASK96_PHASE=validate_source timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[[ -f "$archive" ]]
echo "${archive_sha256}  ${archive}" | sha256sum -c -
if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo 'TASK96_ARCHIVE_PATH_SAFETY=fail' >&2
  exit 1
fi
[[ ! -e "$release_dir" ]]
install -d -o root -g salaryapp -m 0750 "$release_dir"
tar -xzf "$archive" -C "$release_dir"
find "$release_dir" -xdev -type f \( -name '.env' -o -name '*.csv' -o -name '*.log' \) -print -quit | grep -q . && {
  echo 'TASK96_ARCHIVE_SENSITIVE_ARTIFACT=fail' >&2
  exit 1
}
printf '%s\n' "$commit" >"$release_dir/TASK96_COMMIT"
chown root:salaryapp "$release_dir/TASK96_COMMIT"
chmod 0640 "$release_dir/TASK96_COMMIT"

old_tag="$(read_release_tag)"
old_release_dir="$(release_dir_for_tag "$old_tag")"
[[ -d "$old_release_dir" ]]
cmp -s "$old_release_dir/prisma/schema.prisma" "$release_dir/prisma/schema.prisma"
diff -qr "$old_release_dir/prisma/migrations" "$release_dir/prisma/migrations" >"$evidence_dir/migration-diff.log"
echo 'TASK96_SCHEMA_AND_MIGRATIONS=unchanged'

echo "TASK96_PHASE=baseline timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
readlink -f /etc/nginx/sites-enabled/salary-production >"$evidence_dir/nginx-target-before.txt"
docker inspect salary-settlement-admin-api-1 salary-settlement-admin-web-1 \
  --format 'name={{.Name}} image={{.Config.Image}} id={{.Image}} health={{.State.Health.Status}} restart={{.RestartCount}}' \
  >"$evidence_dir/containers-before.log"
curl -fsS -o /dev/null http://127.0.0.1:3000/health/live
curl -fsS -o /dev/null http://127.0.0.1:3000/health/ready
curl -fsS -o /dev/null http://127.0.0.1:8080/healthz
"$gate" >"$evidence_dir/release-gate-before.log" 2>&1

echo "TASK96_PHASE=build timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RELEASE_IMAGE_TAG="$release_tag" docker compose \
  --project-directory "$release_dir" --env-file "$prod_env" \
  -f "$release_dir/docker-compose.prod.yml" build api web \
  >"$evidence_dir/build.log" 2>&1
api_image_id="$(docker image inspect "salary-settlement-api:${release_tag}" --format '{{.Id}}')"
web_image_id="$(docker image inspect "salary-settlement-web:${release_tag}" --format '{{.Id}}')"

echo "TASK96_PHASE=install_operational_entry timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
install -o root -g root -m 0640 "$env_helper" "$rollback_dir/production-env-check.js"
install -o root -g root -m 0640 "$gate" "$rollback_dir/production-release-gate.sh"
install -o root -g root -m 0755 "$release_dir/deploy/scripts/production-env-check.js" "$env_helper"
install -o root -g root -m 0755 "$release_dir/deploy/scripts/production-release-gate.sh" "$gate"
install -o root -g root -m 0755 "$release_dir/deploy/scripts/task96-auth-helper.js" "$auth_helper"
operational_files_changed=1
write_release_tag "$release_tag"

echo "TASK96_PHASE=deploy_api_web timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
deployment_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RELEASE_IMAGE_TAG="$release_tag" docker compose \
  --project-directory "$release_dir" --env-file "$prod_env" \
  -f "$release_dir/docker-compose.prod.yml" up -d --no-build --no-deps api web
services_changed=1
wait_for_health salary-settlement-admin-api-1
wait_for_health salary-settlement-admin-web-1
[[ "$(docker inspect salary-settlement-admin-api-1 --format '{{.Image}}')" == "$api_image_id" ]]
[[ "$(docker inspect salary-settlement-admin-web-1 --format '{{.Image}}')" == "$web_image_id" ]]
[[ "$(docker inspect salary-settlement-admin-api-1 --format '{{.RestartCount}}')" -eq 0 ]]
[[ "$(docker inspect salary-settlement-admin-web-1 --format '{{.RestartCount}}')" -eq 0 ]]
curl -fsS -o /dev/null http://127.0.0.1:3000/health/live
curl -fsS -o /dev/null http://127.0.0.1:3000/health/ready
curl -fsS -o /dev/null http://127.0.0.1:8080/healthz
curl -fsS -o /dev/null https://admin-salary.lovemiemie.com/
curl -fsS -o /dev/null https://api-salary.lovemiemie.com/health/live
curl -fsS -o /dev/null https://api-salary.lovemiemie.com/health/ready

echo "TASK96_PHASE=affiliate_account_smoke timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
login_request="$(mktemp /run/task96-login-request.XXXXXX)"
login_response="$(mktemp /run/task96-login-response.XXXXXX)"
token_file="$(mktemp /run/task96-token.XXXXXX)"
accounts_response="$(mktemp /run/task96-accounts.XXXXXX.json)"
account_id_file="$(mktemp /run/task96-account-id.XXXXXX)"
account_response="$(mktemp /run/task96-account.XXXXXX.json)"
request_body="$(mktemp /run/task96-request.XXXXXX.json)"
private_files+=("$login_request" "$login_response" "$token_file" "$accounts_response" "$account_id_file" "$account_response" "$request_body")
chmod 0600 "${private_files[@]}"
read -rp 'Existing production administrator username: ' admin_username
read -rsp 'Existing production administrator password (input remains in this SSH session only): ' admin_password
echo
printf '%s\0%s\0' "$admin_username" "$admin_password" | node "$auth_helper" build-login "$login_request"
unset admin_username admin_password
login_code="$(curl -sS -o "$login_response" -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "@$login_request" http://127.0.0.1:3000/auth/login)"
[[ "$login_code" == '200' || "$login_code" == '201' ]]
node "$auth_helper" extract-token "$login_response" "$token_file"
token="$(<"$token_file")"
curl -fsS -H "Authorization: Bearer $token" http://127.0.0.1:3000/affiliate-accounts >"$accounts_response"
node "$auth_helper" select-account "$accounts_response" "$account_id_file"
account_id="$(<"$account_id_file")"
printf '%s' '{"platform":"cake","accountCode":"329","accountName":"Blitzads","status":"active"}' >"$request_body"
if [[ -n "$account_id" ]]; then
  account_code="$(curl -sS -o "$account_response" -w '%{http_code}' -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data-binary "@$request_body" "http://127.0.0.1:3000/affiliate-accounts/$account_id")"
  [[ "$account_code" == '200' ]]
  account_action='edited'
else
  account_code="$(curl -sS -o "$account_response" -w '%{http_code}' -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data-binary "@$request_body" http://127.0.0.1:3000/affiliate-accounts)"
  [[ "$account_code" == '200' || "$account_code" == '201' ]]
  account_action='created'
fi
node "$auth_helper" verify-account "$account_response"
printf '%s' '{"platform":"Blitzads","accountCode":"task96-illegal-platform"}' >"$request_body"
illegal_code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data-binary "@$request_body" http://127.0.0.1:3000/affiliate-accounts)"
[[ "$illegal_code" == '400' ]]
logout_code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $token" http://127.0.0.1:3000/auth/logout)"
[[ "$logout_code" == '200' || "$logout_code" == '201' ]]
unset token
cleanup_private_files
private_files=()

echo "TASK96_PHASE=production_gate_and_observation timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
"$gate" >"$evidence_dir/release-gate-after.log" 2>&1
sleep 30
curl -fsS -o /dev/null http://127.0.0.1:3000/health/ready
curl -fsS -o /dev/null http://127.0.0.1:8080/healthz
[[ "$(docker inspect salary-settlement-admin-api-1 --format '{{.RestartCount}}')" -eq 0 ]]
[[ "$(docker inspect salary-settlement-admin-web-1 --format '{{.RestartCount}}')" -eq 0 ]]
if docker logs --since "$deployment_started" salary-settlement-admin-api-1 2>&1 |
  grep -Eiq 'Unhandled|FATAL|ECONNREFUSED|PrismaClientInitializationError'; then
  echo 'TASK96_API_LOG_SCAN=fail' >&2
  exit 1
fi
readlink -f /etc/nginx/sites-enabled/salary-production >"$evidence_dir/nginx-target-after.txt"
cmp -s "$evidence_dir/nginx-target-before.txt" "$evidence_dir/nginx-target-after.txt"

completed=1
cat >"$result_file" <<EOF
TASK96_DEPLOY_STATUS=success
TASK96_RELEASE_TAG=${release_tag}
TASK96_COMMIT=${commit}
TASK96_PREVIOUS_RELEASE_TAG=${old_tag}
TASK96_API_IMAGE_ID=${api_image_id}
TASK96_WEB_IMAGE_ID=${web_image_id}
TASK96_SCHEMA_MIGRATIONS=unchanged
TASK96_AFFILIATE_ACCOUNT_ACTION=${account_action}
TASK96_AFFILIATE_ACCOUNT_VERIFY=pass
TASK96_ILLEGAL_PLATFORM_HTTP=${illegal_code}
TASK96_HEALTH=pass
TASK96_RELEASE_GATE=pass
TASK96_API_RESTARTS=0
TASK96_WEB_RESTARTS=0
TASK96_NGINX_CHANGED=false
TASK96_POSTGRESQL_RESTARTED=false
TASK96_MIGRATION_EXECUTED=false
TASK96_AUTOMATIC_ROLLBACK=not_triggered
TASK96_EVIDENCE_DIR=${evidence_dir}
EOF
chown salaryops:salaryops "$result_file"
chmod 0600 "$result_file"
echo "TASK96_DEPLOY_STATUS=success release=${release_tag} commit=${commit}"
echo "TASK96_AFFILIATE_ACCOUNT_ACTION=${account_action} illegal_platform_http=${illegal_code}"
echo 'TASK96_AUTOMATIC_ROLLBACK=not_triggered'
echo "TASK96_EVIDENCE_DIR=${evidence_dir}"
