#!/usr/bin/env bash
# Prepared only. Execute on the existing host AFTER explicit production approval.
set -euo pipefail
mode=${1:-plan}
if [[ "$mode" == plan ]]; then
  echo 'Preparation only. Approved operator must supply RELEASE_IMAGE_TAG, APPROVED_SOURCE_SHA256, SOURCE_ARCHIVE, VERIFIED_BACKUP_FILE and VERIFIED_BACKUP_SHA256, then use deploy-approved. rollback-approved restores the existing image pair and retains additive schema.'
  exit 0
fi
[[ "$mode" == deploy-approved || "$mode" == rollback-approved ]] || exit 2
[[ $EUID == 0 ]] || { echo 'Run in the approved sudo session'; exit 2; }
[[ "$PWD" == /opt/salary-settlement-admin/releases/* ]] || exit 2
export PRODUCTION_ENV_FILE=/opt/salary-settlement-admin/shared/.env
export VITE_API_BASE_URL=https://api-salary.lovemiemie.com
old=task102-f859d79c2b8f
api_id=sha256:6f940a27f83b5d9e1ee40c726c2accfdb2a0350bf2bd6bb7c57e4ce1253a63bf
web_id=sha256:7a13601d4578ab54a082372955cb25dcbc9d86ab264d96f7022dd6e1af52083c
[[ $(docker image inspect "salary-settlement-api:$old" -f '{{.Id}}') == "$api_id" ]]
[[ $(docker image inspect "salary-settlement-web:$old" -f '{{.Id}}') == "$web_id" ]]
compose() { docker compose -p salary-settlement-admin -f docker-compose.prod.yml "$@"; }
if [[ "$mode" == rollback-approved ]]; then
  export RELEASE_IMAGE_TAG=$old
  compose up -d --no-build api web
  echo 'Old image pair started; additive database schema retained. Verify ready, login, read-only salary pages. No database restore performed.'
  exit 0
fi
: "${RELEASE_IMAGE_TAG:?immutable candidate tag required}"
[[ "$RELEASE_IMAGE_TAG" != "$old" && "$RELEASE_IMAGE_TAG" =~ ^monthly-[a-f0-9]{12}$ ]]
: "${SOURCE_ARCHIVE:?}" "${APPROVED_SOURCE_SHA256:?}" "${VERIFIED_BACKUP_FILE:?}" "${VERIFIED_BACKUP_SHA256:?}"
printf '%s  %s\n' "$APPROVED_SOURCE_SHA256" "$SOURCE_ARCHIVE" | sha256sum -c -
printf '%s  %s\n' "$VERIFIED_BACKUP_SHA256" "$VERIFIED_BACKUP_FILE" | sha256sum -c -
# Prevent accidentally upgrading a production version different from the reviewed baseline.
[[ $(docker inspect "$(compose ps -q api)" -f '{{.Image}}') == "$api_id" ]]
[[ $(docker inspect "$(compose ps -q web)" -f '{{.Image}}') == "$web_id" ]]
compose build api web
# Planned maintenance: stop all app writers before migration and keep them stopped on migration failure.
compose stop api web
docker run --rm --network salary-settlement-admin_app --add-host host.docker.internal:172.30.80.1 \
  --env-file "$PRODUCTION_ENV_FILE" -v "$PWD/prisma:/app/prisma:ro" \
  "salary-settlement-api:$RELEASE_IMAGE_TAG" node node_modules/prisma/build/index.js migrate deploy
compose up -d --no-build api web
echo 'Verify health/readiness, formal HTTPS login, permissions and approved financial checks. Do not enable scheduled sync flags.'
