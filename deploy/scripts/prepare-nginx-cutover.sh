#!/usr/bin/env bash
set -euo pipefail

template='/home/salaryops/salary-production.conf.template'
candidate='/etc/nginx/sites-available/salary-production-rc-20260712-2'
baseline='/etc/nginx/sites-available/salary-baseline'
enabled='/etc/nginx/sites-enabled/salary-baseline'
fullchain='/etc/letsencrypt/live/salary-production/fullchain.pem'
private_key='/etc/letsencrypt/live/salary-production/privkey.pem'
change_id="$(date -u +%Y%m%dT%H%M%SZ)"
backup="${baseline}.task80-${change_id}.bak"
test_conf="/run/nginx-task80-${change_id}.conf"
rendered="$(mktemp /run/salary-production-candidate.XXXXXX)"

cleanup() {
  rm -f -- "$rendered" "$test_conf"
}
trap cleanup EXIT

if [[ "$EUID" -ne 0 ]]; then
  echo 'ERROR: run through sudo.' >&2
  exit 1
fi

[[ -f "$template" && -f "$baseline" && -f "$fullchain" && -f "$private_key" ]]
[[ -L "$enabled" && "$(readlink -f "$enabled")" == "$baseline" ]]
[[ "$(grep -cF 'include /etc/nginx/sites-enabled/*;' /etc/nginx/nginx.conf)" -eq 1 ]]

sed \
  -e "s|<CERTIFICATE_FULLCHAIN_PATH>|$fullchain|g" \
  -e "s|<CERTIFICATE_PRIVATE_KEY_PATH>|$private_key|g" \
  "$template" >"$rendered"

if grep -Eq '<[^>]+>' "$rendered"; then
  echo 'ERROR: unresolved candidate placeholder.' >&2
  exit 1
fi

install -o root -g root -m 0644 "$rendered" "$candidate"
install -o root -g root -m 0600 "$baseline" "$backup"

sed \
  "s@include /etc/nginx/sites-enabled/\*;@include $candidate;@" \
  /etc/nginx/nginx.conf >"$test_conf"

nginx -t -c "$test_conf"

echo 'CANDIDATE_PREPARE_STATUS=success'
echo "CHANGE_ID=$change_id"
echo "CANDIDATE=$candidate"
echo "BASELINE_BACKUP=$backup"
sha256sum "$candidate" "$backup"
