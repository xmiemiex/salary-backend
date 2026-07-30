#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
recovery_tool="${script_dir}/backup-key-recovery"
backup_script="${script_dir}/salary-postgres-backup"
watchdog="${script_dir}/salary-postgres-backup-watchdog"

bash -n "$recovery_tool"
bash -n "$backup_script"
bash -n "$watchdog"
bash "$recovery_tool" --self-test

grep -qx "key_file='/etc/salary-settlement-admin/backup-file-encryption.key'" "$backup_script"
if grep -qE 'salary-settlement-admin-key-recovery|recovery_key|backup-key-recovery' "$backup_script"; then
  echo 'TASK94_BACKUP_FALLBACK_TEST=fail' >&2
  exit 1
fi
grep -qx "key_recovery_tool='/usr/local/sbin/backup-key-recovery'" "$watchdog"
grep -q 'BACKUP_ACTIVE_KEY_MISSING' "${script_dir}/backup-watchdog-db.cjs"
grep -q 'BACKUP_KEY_RECOVERY_DECRYPT_FAILED' "${script_dir}/backup-watchdog-db.cjs"

echo 'TASK94_BACKUP_FALLBACK_TEST=pass'
echo 'TASK94_KEY_RECOVERY_TESTS=pass'
