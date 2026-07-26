#!/usr/bin/env bash
set -Eeuo pipefail

candidate='/etc/nginx/sites-available/salary-production-rc-20260712-2'
baseline='/etc/nginx/sites-available/salary-baseline'
enabled='/etc/nginx/sites-enabled/salary-baseline'
temporary_link='/etc/nginx/sites-enabled/.salary-baseline.task80-new'
switched=0

check_https() {
  local label="$1"
  local hostname="$2"
  local path="$3"
  local code='000'

  for attempt in $(seq 1 15); do
    code="$(curl --noproxy '*' -sS \
      --resolve "${hostname}:443:127.0.0.1" \
      -o /dev/null -w '%{http_code}' \
      "https://${hostname}${path}" || true)"
    if [[ "$code" == '200' ]]; then
      echo "CUTOVER_HEALTH=$label STATUS=pass HTTP=200 ATTEMPT=$attempt"
      return 0
    fi
    sleep 1
  done

  echo "CUTOVER_HEALTH=$label STATUS=fail HTTP=$code ATTEMPTS=15" >&2
  return 1
}

rollback() {
  local exit_code=$?
  trap - ERR
  if [[ "$switched" -eq 1 ]]; then
    ln -sfn "$baseline" "$temporary_link"
    mv -Tf "$temporary_link" "$enabled"
    nginx -t
    systemctl reload nginx
    echo 'NGINX_ROLLBACK_STATUS=success' >&2
  fi
  exit "$exit_code"
}
trap rollback ERR

if [[ "$EUID" -ne 0 ]]; then
  echo 'ERROR: run through sudo.' >&2
  exit 1
fi

[[ -f "$candidate" && -f "$baseline" ]]
[[ -L "$enabled" && "$(readlink -f "$enabled")" == "$baseline" ]]

curl -fsS -o /dev/null http://127.0.0.1:3000/health/live
curl -fsS -o /dev/null http://127.0.0.1:3000/health/ready
curl -fsS -o /dev/null http://127.0.0.1:8080/healthz
curl -fsS -o /dev/null http://127.0.0.1:8080/

ln -sfn "$candidate" "$temporary_link"
mv -Tf "$temporary_link" "$enabled"
switched=1

nginx -t
systemctl reload nginx
systemctl is-active --quiet nginx

check_https 'admin-root' 'admin-salary.lovemiemie.com' '/'
check_https 'api-live' 'api-salary.lovemiemie.com' '/health/live'
check_https 'api-ready' 'api-salary.lovemiemie.com' '/health/ready'

trap - ERR
echo 'NGINX_CUTOVER_STATUS=success'
echo "ACTIVE_TARGET=$(readlink -f "$enabled")"
nginx -t
