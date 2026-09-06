#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $EUID == 0 ]] || exit 2
stage=/home/salaryops/monthly-finance-deployment-ea2b7f6
tag=monthly-ea2b7f6a162f
commit=ea2b7f6a162f92dc228c1d22448f738381a0e787
sha=a867d3a2607eb7dd83ebb727e16cade423f9081b63a777811578d0e64c0622cd
archive="$stage/monthly-finance-$commit.tar.gz"
release="/opt/salary-settlement-admin/releases/$tag"
evidence="/opt/salary-settlement-admin/release-evidence/$tag"
old=task102-f859d79c2b8f
old_api=sha256:6f940a27f83b5d9e1ee40c726c2accfdb2a0350bf2bd6bb7c57e4ce1253a63bf
old_web=sha256:7a13601d4578ab54a082372955cb25dcbc9d86ab264d96f7022dd6e1af52083c
envfile=/opt/salary-settlement-admin/shared/.env
export PRODUCTION_ENV_FILE="$envfile" VITE_API_BASE_URL=https://api-salary.lovemiemie.com RELEASE_IMAGE_TAG="$tag"
phase=preparation
mkdir -p "$evidence"
status(){ printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" | tee -a "$stage/deployment-status.txt"; chown salaryops:salaryops "$stage/deployment-status.txt"; }
compose(){ docker compose -p salary-settlement-admin --project-directory "$release" --env-file "$envfile" -f "$release/docker-compose.prod.yml" "$@"; }
health(){ for attempt in $(seq 1 40); do if [[ $(docker inspect -f '{{.State.Health.Status}}' "$1") == healthy ]]; then return 0; fi; sleep 3; done; return 1; }
set_tag(){ node - "$envfile" "$1" <<'JS'
const fs=require('fs'),p=process.argv[2],s=fs.readFileSync(p,'utf8');if(!/^RELEASE_IMAGE_TAG=/m.test(s))throw Error('TAG_SETTING_MISSING');const stat=fs.statSync(p),tmp=p+'.monthly-tmp';fs.writeFileSync(tmp,s.replace(/^RELEASE_IMAGE_TAG=.*$/m,'RELEASE_IMAGE_TAG='+process.argv[3]),{mode:stat.mode});fs.chownSync(tmp,stat.uid,stat.gid);fs.renameSync(tmp,p);
JS
}
failed(){ trap - ERR; status "FAILED phase=$phase line=${1:-unknown}"; if [[ "$phase" == startup || "$phase" == acceptance ]]; then
  export RELEASE_IMAGE_TAG="$old"; set_tag "$old"; compose up -d --no-build api web >"$evidence/rollback.log" 2>&1
  if health salary-settlement-admin-api-1 && health salary-settlement-admin-web-1; then status ROLLED_BACK_OLD_IMAGES_SCHEMA_RETAINED; else status ROLLBACK_NEEDS_ATTENTION; fi
 elif [[ "$phase" == stopped ]]; then export RELEASE_IMAGE_TAG="$old"; compose up -d --no-build api web >"$evidence/restart-old.log" 2>&1; health salary-settlement-admin-api-1 && health salary-settlement-admin-web-1; status OLD_IMAGES_RESTARTED_BEFORE_MIGRATION;
 elif [[ "$phase" == migration ]]; then status MIGRATION_FAILED_WRITERS_STOPPED_INSPECT_BEFORE_RECOVERY; fi
 rm -f -- "$evidence/login.private.json" "$evidence/token.private"; exit 1; }
trap 'failed "$LINENO"' ERR
status STARTED
printf '%s  %s\n' 4d3efb4d93eed7be84b2c8d0361c94c6c4d06147c79312168c4283c360eaad05 "$stage/source-files.sha256" | sha256sum -c - >/dev/null
printf '%s  %s\n' "$sha" "$archive" | sha256sum -c - >/dev/null
if [[ ! -e "$release" ]]; then mkdir -m 0755 "$release"; tar -xzf "$archive" --no-same-owner -C "$release"; fi
cd "$release"
sha256sum -c "$stage/source-files.sha256" >"$evidence/source-integrity.log"
[[ $(docker inspect salary-settlement-admin-api-1 -f '{{.Image}}') == "$old_api" ]]
[[ $(docker inspect salary-settlement-admin-web-1 -f '{{.Image}}') == "$old_web" ]]
[[ $(docker image inspect "salary-settlement-api:$old" -f '{{.Id}}') == "$old_api" ]]
[[ $(docker image inspect "salary-settlement-web:$old" -f '{{.Id}}') == "$old_web" ]]
guard(){ docker run --rm --user 0:0 -e NODE_PATH=/app/node_modules --network salary-settlement-admin_app --add-host host.docker.internal:172.30.80.1 --env-file "$envfile" -v "$stage:/release-checks:ro" "salary-settlement-api:$1" node /release-checks/guard.cjs "$2"; }
guard "$old" before >"$evidence/before.json"
read -r -p 'Production administrator username: ' login_user
read -r -s -p 'Production administrator password (hidden): ' login_password; printf '\n'
printf '%s\0%s' "$login_user" "$login_password" | node -e 'const fs=require("fs"),v=fs.readFileSync(0).toString().split("\0");fs.writeFileSync(process.argv[1],JSON.stringify({username:v[0],password:v[1]}),{mode:0o600})' "$evidence/login.private.json"
unset login_password login_user
node "$stage/login-check.cjs" "$evidence/login.private.json" "$evidence/token.private"
status BUILDING_APPROVED_SOURCE
compose build api web >"$evidence/build.log" 2>&1
sha256sum -c "$stage/source-files.sha256" >"$evidence/source-integrity-after-build.log"
docker image inspect "salary-settlement-api:$tag" "salary-settlement-web:$tag" --format '{{.RepoTags}} {{.Id}}' >"$stage/new-images.txt"
guard "$old" before >"$evidence/immediate-before.json"
docker run --rm --user 0:0 -e NODE_PATH=/app/node_modules --network salary-settlement-admin_app --add-host host.docker.internal:172.30.80.1 --env-file "$envfile" -v "$stage:/release-checks:ro" "salary-settlement-api:$old" node /release-checks/ledger-proof.cjs before >"$evidence/ledger-before.private.json"
status CREATING_FRESH_BACKUP_WHILE_API_AVAILABLE
systemctl start salary-postgres-backup.service
[[ $(systemctl show salary-postgres-backup.service -p Result --value) == success ]]
/usr/local/sbin/check-local-backup-health >"$stage/fresh-backup-health.txt" 2>&1
grep -q '^TASK88_BACKUP_HEALTH_STATUS=pass$' "$stage/fresh-backup-health.txt"
grep -q '^TASK88_BACKUP_CHECKSUM_RESULT=match$' "$stage/fresh-backup-health.txt"
grep -q '^TASK88_BACKUP_INTEGRITY_RESULT=pass_authenticated_decrypt_gzip$' "$stage/fresh-backup-health.txt"
backup=$(sed -n 's/^TASK88_LATEST_BACKUP_BASENAME=//p' "$stage/fresh-backup-health.txt")
sha256sum "/opt/salary-settlement-admin/backups/$backup" >"$stage/fresh-backup-sha256.txt"
phase=stopped
status STOPPING_WRITERS
compose stop api web >"$evidence/stop.log" 2>&1
guard "$old" before >"$evidence/stopped-before.json"
node - "$evidence/immediate-before.json" "$evidence/stopped-before.json" <<'JS'
const fs=require('fs'),a=JSON.parse(fs.readFileSync(process.argv[2])),b=JSON.parse(fs.readFileSync(process.argv[3]));for(const k of ['manualIncomeHash','manualCostHash','providerFeesHash'])if(a[k]!==b[k])throw Error('BUSINESS_WRITE_DURING_BACKUP');
JS
phase=migration
status MIGRATING
docker run --rm --user 0:0 -e NODE_PATH=/app/node_modules --network salary-settlement-admin_app --add-host host.docker.internal:172.30.80.1 --env-file "$envfile" -v "$release/prisma:/app/prisma:ro" "salary-settlement-api:$tag" node node_modules/prisma/build/index.js migrate deploy >"$evidence/migration.log" 2>&1
guard "$tag" after >"$evidence/after.json"
node - "$evidence/immediate-before.json" "$evidence/after.json" <<'JS'
const fs=require('fs'),a=JSON.parse(fs.readFileSync(process.argv[2])),b=JSON.parse(fs.readFileSync(process.argv[3]));for(const key of ['manualIncomeHash','manualCostHash','providerFeesHash'])if(a[key]!==b[key])throw Error('MANUAL_DATA_CHANGED');
JS
phase=startup
set_tag "$tag"
compose up -d --no-build api web >"$evidence/start.log" 2>&1
health salary-settlement-admin-api-1
health salary-settlement-admin-web-1
[[ $(docker inspect salary-settlement-admin-api-1 -f '{{.Image}}') == $(docker image inspect "salary-settlement-api:$tag" -f '{{.Id}}') ]]
[[ $(docker inspect salary-settlement-admin-web-1 -f '{{.Image}}') == $(docker image inspect "salary-settlement-web:$tag" -f '{{.Id}}') ]]
curl -fsS https://api-salary.lovemiemie.com/health/ready >"$stage/formal-ready.json"
curl -fsS https://admin-salary.lovemiemie.com/healthz >"$stage/formal-web-health.txt"
phase=acceptance
node "$stage/login-check.cjs" "$evidence/login.private.json" "$evidence/token.private"
rm -f -- "$evidence/login.private.json"
cp "$evidence/after.json" "$stage/migration-after.json"
status DEPLOYED_HEALTH_AND_FORMAL_LOGIN_PASSED
node "$stage/acceptance.cjs" "$evidence/token.private" "$stage"
docker run --rm --user 0:0 -e NODE_PATH=/app/node_modules --network salary-settlement-admin_app --add-host host.docker.internal:172.30.80.1 --env-file "$envfile" -v "$stage:/release-checks:ro" -v "$evidence:/release-evidence:ro" "salary-settlement-api:$tag" node /release-checks/ledger-proof.cjs after >"$stage/ledger-proof.json"
guard "$tag" after >"$evidence/after-refresh.json"
node - "$evidence/immediate-before.json" "$evidence/after-refresh.json" <<'JS'
const fs=require("fs"),a=JSON.parse(fs.readFileSync(process.argv[2])),b=JSON.parse(fs.readFileSync(process.argv[3]));for(const key of ["manualIncomeHash","manualCostHash","providerFeesHash"])if(a[key]!==b[key])throw Error("MANUAL_DATA_CHANGED");
JS
cp "$evidence/after-refresh.json" "$stage/manual-preservation.json"
rm -f -- "$evidence/token.private"
phase=complete
status DEPLOYMENT_AND_ACCEPTANCE_COMPLETE
chown salaryops:salaryops "$stage"/*.txt "$stage"/*.json
