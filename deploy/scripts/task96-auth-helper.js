'use strict';

const { readFileSync, writeFileSync } = require('node:fs');

const [command, inputPath, outputPath] = process.argv.slice(2);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writePrivate(path, value) {
  writeFileSync(path, value, { mode: 0o600 });
}

if (command === 'build-login') {
  const values = readFileSync(0).toString('utf8').split('\0');
  const username = values[0] ?? '';
  const password = values[1] ?? '';
  if (!username || !password) throw new Error('Administrator username and password are required.');
  writePrivate(inputPath, JSON.stringify({ username, password }));
  console.log('TASK96_LOGIN_REQUEST=prepared');
} else if (command === 'extract-token') {
  const payload = readJson(inputPath);
  if (typeof payload?.token !== 'string' || !payload.token) throw new Error('Login response has no token.');
  writePrivate(outputPath, payload.token);
  console.log('TASK96_LOGIN_RESPONSE=valid');
} else if (command === 'select-account') {
  const rows = readJson(inputPath);
  if (!Array.isArray(rows)) throw new Error('Affiliate account list response is invalid.');
  const matches = rows.filter((row) => row?.platform === 'cake' && row?.accountCode === '329');
  if (matches.length > 1) throw new Error('Multiple CAKE/329 accounts exist.');
  writePrivate(outputPath, matches[0]?.id ?? '');
  console.log(`TASK96_EXISTING_ACCOUNT_COUNT=${matches.length}`);
} else if (command === 'verify-account') {
  const account = readJson(inputPath);
  if (account?.platform !== 'cake' || account?.accountCode !== '329' || account?.accountName !== 'Blitzads') {
    throw new Error('Production CAKE/329/Blitzads account verification failed.');
  }
  const text = JSON.stringify(account);
  if (/api.?key|encryptedPayload|credentialPayload|password|authorization/i.test(text)) {
    throw new Error('Affiliate account response contains a sensitive-looking field.');
  }
  console.log('TASK96_AFFILIATE_ACCOUNT_VERIFY=pass platform=cake accountCode=329 accountName=Blitzads');
} else {
  throw new Error('Usage: task96-auth-helper.js <build-login|extract-token|select-account|verify-account> ...');
}
