#!/usr/bin/env bash
set -Eeuo pipefail

release_tag="${TASK101_RELEASE_TAG:?TASK101_RELEASE_TAG is required}"
commit="${TASK101_COMMIT:?TASK101_COMMIT is required}"
archive_sha256="${TASK101_ARCHIVE_SHA256:?TASK101_ARCHIVE_SHA256 is required}"
staging_dir='/home/salaryops/task101-staging'
archive="${staging_dir}/source.tar.gz"
release_dir="/opt/salary-settlement-admin/releases/${release_tag}"
prod_env='/opt/salary-settlement-admin/shared/.env'
gate='/home/salaryops/production-release-gate.sh'
env_helper='/home/salaryops/production-env-check.js'
migration_helper='/home/salaryops/production-migration-evidence.js'
result_file='/home/salaryops/task101-result.env'
run_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
evidence_dir="/opt/salary-settlement-admin/evidence/task101-${run_stamp}"
rollback_dir="/root/task101-rollback-${run_stamp}"
expected_migration='20260821010000_add_photonpay_alias_and_card_exclusion'
old_tag=''
old_release_dir=''
services_changed=0
operational_files_changed=0
migration_applied=0
completed=0

if [[ "$EUID" -ne 0 ]]; then
  echo 'TASK101_DEPLOY_STATUS=fail reason=requires_root' >&2
  exit 1
fi
if [[ ! "$release_tag" =~ ^task101-[0-9a-f]{12}$ ]] || [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]] ||
  [[ "${release_tag#task101-}" != "${commit:0:12}" ]] || [[ ! "$archive_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'TASK101_DEPLOY_STATUS=fail reason=invalid_release_identity' >&2
  exit 1
fi

install -d -o root -g salaryops -m 0750 "$evidence_dir" "$rollback_dir"
install -o salaryops -g salaryops -m 0600 /dev/null "$result_file"

release_dir_for_tag() {
  case "$1" in
    rc-20260712-2) printf '%s\n' '/opt/salary-settlement-admin/releases/rc-20260712-2-9f8f8f57' ;;
    task96-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f] | \
    task97-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f] | \
    task98-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f] | \
    task100-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f] | \
    task101-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      printf '/opt/salary-settlement-admin/releases/%s\n' "$1"
      ;;
    *) return 1 ;;
  esac
}

read_release_tag() {
  awk -F= '$1 == "RELEASE_IMAGE_TAG" { value=$2 } END { gsub(/^[[:space:]"'\'' ]+|[[:space:]"'\'' ]+$/, "", value); print value }' "$prod_env"
}

write_release_tag() {
  local next_tag="$1"
  local temp
  temp="$(mktemp "$(dirname "$prod_env")/.task101-env.XXXXXX")"
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
  local attempt status='unknown'
  for attempt in $(seq 1 40); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
    if [[ "$status" == 'healthy' ]]; then
      echo "TASK101_CONTAINER_HEALTH container=$container status=healthy attempt=$attempt"
      return 0
    fi
    sleep 3
  done
  echo "TASK101_CONTAINER_HEALTH container=$container status=$status result=fail" >&2
  return 1
}

rollback_on_error() {
  local exit_code=$?
  local failure_line="${BASH_LINENO[0]:-unknown}"
  trap - ERR
  echo "TASK101_FAILURE_LINE=${failure_line}" >&2
  if [[ "$completed" -eq 0 && ( "$services_changed" -eq 1 || "$operational_files_changed" -eq 1 ) ]]; then
    echo "TASK101_AUTOMATIC_APPLICATION_ROLLBACK=triggered exit=$exit_code" >&2
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
    rollback_status='failed_application_rolled_back'
  else
    echo "TASK101_AUTOMATIC_APPLICATION_ROLLBACK=not_required exit=$exit_code" >&2
    rollback_status='failed_before_service_change'
  fi
  cat >"$result_file" <<EOF
TASK101_DEPLOY_STATUS=${rollback_status}
TASK101_RELEASE_TAG=${release_tag}
TASK101_COMMIT=${commit}
TASK101_MIGRATION_APPLIED=${migration_applied}
TASK101_DATABASE_ROLLBACK=not_attempted_additive_schema_retained
TASK101_FAILURE_EXIT=${exit_code}
TASK101_FAILURE_LINE=${failure_line}
EOF
  chown salaryops:salaryops "$result_file"
  chmod 0600 "$result_file"
  exit "$exit_code"
}
trap rollback_on_error ERR

echo "TASK101_PHASE=validate_source timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[[ -f "$archive" ]]
echo "${archive_sha256}  ${archive}" | sha256sum -c -
if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo 'TASK101_ARCHIVE_PATH_SAFETY=fail' >&2
  exit 1
fi

old_tag="$(read_release_tag)"
old_release_dir="$(release_dir_for_tag "$old_tag")"
[[ -d "$old_release_dir" ]]
if [[ -e "$release_dir" ]]; then
  [[ "$old_tag" != "$release_tag" ]]
  stale_release_dir="${rollback_dir}/stale-${release_tag}"
  [[ ! -e "$stale_release_dir" ]]
  mv -T -- "$release_dir" "$stale_release_dir"
fi
install -d -o root -g salaryapp -m 0750 "$release_dir"
tar -xzf "$archive" -C "$release_dir"
find "$release_dir" -xdev -type f \( -name '.env' -o -name '*.csv' -o -name '*.log' \) -print -quit | grep -q . && {
  echo 'TASK101_ARCHIVE_SENSITIVE_ARTIFACT=fail' >&2
  exit 1
}
printf '%s\n' "$commit" >"$release_dir/TASK101_COMMIT"
chown root:salaryapp "$release_dir/TASK101_COMMIT"
chmod 0640 "$release_dir/TASK101_COMMIT"

[[ -f "$release_dir/prisma/migrations/${expected_migration}/migration.sql" ]]
mapfile -t migration_diff < <(diff -qr "$old_release_dir/prisma/migrations" "$release_dir/prisma/migrations" || true)
[[ "${#migration_diff[@]}" -eq 1 ]]
[[ "${migration_diff[0]}" == *"${expected_migration}"* ]]
echo 'TASK101_MIGRATION_DIFF=one_expected_additive_migration'

echo "TASK101_PHASE=baseline timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker inspect salary-settlement-admin-api-1 salary-settlement-admin-web-1 \
  --format 'name={{.Name}} image={{.Config.Image}} id={{.Image}} health={{.State.Health.Status}} restart={{.RestartCount}}' \
  >"$evidence_dir/containers-before.log"
curl -fsS -o /dev/null http://127.0.0.1:3000/health/ready
curl -fsS -o /dev/null http://127.0.0.1:8080/healthz
"$gate" >"$evidence_dir/release-gate-before.log" 2>&1

echo "TASK101_PHASE=build timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RELEASE_IMAGE_TAG="$release_tag" docker compose \
  --project-directory "$release_dir" --env-file "$prod_env" \
  -f "$release_dir/docker-compose.prod.yml" build api web \
  >"$evidence_dir/build.log" 2>&1
api_image="salary-settlement-api:${release_tag}"
api_image_id="$(docker image inspect "$api_image" --format '{{.Id}}')"
web_image_id="$(docker image inspect "salary-settlement-web:${release_tag}" --format '{{.Id}}')"

echo "TASK101_PHASE=backup timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
systemctl start salary-postgres-backup.service
[[ "$(systemctl show salary-postgres-backup.service -p Result --value)" == 'success' ]]
[[ "$(systemctl show salary-postgres-backup.service -p ExecMainStatus --value)" == '0' ]]
/usr/local/sbin/check-local-backup-health >"$evidence_dir/backup-health.log" 2>&1
grep -q '^TASK88_BACKUP_HEALTH_STATUS=pass$' "$evidence_dir/backup-health.log"
echo 'TASK101_BACKUP=pass'

run_migration_evidence() {
  local output="$1"
  set +e
  docker run --rm \
    --user 0:0 \
    --network salary-settlement-admin_app \
    --add-host host.docker.internal:172.30.80.1 \
    --env-file "$prod_env" \
    --mount "type=bind,src=$release_dir/prisma,dst=/app/prisma,readonly" \
    --mount "type=bind,src=$evidence_dir,dst=/task101-output" \
    --mount "type=bind,src=$migration_helper,dst=/app/production-migration-evidence.js,readonly" \
    "$api_image" node /app/production-migration-evidence.js "/task101-output/${output}" \
    >"$evidence_dir/${output%.json}.log" 2>&1
  local exit_code=$?
  set -e
  return "$exit_code"
}

echo "TASK101_PHASE=migration_precheck timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run_migration_evidence 'migration-before.json' || true
node -e '
  const fs=require("fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const summary=value.summary||{};
  const ok=summary.drift===false
    && Array.isArray(summary.pendingMigrations)
    && summary.pendingMigrations.length===1
    && summary.pendingMigrations[0]===process.argv[2]
    && (summary.unexpectedMigrations||[]).length===0
    && (summary.incompleteMigrations||[]).length===0
    && (summary.checksumMismatch||[]).length===0;
  if(!ok) process.exit(1);
' "$evidence_dir/migration-before.json" "$expected_migration"
echo 'TASK101_MIGRATION_PRECHECK=pass pending=1 drift=false'

echo "TASK101_PHASE=migration_deploy timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker run --rm \
  --user 0:0 \
  --network salary-settlement-admin_app \
  --add-host host.docker.internal:172.30.80.1 \
  --env-file "$prod_env" \
  --mount "type=bind,src=$release_dir/prisma,dst=/app/prisma,readonly" \
  "$api_image" ./node_modules/.bin/prisma migrate deploy --schema /app/prisma/schema.prisma \
  >"$evidence_dir/migration-deploy.log" 2>&1
migration_applied=1
run_migration_evidence 'migration-after.json'
node -e '
  const fs=require("fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const summary=value.summary||{};
  const ok=value.status==="pass" && summary.drift===false
    && (summary.pendingMigrations||[]).length===0
    && (summary.unexpectedMigrations||[]).length===0
    && (summary.incompleteMigrations||[]).length===0
    && (summary.checksumMismatch||[]).length===0;
  if(!ok) process.exit(1);
' "$evidence_dir/migration-after.json"
echo 'TASK101_MIGRATION_AFTER=pass pending=0 drift=false'

echo "TASK101_PHASE=install_and_deploy timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
install -o root -g root -m 0640 "$env_helper" "$rollback_dir/production-env-check.js"
install -o root -g root -m 0640 "$gate" "$rollback_dir/production-release-gate.sh"
install -o root -g root -m 0755 "$release_dir/deploy/scripts/production-env-check.js" "$env_helper"
install -o root -g root -m 0755 "$release_dir/deploy/scripts/production-release-gate.sh" "$gate"
operational_files_changed=1
write_release_tag "$release_tag"
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

echo "TASK101_PHASE=production_verification timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
curl -fsS -o /dev/null http://127.0.0.1:3000/health/live
curl -fsS -o /dev/null http://127.0.0.1:3000/health/ready
curl -fsS -o /dev/null http://127.0.0.1:8080/healthz
curl -fsS -o /dev/null https://admin-salary.lovemiemie.com/
curl -fsS -o /dev/null https://api-salary.lovemiemie.com/health/ready
[[ "$(systemctl is-active nginx)" == 'active' ]]
[[ "$(systemctl is-active postgresql)" == 'active' ]]
flags="$(docker exec salary-settlement-admin-api-1 node -e '
  const p=process.env;
  console.log(`planner=${p.SYNC_PLANNER_ENABLED}`);
  console.log(`auto=${p.SYNC_AUTO_EXECUTION_ENABLED}`);
  console.log(`webhook=${Object.keys(p).some(k=>k.includes("PHOTONPAY")&&k.includes("WEBHOOK"))}`);
')"
grep -q '^planner=false$' <<<"$flags"
grep -q '^auto=false$' <<<"$flags"
grep -q '^webhook=false$' <<<"$flags"
printf '%s\n' "$flags" >"$evidence_dir/sync-flags.log"
"$gate" >"$evidence_dir/release-gate-after.log" 2>&1
sleep 30
[[ "$(docker inspect salary-settlement-admin-api-1 --format '{{.RestartCount}}')" -eq 0 ]]
[[ "$(docker inspect salary-settlement-admin-web-1 --format '{{.RestartCount}}')" -eq 0 ]]
if docker logs --since "$deployment_started" salary-settlement-admin-api-1 2>&1 |
  grep -Eiq 'Unhandled|FATAL|ECONNREFUSED|PrismaClientInitializationError'; then
  echo 'TASK101_API_LOG_SCAN=fail' >&2
  exit 1
fi

completed=1
cat >"$result_file" <<EOF
TASK101_DEPLOY_STATUS=success
TASK101_RELEASE_TAG=${release_tag}
TASK101_COMMIT=${commit}
TASK101_PREVIOUS_RELEASE_TAG=${old_tag}
TASK101_API_IMAGE_ID=${api_image_id}
TASK101_WEB_IMAGE_ID=${web_image_id}
TASK101_BACKUP=pass
TASK101_MIGRATION_EXECUTED=true
TASK101_MIGRATION_NAME=${expected_migration}
TASK101_MIGRATION_PENDING=0
TASK101_MIGRATION_DRIFT=false
TASK101_HEALTH=pass
TASK101_RELEASE_GATE=pass
TASK101_API_RESTARTS=0
TASK101_WEB_RESTARTS=0
TASK101_NGINX_CHANGED=false
TASK101_POSTGRESQL_RESTARTED=false
TASK101_SYNC_PLANNER_ENABLED=false
TASK101_SYNC_AUTO_EXECUTION_ENABLED=false
TASK101_PHOTONPAY_WEBHOOK_CONFIGURED=false
TASK101_AUTOMATIC_APPLICATION_ROLLBACK=not_triggered
TASK101_DATABASE_ROLLBACK=not_required
TASK101_EVIDENCE_DIR=${evidence_dir}
EOF
chown salaryops:salaryops "$result_file"
chmod 0600 "$result_file"
echo "TASK101_DEPLOY_STATUS=success release=${release_tag} commit=${commit}"
echo 'TASK101_HEALTH=pass migration=pass release_gate=pass restarts=0/0'
echo 'TASK101_SYNC_PLANNER_ENABLED=false SYNC_AUTO_EXECUTION_ENABLED=false PHOTONPAY_WEBHOOK_CONFIGURED=false'
echo "TASK101_EVIDENCE_DIR=${evidence_dir}"
