#!/usr/bin/env bash
set -euo pipefail

release_dir='/opt/salary-settlement-admin/releases/rc-20260712-2-9f8f8f57'
prod_env='/opt/salary-settlement-admin/shared/.env'
baseline='/etc/nginx/sites-available/salary-baseline'
candidate='/etc/nginx/sites-available/salary-production-rc-20260712-2'
enabled='/etc/nginx/sites-enabled/salary-baseline'
temporary_link='/etc/nginx/sites-enabled/.salary-baseline.task80-rollback'
rollback_id="$(date -u +%Y%m%dT%H%M%SZ)"
log_dir="/opt/salary-settlement-admin/logs/task80-rollback-${rollback_id}"

if [[ "$EUID" -ne 0 ]]; then
  echo 'ERROR: run through sudo.' >&2
  exit 1
fi

[[ -f "$baseline" && -f "$candidate" && -L "$enabled" ]]

install -d -o root -g salaryapp -m 0750 "$log_dir"
docker inspect salary-settlement-admin-api-1 salary-settlement-admin-web-1 \
  --format 'CONTAINER={{.Name}} IMAGE={{.Config.Image}} STATUS={{.State.Status}} HEALTH={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} RESTART_COUNT={{.RestartCount}}' \
  >"$log_dir/container-state.txt"
docker logs salary-settlement-admin-api-1 >"$log_dir/api.log" 2>&1 || true
docker logs salary-settlement-admin-web-1 >"$log_dir/web.log" 2>&1 || true
chown -R root:salaryapp "$log_dir"
chmod 0640 "$log_dir"/*

ln -sfn "$baseline" "$temporary_link"
mv -Tf "$temporary_link" "$enabled"
nginx -t
systemctl reload nginx
systemctl is-active --quiet nginx

wait_for_503() {
  local label="$1"
  local host="$2"
  local path="$3"
  local code
  local attempt

  for attempt in $(seq 1 15); do
    code="$(
      curl --noproxy '*' -sS \
        --resolve "${host}:443:127.0.0.1" \
        -o /dev/null \
        -w '%{http_code}' \
        "https://${host}${path}"
    )"

    if [[ "$code" == '503' ]]; then
      echo "ROLLBACK_HEALTH=$label STATUS=pass HTTP=$code ATTEMPT=$attempt"
      return 0
    fi

    sleep 1
  done

  echo "ERROR: $label did not return the expected HTTP 503 after 15 attempts; last HTTP=$code." >&2
  return 1
}

wait_for_503 'admin-root' 'admin-salary.lovemiemie.com' '/'
wait_for_503 'api-live' 'api-salary.lovemiemie.com' '/health/live'

docker compose \
  --project-directory "$release_dir" \
  --env-file "$prod_env" \
  -f "$release_dir/docker-compose.prod.yml" \
  down

systemctl is-active --quiet nginx
systemctl is-active --quiet postgresql

echo 'TASK80_ROLLBACK_STATUS=success'
echo "ROLLBACK_ID=$rollback_id"
echo "ACTIVE_TARGET=$(readlink -f "$enabled")"
echo 'ADMIN_LOCAL_HTTP=503'
echo 'API_LOCAL_HTTP=503'
echo 'API_WEB_CONTAINERS=stopped_removed'
echo "LOG_BUNDLE=$log_dir"
