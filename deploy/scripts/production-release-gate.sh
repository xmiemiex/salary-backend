#!/usr/bin/env bash
set -uo pipefail

release_dir='/opt/salary-settlement-admin/releases/rc-20260712-2-9f8f8f57'
prod_env='/opt/salary-settlement-admin/shared/.env'
summary='/home/salaryops/release-gate-summary.js'

if [[ "$EUID" -ne 0 ]]; then
  echo 'ERROR: run through sudo.' >&2
  exit 1
fi

docker run --rm \
  --network salary-settlement-admin_app \
  --add-host host.docker.internal:172.30.80.1 \
  --env-file "$prod_env" \
  --mount "type=bind,src=$release_dir/scripts,dst=/app/scripts,readonly" \
  --mount "type=bind,src=$release_dir/docs,dst=/app/docs,readonly" \
  --mount "type=bind,src=$release_dir/README.md,dst=/app/README.md,readonly" \
  --mount "type=bind,src=$release_dir/apps/web/src,dst=/app/apps/web/src,readonly" \
  --mount "type=bind,src=$summary,dst=/tmp/release-gate-summary.js,readonly" \
  salary-settlement-migration:rc-20260712-2 \
  sh -c '
    pnpm exec tsx scripts/release-check.ts --json >/tmp/release-gate.json
    gate_exit=$?
    node /tmp/release-gate-summary.js /tmp/release-gate.json
    summary_exit=$?
    echo "RELEASE_GATE_INNER_EXIT=$gate_exit"
    if [ "$summary_exit" -ne 0 ]; then exit 2; fi
    exit "$gate_exit"
  '
gate_exit=$?
echo "PRODUCTION_RELEASE_GATE_EXIT=$gate_exit"
exit "$gate_exit"
