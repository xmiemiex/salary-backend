#!/usr/bin/env bash
set -euo pipefail

target='/opt/salary-settlement-admin/shared/.env'
target_dir="$(dirname "$target")"
tmp=''
placeholder_backup=''

cleanup() {
  unset db_password db_password_confirm encoded_password encryption_key
  if [[ -n "$tmp" && -e "$tmp" ]]; then
    rm -f -- "$tmp"
  fi
  if [[ -n "$placeholder_backup" && -e "$placeholder_backup" && ! -e "$target" ]]; then
    mv -- "$placeholder_backup" "$target"
    chown root:salaryapp "$target"
    chmod 0640 "$target"
  fi
}
trap cleanup EXIT

if [[ "${EUID}" -ne 0 ]]; then
  echo 'ERROR: run this script through sudo on the production server.' >&2
  exit 1
fi

if ! getent group salaryapp >/dev/null; then
  echo 'ERROR: required system group salaryapp does not exist.' >&2
  exit 1
fi

if [[ -e "$target" || -L "$target" ]]; then
  target_mode="$(stat -c '%a' "$target")"
  target_owner="$(stat -c '%U' "$target")"
  target_group="$(stat -c '%G' "$target")"
  if [[ -L "$target" || ! -f "$target" || -s "$target" ||
        "$target_mode" != '640' || "$target_owner" != 'root' || "$target_group" != 'salaryapp' ]]; then
    echo 'ERROR: production .env exists and is not the approved empty 0640 root:salaryapp placeholder; refusing to overwrite it.' >&2
    exit 1
  fi
fi

if ! command -v python3 >/dev/null || ! command -v openssl >/dev/null; then
  echo 'ERROR: python3 and openssl are required.' >&2
  exit 1
fi

read -r -s -p 'Enter the salary_app database password: ' db_password
echo >&2
read -r -s -p 'Confirm the salary_app database password: ' db_password_confirm
echo >&2

if [[ -z "$db_password" || "$db_password" != "$db_password_confirm" ]]; then
  echo 'ERROR: passwords are empty or do not match.' >&2
  exit 1
fi

if (( ${#db_password} < 20 )); then
  echo 'ERROR: database password must contain at least 20 characters.' >&2
  exit 1
fi

encoded_password="$({ printf '%s' "$db_password"; } | python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read(), safe=""), end="")')"
encryption_key="$(openssl rand -base64 32)"

install -d -o root -g salaryapp -m 0750 "$target_dir"
tmp="$(mktemp "${target}.task80.XXXXXX")"
chown root:salaryapp "$tmp"
chmod 0640 "$tmp"

{
  printf '%s\n' \
    'NODE_ENV=production' \
    'APP_ENV=production' \
    'API_PORT=3000' \
    'PORT=3000'
  printf 'DATABASE_URL=postgresql://salary_app:%s@host.docker.internal:5432/salary_settlement_prod?schema=public&sslmode=require\n' "$encoded_password"
  printf '%s\n' \
    'CORS_ALLOWED_ORIGIN=https://admin-salary.lovemiemie.com' \
    'ADMIN_SESSION_TTL_SECONDS=43200'
  printf 'API_CREDENTIAL_ENCRYPTION_KEY=%s\n' "$encryption_key"
  printf 'BUILD_TIMESTAMP=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' \
    'RELEASE_IMAGE_TAG=rc-20260712-2' \
    'VITE_API_BASE_URL=https://api-salary.lovemiemie.com' \
    'PRODUCTION_ENV_FILE=/opt/salary-settlement-admin/shared/.env' \
    'SYNC_PLANNER_ENABLED=false' \
    'SYNC_PLANNER_DAY=10' \
    'SYNC_PLANNER_HOUR=9' \
    'SYNC_PLANNER_TIMEZONE=Asia/Shanghai' \
    'SYNC_AUTO_EXECUTION_ENABLED=false' \
    'SYNC_AUTO_EXECUTION_POLL_SECONDS=60' \
    'SYNC_AUTO_EXECUTION_BATCH_SIZE=2' \
    'SYNC_AUTO_EXECUTION_MAX_ATTEMPTS=3' \
    'SYNC_AUTO_EXECUTION_LEASE_SECONDS=900' \
    'SYNC_AUTO_EXECUTION_RETRY_BASE_SECONDS=300'
} >"$tmp"

if [[ -e "$target" ]]; then
  placeholder_backup="${target}.pre-task80-$(date -u +%Y%m%dT%H%M%SZ).empty"
  mv -- "$target" "$placeholder_backup"
  chown root:root "$placeholder_backup"
  chmod 0600 "$placeholder_backup"
fi

mv -- "$tmp" "$target"
tmp=''
chown root:salaryapp "$target"
chmod 0640 "$target"

echo 'ENV_WRITE_STATUS=success'
stat -c 'ENV_MODE=%a ENV_OWNER=%U ENV_GROUP=%G' "$target"
if [[ -n "$placeholder_backup" ]]; then
  echo "EMPTY_PLACEHOLDER_BACKUP=$(basename "$placeholder_backup")"
fi
awk -F= 'NF >= 2 { print "ENV_KEY=" $1 " STATUS=configured" }' "$target"
