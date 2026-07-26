'use strict';

const results = [];

function check(name, predicate) {
  let passed = false;
  try {
    passed = Boolean(predicate());
  } catch {
    passed = false;
  }
  results.push({ name, passed });
}

function required(name) {
  return typeof process.env[name] === 'string' && process.env[name].trim().length > 0;
}

function boundedInteger(name, minimum, maximum) {
  const value = process.env[name];
  if (!/^\d+$/.test(value ?? '')) return false;
  const parsed = Number(value);
  return parsed >= minimum && parsed <= maximum;
}

check('NODE_ENV', () => process.env.NODE_ENV === 'production');
check('APP_ENV', () => process.env.APP_ENV === 'production');
check('API_PORT', () => boundedInteger('API_PORT', 1, 65535));
check('PORT', () => boundedInteger('PORT', 1, 65535));
check('DATABASE_URL', () => {
  if (!required('DATABASE_URL')) return false;
  const url = new URL(process.env.DATABASE_URL);
  return url.protocol === 'postgresql:' &&
    url.username === 'salary_app' &&
    url.password.length >= 20 &&
    url.hostname === 'host.docker.internal' &&
    url.port === '5432' &&
    url.pathname === '/salary_settlement_prod' &&
    url.searchParams.get('schema') === 'public' &&
    url.searchParams.get('sslmode') === 'require';
});
check('CORS_ALLOWED_ORIGIN', () => {
  if (process.env.CORS_ALLOWED_ORIGIN !== 'https://admin-salary.lovemiemie.com') return false;
  const url = new URL(process.env.CORS_ALLOWED_ORIGIN);
  return url.origin === process.env.CORS_ALLOWED_ORIGIN && !url.username && !url.password;
});
check('ADMIN_SESSION_TTL_SECONDS', () => boundedInteger('ADMIN_SESSION_TTL_SECONDS', 60, 604800));
check('API_CREDENTIAL_ENCRYPTION_KEY', () => {
  if (!required('API_CREDENTIAL_ENCRYPTION_KEY')) return false;
  const raw = process.env.API_CREDENTIAL_ENCRYPTION_KEY;
  const normalized = raw.trim().toLowerCase();
  if (['<', '>', 'replace', 'change_me', 'changeme', 'example', 'generate_a_random'].some((marker) => normalized.includes(marker))) {
    return false;
  }
  if (Buffer.byteLength(raw, 'utf8') === 32) return true;
  const decoded = Buffer.from(raw, 'base64');
  return decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '');
});
check('BUILD_TIMESTAMP', () => required('BUILD_TIMESTAMP') && !Number.isNaN(Date.parse(process.env.BUILD_TIMESTAMP)));
check('RELEASE_IMAGE_TAG', () => process.env.RELEASE_IMAGE_TAG === 'rc-20260712-2');
check('VITE_API_BASE_URL', () => process.env.VITE_API_BASE_URL === 'https://api-salary.lovemiemie.com');
check('PRODUCTION_ENV_FILE', () => process.env.PRODUCTION_ENV_FILE === '/opt/salary-settlement-admin/shared/.env');
check('SYNC_PLANNER_ENABLED', () => ['true', 'false'].includes(process.env.SYNC_PLANNER_ENABLED));
check('SYNC_PLANNER_DAY', () => boundedInteger('SYNC_PLANNER_DAY', 1, 28));
check('SYNC_PLANNER_HOUR', () => boundedInteger('SYNC_PLANNER_HOUR', 0, 23));
check('SYNC_PLANNER_TIMEZONE', () => process.env.SYNC_PLANNER_TIMEZONE === 'Asia/Shanghai');
check('SYNC_AUTO_EXECUTION_ENABLED', () => ['true', 'false'].includes(process.env.SYNC_AUTO_EXECUTION_ENABLED));
check('SYNC_AUTO_EXECUTION_POLL_SECONDS', () => boundedInteger('SYNC_AUTO_EXECUTION_POLL_SECONDS', 1, 3600));
check('SYNC_AUTO_EXECUTION_BATCH_SIZE', () => boundedInteger('SYNC_AUTO_EXECUTION_BATCH_SIZE', 1, 10));
check('SYNC_AUTO_EXECUTION_MAX_ATTEMPTS', () => boundedInteger('SYNC_AUTO_EXECUTION_MAX_ATTEMPTS', 1, 5));
check('SYNC_AUTO_EXECUTION_LEASE_SECONDS', () => boundedInteger('SYNC_AUTO_EXECUTION_LEASE_SECONDS', 2, 86400));
check('SYNC_AUTO_EXECUTION_RETRY_BASE_SECONDS', () => boundedInteger('SYNC_AUTO_EXECUTION_RETRY_BASE_SECONDS', 1, 86400));
check('SYNC_AUTO_EXECUTION_LEASE_GT_POLL', () => {
  return Number(process.env.SYNC_AUTO_EXECUTION_LEASE_SECONDS) > Number(process.env.SYNC_AUTO_EXECUTION_POLL_SECONDS);
});

for (const result of results) {
  console.log(`ENV_CHECK name=${result.name} status=${result.passed ? 'pass' : 'fail'}`);
}

const failed = results.filter((result) => !result.passed).map((result) => result.name);
console.log(`ENV_CHECK_SUMMARY status=${failed.length === 0 ? 'pass' : 'fail'} checked=${results.length} failed=${failed.length}`);
if (failed.length > 0) {
  console.log(`ENV_CHECK_FAILED_NAMES=${failed.join(',')}`);
  process.exit(1);
}
