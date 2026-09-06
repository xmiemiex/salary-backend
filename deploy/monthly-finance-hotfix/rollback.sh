#!/usr/bin/env bash
# Application-only rollback. Never invokes migration or database restore.
set -Eeuo pipefail
umask 077
if [[ "${1:-plan}" == plan ]]; then echo 'Restore exact monthly-ea2b7f6a162f images, keep schema and all ledger data. No action performed.'; exit 0; fi
[[ "${1:-}" == rollback-approved && $EUID == 0 ]] || exit 2
old=monthly-ea2b7f6a162f
release=/opt/salary-settlement-admin/releases/monthly-hotfix-4328cada3fe0
evidence=/opt/salary-settlement-admin/release-evidence/monthly-hotfix-4328cada3fe0
envfile=/opt/salary-settlement-admin/shared/.env
[[ -d "$release" && -d "$evidence" ]]
[[ $(docker image inspect "salary-settlement-api:$old" -f '{{.Id}}') == sha256:8de5423b041f59f55ffbed072bb1712d2f5e13c218993f17528fd8bd18b98a81 ]]
[[ $(docker image inspect "salary-settlement-web:$old" -f '{{.Id}}') == sha256:b52b44407ba9d16d5cab6e4ef82dbedf6a53fec9271a1bad450b395733f98daf ]]
export RELEASE_IMAGE_TAG="$old" PRODUCTION_ENV_FILE="$envfile" VITE_API_BASE_URL=https://api-salary.lovemiemie.com
# A serious application regression can require interrupting a task. Record active count before the switch.
docker run --rm --env-file "$envfile" --network salary-settlement-admin_app --add-host host.docker.internal:172.30.80.1 "salary-settlement-api:$old" node -e 'const{PrismaClient}=require("@prisma/client");const p=new PrismaClient();p.syncTask.count({where:{status:{in:["pending","running","retry_wait"]}}}).then(n=>console.log(JSON.stringify({at:new Date().toISOString(),activeTasksBeforeRollback:n}))).catch(()=>{console.error("SAFE_ROLLBACK_TASK_READ_FAILED");process.exitCode=1}).finally(()=>p.$disconnect())' >"$evidence/rollback-active-tasks.json"
node - "$envfile" "$old" <<'JS'
const fs=require('fs'),p=process.argv[2],s=fs.readFileSync(p,'utf8');if(!/^RELEASE_IMAGE_TAG=/m.test(s))throw Error('TAG_SETTING_MISSING');const stat=fs.statSync(p),tmp=p+'.hotfix-tmp';fs.writeFileSync(tmp,s.replace(/^RELEASE_IMAGE_TAG=.*$/m,'RELEASE_IMAGE_TAG='+process.argv[3]),{mode:stat.mode});fs.chownSync(tmp,stat.uid,stat.gid);fs.renameSync(tmp,p);
JS
docker compose -p salary-settlement-admin --project-directory "$release" --env-file "$envfile" -f "$release/docker-compose.prod.yml" up -d --no-build api web >"$evidence/manual-rollback.log" 2>&1
for service in api web; do
  healthy=false
  for attempt in $(seq 1 40); do if [[ $(docker inspect -f '{{.State.Health.Status}}' "salary-settlement-admin-$service-1") == healthy ]]; then healthy=true; break; fi; sleep 3; done
  [[ "$healthy" == true ]]
done
curl -fsS https://api-salary.lovemiemie.com/health/ready >"$evidence/rollback-ready.json"
curl -fsS https://admin-salary.lovemiemie.com/healthz >"$evidence/rollback-web-health.txt"
printf '%s EXACT_OLD_IMAGES_RESTORED_SCHEMA_AND_DATA_RETAINED\n' "$(date -u +%FT%TZ)" >>"$evidence/status.txt"
echo 'Old images healthy. Verify formal login and task outcomes; interrupted leases remain governed by the existing bounded recovery policy.'
