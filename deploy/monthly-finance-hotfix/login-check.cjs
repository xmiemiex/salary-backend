const fs = require('node:fs'), path = require('node:path'), { publicEncrypt, randomBytes, createCipheriv } = require('node:crypto');
(async () => {
  if (process.argv[2] === '--logout') {
    if (!fs.existsSync(process.argv[3])) return;
    const r = await fetch('https://api-salary.lovemiemie.com/auth/logout', { method: 'POST', headers: { authorization: 'Bearer ' + fs.readFileSync(process.argv[3], 'utf8') }, signal: AbortSignal.timeout(30000) });
    if (!r.ok && r.status !== 401) throw Error('LOGOUT_FAILED');
    fs.unlinkSync(process.argv[3]); return;
  }
  // Revoke the previous preflight session before replacing its token file.
  if (fs.existsSync(process.argv[3])) {
    const logout = await fetch('https://api-salary.lovemiemie.com/auth/logout', { method: 'POST', headers: { authorization: 'Bearer ' + fs.readFileSync(process.argv[3], 'utf8') }, signal: AbortSignal.timeout(30000) });
    if (!logout.ok && logout.status !== 401) throw Error('PREFLIGHT_LOGOUT_FAILED');
    fs.unlinkSync(process.argv[3]);
  }
  const body = fs.readFileSync(process.argv[2], 'utf8');
  const r = await fetch('https://api-salary.lovemiemie.com/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(30000) });
  const response = await r.json(); if (!r.ok || !response.token) throw Error('LOGIN_FAILED');
  fs.writeFileSync(process.argv[3], response.token, { mode: 0o600 });
  if (process.argv[4]) {
    const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(response.token), cipher.final()]);
    fs.writeFileSync(path.join(path.dirname(process.argv[3]), 'browser-session.encrypted.json'), JSON.stringify({ key: publicEncrypt(fs.readFileSync(process.argv[4]), key).toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') }), { mode: 0o600 });
  }
  console.log('FORMAL_HTTPS_LOGIN_PASSED');
})().catch(() => { console.error('FORMAL_HTTPS_LOGIN_FAILED'); process.exitCode = 1; });
