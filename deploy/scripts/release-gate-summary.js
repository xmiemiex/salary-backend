'use strict';

const { readFileSync } = require('node:fs');

const path = process.argv[2];
if (!path) {
  console.error('RELEASE_GATE_SUMMARY_ERROR=missing_input');
  process.exit(2);
}

let result;
try {
  result = JSON.parse(readFileSync(path, 'utf8'));
} catch {
  console.error('RELEASE_GATE_SUMMARY_ERROR=invalid_json');
  process.exit(2);
}

const checks = Array.isArray(result.checks) ? result.checks : [];
const codes = (severity, status) => checks
  .filter((check) => check.severity === severity && check.status === status)
  .map((check) => check.code)
  .sort();

console.log(`RELEASE_GATE_STATUS=${result.status ?? 'unknown'}`);
console.log(`RELEASE_GATE_GENERATED_AT=${result.generatedAt ?? 'unknown'}`);
console.log(`RELEASE_GATE_PASS=${result.summary?.pass ?? 'unknown'}`);
console.log(`RELEASE_GATE_WARNING=${result.summary?.warning ?? 'unknown'}`);
console.log(`RELEASE_GATE_FAIL=${result.summary?.fail ?? 'unknown'}`);
console.log(`REQUIRED_FAIL_CODES=${codes('required', 'fail').join(',') || 'none'}`);
console.log(`REQUIRED_WARNING_CODES=${codes('required', 'warning').join(',') || 'none'}`);
console.log(`RECOMMENDED_WARNING_CODES=${codes('recommended', 'warning').join(',') || 'none'}`);
