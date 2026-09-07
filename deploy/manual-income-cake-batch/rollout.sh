#!/usr/bin/env bash
# Manual income entries and CAKE batches; zero migration. Default is a read-only plan.
set -Eeuo pipefail
umask 077
mode=${1:-plan}
if [[ "$mode" == plan ]]; then
  echo 'Manual income / CAKE e722021; 28 unchanged migrations; existing HTTPS origins. Supply STAGE and APPROVED_CHECKS_SHA256, then deploy-approved in the authorized sudo session. No action performed.'
  exit 0
fi
[[ "$mode" == deploy-approved && $EUID == 0 ]] || exit 2
: "${STAGE:?absolute staging directory required}" "${APPROVED_CHECKS_SHA256:?approved helper manifest checksum required}"
[[ "$STAGE" == /home/salaryops/manual-income-cake-batch-* && "$STAGE" != *..* && "$STAGE" != *$'\n'* ]]
[[ "$APPROVED_CHECKS_SHA256" =~ ^[a-f0-9]{64}$ ]]
stage=$(realpath -e "$STAGE")
[[ "$stage" == "$STAGE" ]]
cd "$stage"
printf '%s  checks.sha256\n' "$APPROVED_CHECKS_SHA256" | sha256sum -c - >/dev/null
sha256sum -c checks.sha256 >/dev/null
commit=e72202161c24624dc5b39a05031731a4899cf234
tag=manual-cake-e722021
sha=4017614eaed45df37825cd2b80a7b89f8a068cf075d6d4922564b47fe890f8e2
schema_sha=c0112c4987133722e0b8996786572a5c001e1412bfa84879092a6534bc2c6010
archive="$stage/source-e722021.tar.gz"
release="/opt/salary-settlement-admin/releases/$tag"
evidence="/opt/salary-settlement-admin/release-evidence/$tag"
old=cake-review-ea3b9f31e398
old_api=sha256:d789b35b384f0dcbd2b7acf1d7a4ee7d6977c8717fadcb62728263da432d4775
old_web=sha256:edbcacbb478ea54d68616a60b7ebece96f437ebc6007d95d2f0c98d5a375a9cd
envfile=/opt/salary-settlement-admin/shared/.env
export PRODUCTION_ENV_FILE="$envfile" VITE_API_BASE_URL=https://api-salary.lovemiemie.com RELEASE_IMAGE_TAG="$tag"
export PUBLIC_EVIDENCE_DIR="$stage/public-evidence"
phase=preparation
[[ ! -e "$release" && ! -e "$evidence" ]] || { echo 'RELEASE_OR_EVIDENCE_EXISTS_REVIEW_BEFORE_RERUN'; exit 2; }
mkdir -m 0755 "$release"
mkdir -m 0700 "$evidence"
status() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" | tee -a "$evidence/status.txt"; }
export_evidence() {
  mkdir -p "$stage/public-evidence"
  chmod 0755 "$stage/public-evidence"
  for file in status.txt archive-check.txt schema-check.txt new-images.txt fresh-backup-health.txt fresh-backup-sha256.txt before.json immediate-before.json pre-stop.json stopped.json candidate-schema.json migration.log financial-baseline.json after-start.json formal-ready.json formal-web-health.txt acceptance.json ledger-proof.json after-acceptance.json browser-session.encrypted.json; do
    if [[ -f "$evidence/$file" ]]; then install -m 0644 -o salaryops -g salaryops "$evidence/$file" "$stage/public-evidence/$file"; fi
  done
  chown salaryops:salaryops "$stage/public-evidence"
}
compose() { docker compose -p salary-settlement-admin --project-directory "$release" --env-file "$envfile" -f "$release/docker-compose.prod.yml" "$@"; }
health() { for attempt in $(seq 1 40); do if [[ $(docker inspect -f '{{.State.Health.Status}}' "$1") == healthy ]]; then return 0; fi; sleep 3; done; return 1; }
set_tag() { node - "$envfile" "$1" <<'JS'
const fs=require('fs'),p=process.argv[2],s=fs.readFileSync(p,'utf8');if(!/^RELEASE_IMAGE_TAG=/m.test(s))throw Error('TAG_SETTING_MISSING');const stat=fs.statSync(p),tmp=p+'.hotfix-tmp';fs.writeFileSync(tmp,s.replace(/^RELEASE_IMAGE_TAG=.*$/m,'RELEASE_IMAGE_TAG='+process.argv[3]),{mode:stat.mode});fs.chownSync(tmp,stat.uid,stat.gid);fs.renameSync(tmp,p);
JS
}
failed() {
  trap - ERR
  status "FAILED phase=$phase line=${1:-unknown}"
  if [[ "$phase" == stopped || "$phase" == startup || "$phase" == runtime_checks ]]; then
    export RELEASE_IMAGE_TAG="$old"
    set_tag "$old"
    if compose up -d --no-build api web >"$evidence/rollback.log" 2>&1 && health salary-settlement-admin-api-1 && health salary-settlement-admin-web-1; then status ROLLED_BACK_EXACT_PREVIOUS_CAKE_IMAGES_DATABASE_UNCHANGED; else status ROLLBACK_NEEDS_ATTENTION; fi
  elif [[ "$phase" == supplier_acceptance ]]; then
    status NEW_VERSION_RUNNING_REVIEW_ACCEPTANCE_ERROR_NO_BLIND_TASK_INTERRUPTION
  fi
  export_evidence
  if [[ ! -f "$evidence/browser-session.encrypted.json" ]]; then node "$stage/login-check.cjs" --logout "$evidence/token.private" || status PREFLIGHT_SESSION_REVOCATION_NEEDS_ATTENTION; fi
  rm -f -- "$evidence/login.private.json" "$evidence/token.private"
  exit 1
}
trap 'failed "$LINENO"' ERR
status STARTED
printf '%s  %s\n' "$sha" "$archive" | sha256sum -c - >"$evidence/archive-check.txt"
# Reject traversal, absolute paths, links and nonregular payload entries before extraction.
node "$stage/archive-check.cjs" "$archive"
tar -xzf "$archive" --no-same-owner -C "$release"
tar -dzf "$archive" -C "$release" >"$evidence/source-compare-before.txt"
printf '%s  %s\n' "$schema_sha" "$release/prisma/schema.prisma" | sha256sum -c - >"$evidence/schema-check.txt"
[[ $(docker inspect salary-settlement-admin-api-1 -f '{{.Image}}') == "$old_api" ]]
[[ $(docker inspect salary-settlement-admin-web-1 -f '{{.Image}}') == "$old_web" ]]
[[ $(docker image inspect "salary-settlement-api:$old" -f '{{.Id}}') == "$old_api" ]]
[[ $(docker image inspect "salary-settlement-web:$old" -f '{{.Id}}') == "$old_web" ]]
docker exec salary-settlement-admin-api-1 node -e 'if(process.env.SYNC_PLANNER_ENABLED!=="false"||process.env.SYNC_AUTO_EXECUTION_ENABLED!=="false")process.exit(1)'
guard() { docker run --rm --user 0:0 -e NODE_PATH=/app/node_modules --network salary-settlement-admin_app --add-host host.docker.internal:172.30.80.1 --env-file "$envfile" -v "$stage:/release-checks:ro" -v "$release:/release-source:ro" "salary-settlement-api:$1" node /release-checks/guard.cjs "$2"; }
compare() { node - "$1" "$2" <<'JS'
const fs=require('fs'),a=JSON.parse(fs.readFileSync(process.argv[2])),b=JSON.parse(fs.readFileSync(process.argv[3]));for(const k of Object.keys(a.preservation))if(a.preservation[k]!==b.preservation[k])throw Error('PRESERVED_BUSINESS_DATA_CHANGED_'+k);
JS
}
guard "$old" before >"$evidence/before.json"
if [[ -n "${LOGIN_FILE:-}" ]]; then
  [[ -f "$LOGIN_FILE" && $(stat -c %u "$LOGIN_FILE") == 0 && $(stat -c %a "$LOGIN_FILE") == 600 ]]
  cp "$LOGIN_FILE" "$evidence/login.private.json"
else
  read -r -p 'Production administrator username: ' login_user
  read -r -s -p 'Production administrator password (hidden): ' login_password; printf '\n'
  printf '%s\0%s' "$login_user" "$login_password" | node -e 'const fs=require("fs"),v=fs.readFileSync(0).toString().split("\0");fs.writeFileSync(process.argv[1],JSON.stringify({username:v[0],password:v[1]}),{mode:0o600})' "$evidence/login.private.json"
  unset login_password login_user
fi
node "$stage/login-check.cjs" "$evidence/login.private.json" "$evidence/token.private"
node "$stage/acceptance.cjs" "$evidence/token.private" "$evidence" baseline
status BUILDING_APPROVED_SOURCE
compose build api web >"$evidence/build.log" 2>&1
tar -dzf "$archive" -C "$release" >"$evidence/source-compare-after-build.txt"
docker image inspect "salary-settlement-api:$tag" "salary-settlement-web:$tag" --format '{{.RepoTags}} {{.Id}}' >"$evidence/new-images.txt"
guard "$old" before >"$evidence/immediate-before.json"

status CREATING_FRESH_BACKUP_WHILE_OLD_API_RUNNING
backup_started=$(date +%s)
systemctl start salary-postgres-backup.service
[[ $(systemctl show salary-postgres-backup.service -p Result --value) == success ]]
/usr/local/sbin/check-local-backup-health >"$evidence/fresh-backup-health.txt" 2>&1
grep -q '^TASK88_BACKUP_HEALTH_STATUS=pass$' "$evidence/fresh-backup-health.txt"
grep -q '^TASK88_BACKUP_CHECKSUM_RESULT=match$' "$evidence/fresh-backup-health.txt"
grep -q '^TASK88_BACKUP_INTEGRITY_RESULT=pass_authenticated_decrypt_gzip$' "$evidence/fresh-backup-health.txt"
backup=$(sed -n 's/^TASK88_LATEST_BACKUP_BASENAME=//p' "$evidence/fresh-backup-health.txt")
[[ "$backup" =~ ^[A-Za-z0-9._-]+$ ]]
backup_file="/opt/salary-settlement-admin/backups/$backup"
[[ -f "$backup_file" && $(stat -c %Y "$backup_file") -ge "$backup_started" ]]
sha256sum "$backup_file" >"$evidence/fresh-backup-sha256.txt"
guard "$old" before >"$evidence/pre-stop.json"
compare "$evidence/before.json" "$evidence/immediate-before.json"
compare "$evidence/immediate-before.json" "$evidence/pre-stop.json"
phase=stopped
status STOPPING_WRITERS_FOR_APPLICATION_SWITCH
compose stop api web >"$evidence/stop.log" 2>&1
guard "$old" before >"$evidence/stopped.json"
compare "$evidence/pre-stop.json" "$evidence/stopped.json"
status VERIFYING_UNCHANGED_SCHEMA_NO_MIGRATION
guard "$tag" after >"$evidence/candidate-schema.json"
compare "$evidence/stopped.json" "$evidence/candidate-schema.json"
phase=startup
set_tag "$tag"
compose up -d --no-build api web >"$evidence/start.log" 2>&1
health salary-settlement-admin-api-1
health salary-settlement-admin-web-1
[[ $(docker inspect salary-settlement-admin-api-1 -f '{{.Image}}') == $(docker image inspect "salary-settlement-api:$tag" -f '{{.Id}}') ]]
[[ $(docker inspect salary-settlement-admin-web-1 -f '{{.Image}}') == $(docker image inspect "salary-settlement-web:$tag" -f '{{.Id}}') ]]
phase=runtime_checks
curl -fsS https://api-salary.lovemiemie.com/health/ready >"$evidence/formal-ready.json"
curl -fsS https://admin-salary.lovemiemie.com/healthz >"$evidence/formal-web-health.txt"
node "$stage/login-check.cjs" "$evidence/login.private.json" "$evidence/token.private" "$stage/browser-public.pem"
rm -f -- "$evidence/login.private.json"
guard "$tag" after >"$evidence/after-start.json"
compare "$evidence/stopped.json" "$evidence/after-start.json"
node "$stage/acceptance.cjs" "$evidence/token.private" "$evidence" verify
status DEPLOYED_FORMAL_LOGIN_AND_HEALTH_PASSED
export_evidence

guard "$tag" after >"$evidence/after-acceptance.json"
compare "$evidence/stopped.json" "$evidence/after-acceptance.json"
rm -f -- "$evidence/token.private"
phase=complete
status MANUAL_CAKE_DEPLOYMENT_COMPLETE_READ_ONLY_ACCEPTANCE
export_evidence
