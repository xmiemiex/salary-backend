#!/usr/bin/env bash
set -Eeuo pipefail

release_id='rc-20260712-2-9f8f8f57'
release_dir="/opt/salary-settlement-admin/releases/${release_id}"
prod_env='/opt/salary-settlement-admin/shared/.env'
baseline='/etc/nginx/sites-available/salary-baseline'
enabled='/etc/nginx/sites-enabled/salary-baseline'
backup_dir='/opt/salary-settlement-admin/backups'

if [[ "$EUID" -ne 0 ]]; then
  echo 'TASK82_PREFLIGHT_STATUS=fail reason=requires_root' >&2
  exit 1
fi

for unit in nginx docker postgresql; do
  systemctl is-active --quiet "$unit"
done

failed_units="$(systemctl --failed --no-legend --plain | sed '/^[[:space:]]*$/d' | wc -l)"
[[ "$failed_units" -eq 0 ]]

[[ -d "$release_dir" ]]
[[ -f "$release_dir/docker-compose.prod.yml" ]]
[[ -f "$prod_env" ]]
[[ -f "$baseline" ]]
[[ -L "$enabled" ]]
[[ "$(readlink -f "$enabled")" == "$baseline" ]]
[[ -d "$backup_dir" ]]

env_mode="$(stat -c '%a' "$prod_env")"
env_owner="$(stat -c '%U:%G' "$prod_env")"
[[ "$env_mode" == '640' ]]
[[ "$env_owner" == 'root:salaryapp' ]]

systemctl is-enabled --quiet salary-postgres-backup.timer
systemctl is-active --quiet salary-postgres-backup.timer

unexpected_containers="$(
  docker ps -a --format '{{.Names}}' |
    grep -Ev '^(salary-settlement-admin-(api|web)-1)?$' || true
)"
[[ -z "$unexpected_containers" ]]

for image in \
  'salary-settlement-api:rc-20260712-2' \
  'salary-settlement-web:rc-20260712-2' \
  'salary-settlement-migration:rc-20260712-2'; do
  docker image inspect "$image" >/dev/null
done

check_503() {
  local host="$1"
  local path="$2"
  local code
  code="$(
    curl --noproxy '*' -sS \
      --resolve "${host}:443:127.0.0.1" \
      -o /dev/null -w '%{http_code}' \
      "https://${host}${path}"
  )"
  [[ "$code" == '503' ]]
  echo "TASK82_BASELINE_HEALTH host=$host path=$path http=$code"
}

check_503 'admin-salary.lovemiemie.com' '/'
check_503 'api-salary.lovemiemie.com' '/health/live'
check_503 'api-salary.lovemiemie.com' '/health/ready'

root_available_kb="$(df --output=avail -k / | tail -n 1 | tr -d ' ')"
memory_available_kb="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
[[ "$root_available_kb" -ge 10485760 ]]
[[ "$memory_available_kb" -ge 1048576 ]]

echo 'TASK82_PREFLIGHT_STATUS=pass'
echo "TASK82_RELEASE_ID=$release_id"
echo "TASK82_FAILED_UNITS=$failed_units"
echo "TASK82_NGINX_TARGET=$(readlink -f "$enabled")"
echo "TASK82_ENV_METADATA=mode:${env_mode},owner:${env_owner}"
echo "TASK82_ROOT_AVAILABLE_KB=$root_available_kb"
echo "TASK82_MEMORY_AVAILABLE_KB=$memory_available_kb"
