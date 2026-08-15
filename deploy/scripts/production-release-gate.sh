#!/usr/bin/env bash
set -euo pipefail

prod_env='/opt/salary-settlement-admin/shared/.env'
summary='/home/salaryops/release-gate-summary.js'
env_helper='/home/salaryops/production-env-check.js'
migration_helper='/home/salaryops/production-migration-evidence.js'
evidence_dir='/opt/salary-settlement-admin/evidence/release-gate-current'
run_id="release-gate-$(date -u +%Y%m%dT%H%M%SZ)"
run_dir="/opt/salary-settlement-admin/evidence/release-gate-runs/${run_id}"
migration_image='salary-settlement-migration:rc-20260712-2'

if [[ "$EUID" -ne 0 ]]; then
  echo 'ERROR: run through sudo.' >&2
  exit 1
fi

release_tag="$(awk -F= '$1 == "RELEASE_IMAGE_TAG" { value=$2 } END { gsub(/^[[:space:]\"'\'' ]+|[[:space:]\"'\'' ]+$/, "", value); print value }' "$prod_env")"
case "$release_tag" in
  rc-20260712-2)
    release_dir='/opt/salary-settlement-admin/releases/rc-20260712-2-9f8f8f57'
    ;;
  task96-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
    release_dir="/opt/salary-settlement-admin/releases/${release_tag}"
    ;;
  task97-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
    release_dir="/opt/salary-settlement-admin/releases/${release_tag}"
    ;;
  task98-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
    release_dir="/opt/salary-settlement-admin/releases/${release_tag}"
    ;;
  *)
    echo 'PRODUCTION_RELEASE_GATE_ERROR=invalid_release_image_tag' >&2
    exit 2
    ;;
esac
api_image="salary-settlement-api:${release_tag}"

for required_file in \
  "$prod_env" \
  "$summary" \
  "$env_helper" \
  "$migration_helper" \
  "$release_dir/prisma/schema.prisma"; do
  if [[ ! -f "$required_file" ]]; then
    echo "PRODUCTION_RELEASE_GATE_ERROR=missing_required_file file=$(basename "$required_file")" >&2
    exit 2
  fi
done

install -d -m 0750 -o root -g salaryops \
  "$evidence_dir" \
  "$(dirname "$run_dir")" \
  "$run_dir"

collection_dir="$(mktemp -d /run/production-release-gate.XXXXXX)"
chmod 0700 "$collection_dir"
cleanup() {
  rm -rf -- "$collection_dir"
}
trap cleanup EXIT

evidence_collection_exit=0
docker run --rm \
  --user 0:0 \
  --env-file "$prod_env" \
  --mount "type=bind,src=$env_helper,dst=/tmp/production-env-check.js,readonly" \
  --mount "type=bind,src=$collection_dir,dst=/app/tmp/release-evidence" \
  "$api_image" \
  node /tmp/production-env-check.js /app/tmp/release-evidence/env-check.json \
  >"$run_dir/env-check.log" 2>&1 ||
  evidence_collection_exit=1

docker run --rm \
  --network salary-settlement-admin_app \
  --add-host host.docker.internal:172.30.80.1 \
  --env-file "$prod_env" \
  --mount "type=bind,src=$release_dir/prisma,dst=/app/prisma,readonly" \
  --mount "type=bind,src=$collection_dir,dst=/app/tmp/release-evidence" \
  --mount "type=bind,src=$migration_helper,dst=/app/production-migration-evidence.js,readonly" \
  "$migration_image" \
  node /app/production-migration-evidence.js /app/tmp/release-evidence/migration-status.json \
  >"$run_dir/migration-status.log" 2>&1 ||
  evidence_collection_exit=1

for evidence_name in env-check migration-status; do
  if [[ -f "$collection_dir/${evidence_name}.json" ]]; then
    install -m 0640 -o root -g salaryops \
      "$collection_dir/${evidence_name}.json" \
      "$evidence_dir/${evidence_name}.json"
  fi
done

set +e
docker run --rm \
  --network salary-settlement-admin_app \
  --add-host host.docker.internal:172.30.80.1 \
  --env-file "$prod_env" \
  --mount "type=bind,src=$release_dir/scripts,dst=/app/scripts,readonly" \
  --mount "type=bind,src=$release_dir/docs,dst=/app/docs,readonly" \
  --mount "type=bind,src=$release_dir/README.md,dst=/app/README.md,readonly" \
  --mount "type=bind,src=$release_dir/apps/web/src,dst=/app/apps/web/src,readonly" \
  --mount "type=bind,src=$evidence_dir,dst=/app/tmp/release-evidence,readonly" \
  --mount "type=bind,src=$run_dir,dst=/task91-output" \
  --mount "type=bind,src=$summary,dst=/tmp/release-gate-summary.js,readonly" \
  "$migration_image" \
  sh -c '
    pnpm exec tsx scripts/release-check.ts --json >/task91-output/release-gate.json
    gate_exit=$?
    node /tmp/release-gate-summary.js /task91-output/release-gate.json
    summary_exit=$?
    echo "RELEASE_GATE_INNER_EXIT=$gate_exit"
    if [ "$summary_exit" -ne 0 ]; then exit 2; fi
    exit "$gate_exit"
  '
gate_exit=$?
set -e
chown -R root:salaryops "$run_dir"
find "$run_dir" -type f -exec chmod 0640 {} +
if [[ -f "$run_dir/release-gate.json" ]]; then
  install -m 0640 -o salaryops -g salaryops \
    "$run_dir/release-gate.json" \
    /home/salaryops/release-gate-latest.json
fi
echo "PRODUCTION_EVIDENCE_COLLECTION_EXIT=$evidence_collection_exit"
echo "PRODUCTION_RELEASE_GATE_EVIDENCE_DIR=$evidence_dir"
echo "PRODUCTION_RELEASE_GATE_RUN_DIR=$run_dir"
echo "PRODUCTION_RELEASE_GATE_EXIT=$gate_exit"
if [[ "$evidence_collection_exit" -ne 0 ]]; then
  exit 1
fi
exit "$gate_exit"
