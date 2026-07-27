import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORMAT,
  decryptBuffer,
  encryptBuffer,
  parseHeader,
  parseKeyText,
} from './backup-file-crypto.mjs';

const tool = fileURLToPath(new URL('./backup-file-crypto.mjs', import.meta.url));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'task90-crypto-test-'));
  const key = Buffer.alloc(32, 0x2a);
  const keyFile = join(directory, 'key');
  writeFileSync(keyFile, `${key.toString('base64')}\n`, { mode: 0o600 });
  return { directory, key, keyFile };
}

test('strict key parsing accepts exactly 32 canonical Base64 bytes', () => {
  const key = Buffer.alloc(32, 7);
  assert.deepEqual(parseKeyText(key.toString('base64')), key);
  assert.throws(() => parseKeyText(Buffer.alloc(31).toString('base64')), /invalid_key/);
  assert.throws(() => parseKeyText('not-base64'), /invalid_key/);
});

test('empty and multi-chunk payloads round-trip', () => {
  const key = Buffer.alloc(32, 8);
  for (const plain of [Buffer.alloc(0), Buffer.alloc(512 * 1024 + 31, 9)]) {
    assert.deepEqual(decryptBuffer(encryptBuffer(plain, key), key), plain);
  }
});

test('gzip is performed before encryption and decrypts to a valid gzip stream', () => {
  const key = Buffer.alloc(32, 10);
  const plain = Buffer.from('compressible salary backup fixture\n'.repeat(1000));
  const compressed = gzipSync(plain);
  const encrypted = encryptBuffer(compressed, key);
  assert.deepEqual(gunzipSync(decryptBuffer(encrypted, key)), plain);
  assert.ok(encrypted.length - compressed.length <= FORMAT.headerLength + FORMAT.ivLength + FORMAT.tagLength);
});

test('each encryption uses a distinct random IV', () => {
  const key = Buffer.alloc(32, 11);
  const left = encryptBuffer(Buffer.from('same'), key);
  const right = encryptBuffer(Buffer.from('same'), key);
  const ivStart = FORMAT.headerLength;
  assert.notDeepEqual(
    left.subarray(ivStart, ivStart + FORMAT.ivLength),
    right.subarray(ivStart, ivStart + FORMAT.ivLength),
  );
});

test('wrong key and ciphertext, header, tag, and truncation tampering fail', () => {
  const key = Buffer.alloc(32, 12);
  const encrypted = encryptBuffer(Buffer.from('authenticated fixture'), key);
  assert.throws(() => decryptBuffer(encrypted, Buffer.alloc(32, 13)));

  const ciphertext = Buffer.from(encrypted);
  ciphertext[FORMAT.headerLength + FORMAT.ivLength] ^= 1;
  assert.throws(() => decryptBuffer(ciphertext, key));

  const header = Buffer.from(encrypted);
  header[0] ^= 1;
  assert.throws(() => decryptBuffer(header, key), /invalid_magic/);

  const tag = Buffer.from(encrypted);
  tag[tag.length - 1] ^= 1;
  assert.throws(() => decryptBuffer(tag, key));

  assert.throws(() => decryptBuffer(encrypted.subarray(0, encrypted.length - 1), key));
  assert.throws(() => decryptBuffer(encrypted.subarray(0, FORMAT.headerLength), key), /truncated_file/);
});

test('strict header rejects reserved bytes and unsupported versions', () => {
  const header = Buffer.alloc(FORMAT.headerLength);
  FORMAT.magic.copy(header);
  header[8] = FORMAT.version;
  header[9] = FORMAT.algorithmId;
  header[10] = FORMAT.ivLength;
  header[11] = FORMAT.tagLength;
  parseHeader(header);
  header[12] = 1;
  assert.throws(() => parseHeader(header), /invalid_reserved_header/);
});

test('streaming CLI round-trips a large file without exposing the key', () => {
  const { directory, key, keyFile } = fixture();
  try {
    const plainPath = join(directory, 'plain');
    const encryptedPath = join(directory, 'backup.sql.gz.enc');
    const outputPath = join(directory, 'restored');
    const plain = Buffer.alloc(1024 * 1024 + 19, 0x5c);
    writeFileSync(plainPath, plain);
    execFileSync(process.execPath, [
      tool,
      'encrypt',
      '--key-file', keyFile,
      '--input', plainPath,
      '--output', encryptedPath,
    ]);
    execFileSync(process.execPath, [
      tool,
      'decrypt',
      '--key-file', keyFile,
      '--input', encryptedPath,
      '--output', outputPath,
    ]);
    assert.deepEqual(readFileSync(outputPath), plain);
    const selfTest = spawnSync(process.execPath, [tool, 'self-test', '--key-file', keyFile], { encoding: 'utf8' });
    assert.equal(selfTest.status, 0);
    assert.match(selfTest.stdout, /BACKUP_CRYPTO_SELF_TEST=pass/);
    assert.doesNotMatch(`${selfTest.stdout}${selfTest.stderr}`, new RegExp(key.toString('base64')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed authenticated file decryption leaves no successful output', () => {
  const { directory, key, keyFile } = fixture();
  try {
    const encryptedPath = join(directory, 'tampered.enc');
    const outputPath = join(directory, 'output');
    const encrypted = encryptBuffer(Buffer.alloc(128 * 1024, 3), key);
    encrypted[encrypted.length - 1] ^= 1;
    writeFileSync(encryptedPath, encrypted);
    const result = spawnSync(process.execPath, [
      tool,
      'decrypt',
      '--key-file', keyFile,
      '--input', encryptedPath,
      '--output', outputPath,
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.throws(() => readFileSync(outputPath));
    assert.doesNotMatch(result.stderr, new RegExp(key.toString('base64')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
