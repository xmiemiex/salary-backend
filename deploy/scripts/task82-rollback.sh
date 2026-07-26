#!/usr/bin/env bash
set -Eeuo pipefail

release_id='rc-20260712-2-9f8f8f57'
release_dir="/opt/salary-settlement-admin/releases/${release_id}"
prod_env='/opt/salary-settlement-admin/shared/.env'
baseline='/etc/nginx/sites-available/salary-baseline'
enabled='/etc/nginx/sites-enabled/salary-baseline'
temporary_link='/etc/nginx/sites-enabled/.salary-baseline.task82-rollback'
rollback_id="$(date -u +%Y%m%dT%H%M%SZ)"
log_dir="/opt/salary-settlement-admin/logs/task82-rollback-${rollback_id}"

if [[ "$EUID" -ne 0 ]]; then
  echo 'TASK82_ROLLBACK_STATUS=fail reason=requires_root' >&2
  exit 1
fi

install -d -o root -g salaryapp -m 0750 "$log_dir"

for container in salary-settlement-admin-api-1 salary-settlement-admin-web-1; do
  if docker inspect "$container" >/dev/null 2>&1; then
    docker inspect "$container" \
      --format 'CONTAINER={{.Name}} IMAGE={{.Config.Image}} STATUS={{.State.Status}} HEALTH={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} RESTART_COUNT={{.RestartCount}}' \
      >>"$log_dir/container-state.txt"
    docker logs "$container" >"$log_dir/${container}.log" 2>&1 || true
  fi
done

ln -sfn "$baseline" "$temporary_link"
mv -Tf "$temporary_link" "$enabled"
nginx -t
systemctl reload nginx
systemctl is-active --quiet nginx

wait_for_503() {
  local host="$1"
  local path="$2"
  local code='000'
  local attempt
  for attempt in $(seq 1 15); do
    code="$(
      curl --noproxy '*' -sS \
        --resolve "${host}:443:127.0.0.1" \
        -o /dev/null -w '%{http_code}' \
        "https://${host}${path}" || true
    )"
    if [[ "$code" == '503' ]]; then
      echo "TASK82_ROLLBACK_HEALTH host=$host path=$path http=$code attempt=$attempt"
      return 0
    fi
    sleep 1
  done
  echo "TASK82_ROLLBACK_HEALTH host=$host path=$path http=$code status=fail" >&2
  return 1
}

wait_for_503 'admin-salary.lovemiemie.com' '/'
wait_for_503 'api-salary.lovemiemie.com' '/health/live'

docker compose \
  --project-directory "$release_dir" \
  --env-file "$prod_env" \
  -f "$release_dir/docker-compose.prod.yml" \
  down --remove-orphans

chown -R root:salaryapp "$log_dir"
find "$log_dir" -type f -exec chmod 0640 {} +

echo 'TASK82_ROLLBACK_STATUS=success'
echo "TASK82_ROLLBACK_ID=$rollback_id"
echo "TASK82_ROLLBACK_NGINX_TARGET=$(readlink -f "$enabled")"
echo "TASK82_ROLLBACK_LOG_DIR=$log_dir"
echo 'TASK82_ROLLBACK_DATABASE_ACTION=none'
