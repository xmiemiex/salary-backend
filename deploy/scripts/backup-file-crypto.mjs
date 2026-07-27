#!/usr/bin/env node

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

export const FORMAT = Object.freeze({
  magic: Buffer.from('SLRYBKUP', 'ascii'),
  version: 1,
  algorithmId: 1,
  algorithm: 'aes-256-gcm',
  headerLength: 16,
  ivLength: 12,
  tagLength: 16,
});

const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/;

export function parseKeyText(text) {
  const value = text.trim();
  if (!BASE64_KEY.test(value)) throw new Error('invalid_key_encoding');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('invalid_key_length');
  }
  return key;
}

export function readKeyFile(path) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('key_file_required');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid_key_file');
  return parseKeyText(readFileSync(path, 'utf8'));
}

export function keyFingerprint(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function buildHeader() {
  const header = Buffer.alloc(FORMAT.headerLength);
  FORMAT.magic.copy(header, 0);
  header[8] = FORMAT.version;
  header[9] = FORMAT.algorithmId;
  header[10] = FORMAT.ivLength;
  header[11] = FORMAT.tagLength;
  header.writeUInt32BE(0, 12);
  return header;
}

export function parseHeader(header) {
  if (!Buffer.isBuffer(header) || header.length !== FORMAT.headerLength) {
    throw new Error('invalid_header_length');
  }
  if (!header.subarray(0, FORMAT.magic.length).equals(FORMAT.magic)) {
    throw new Error('invalid_magic');
  }
  if (header[8] !== FORMAT.version) throw new Error('unsupported_version');
  if (header[9] !== FORMAT.algorithmId) throw new Error('unsupported_algorithm');
  if (header[10] !== FORMAT.ivLength || header[11] !== FORMAT.tagLength) {
    throw new Error('invalid_crypto_parameters');
  }
  if (header.readUInt32BE(12) !== 0) throw new Error('invalid_reserved_header');
  return {
    version: FORMAT.version,
    algorithm: FORMAT.algorithm,
    ivLength: FORMAT.ivLength,
    tagLength: FORMAT.tagLength,
  };
}

export function encryptBuffer(plain, key, iv = randomBytes(FORMAT.ivLength)) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid_key_length');
  if (!Buffer.isBuffer(iv) || iv.length !== FORMAT.ivLength) throw new Error('invalid_iv_length');
  const header = buildHeader();
  const cipher = createCipheriv(FORMAT.algorithm, key, iv, { authTagLength: FORMAT.tagLength });
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([header, iv, ciphertext, cipher.getAuthTag()]);
}

export function decryptBuffer(encrypted, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid_key_length');
  const minimum = FORMAT.headerLength + FORMAT.ivLength + FORMAT.tagLength;
  if (!Buffer.isBuffer(encrypted) || encrypted.length < minimum) throw new Error('truncated_file');
  const header = encrypted.subarray(0, FORMAT.headerLength);
  parseHeader(header);
  const ivStart = FORMAT.headerLength;
  const cipherStart = ivStart + FORMAT.ivLength;
  const tagStart = encrypted.length - FORMAT.tagLength;
  const decipher = createDecipheriv(
    FORMAT.algorithm,
    key,
    encrypted.subarray(ivStart, cipherStart),
    { authTagLength: FORMAT.tagLength },
  );
  decipher.setAAD(header);
  decipher.setAuthTag(encrypted.subarray(tagStart));
  return Buffer.concat([
    decipher.update(encrypted.subarray(cipherStart, tagStart)),
    decipher.final(),
  ]);
}

function inputStream(path) {
  return path === '-' ? process.stdin : createReadStream(path);
}

async function writeChunk(stream, chunk) {
  if (chunk.length === 0) return;
  if (!stream.write(chunk)) await once(stream, 'drain');
}

function outputTarget(path, mode) {
  if (path === '-') {
    return { stream: process.stdout, tempPath: null, finalPath: null };
  }
  if (existsSync(path)) throw new Error('output_exists');
  const tempPath = `${path}.part-${process.pid}-${randomBytes(6).toString('hex')}`;
  const stream = createWriteStream(tempPath, { flags: 'wx', mode });
  return { stream, tempPath, finalPath: path };
}

async function finishOutput(target) {
  if (target.stream === process.stdout) return;
  target.stream.end();
  await once(target.stream, 'close');
  chmodSync(target.tempPath, 0o640);
  if (existsSync(target.finalPath)) throw new Error('output_exists');
  renameSync(target.tempPath, target.finalPath);
}

async function abortOutput(target) {
  if (target.stream !== process.stdout && !target.stream.destroyed) target.stream.destroy();
  if (target.tempPath && existsSync(target.tempPath)) {
    try {
      unlinkSync(target.tempPath);
    } catch {
      // The caller receives the original failure; cleanup never masks it.
    }
  }
}

export async function encryptStream({ key, input = '-', output = '-' }) {
  const target = outputTarget(output, 0o640);
  const header = buildHeader();
  const iv = randomBytes(FORMAT.ivLength);
  const cipher = createCipheriv(FORMAT.algorithm, key, iv, { authTagLength: FORMAT.tagLength });
  cipher.setAAD(header);
  try {
    await writeChunk(target.stream, header);
    await writeChunk(target.stream, iv);
    for await (const chunk of inputStream(input)) {
      await writeChunk(target.stream, cipher.update(chunk));
    }
    await writeChunk(target.stream, cipher.final());
    await writeChunk(target.stream, cipher.getAuthTag());
    await finishOutput(target);
  } catch (error) {
    await abortOutput(target);
    throw error;
  }
}

export async function decryptStream({ key, input = '-', output = '-' }) {
  const target = outputTarget(output, 0o640);
  let prefix = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let decipher = null;
  try {
    for await (const sourceChunk of inputStream(input)) {
      let chunk = sourceChunk;
      if (!decipher) {
        prefix = Buffer.concat([prefix, chunk]);
        const prefixLength = FORMAT.headerLength + FORMAT.ivLength;
        if (prefix.length < prefixLength) continue;
        const header = prefix.subarray(0, FORMAT.headerLength);
        parseHeader(header);
        const iv = prefix.subarray(FORMAT.headerLength, prefixLength);
        decipher = createDecipheriv(FORMAT.algorithm, key, iv, { authTagLength: FORMAT.tagLength });
        decipher.setAAD(header);
        chunk = prefix.subarray(prefixLength);
        prefix = Buffer.alloc(0);
      }
      const combined = Buffer.concat([tail, chunk]);
      if (combined.length <= FORMAT.tagLength) {
        tail = combined;
        continue;
      }
      const ciphertextLength = combined.length - FORMAT.tagLength;
      await writeChunk(target.stream, decipher.update(combined.subarray(0, ciphertextLength)));
      tail = combined.subarray(ciphertextLength);
    }
    if (!decipher || tail.length !== FORMAT.tagLength) throw new Error('truncated_file');
    decipher.setAuthTag(tail);
    await writeChunk(target.stream, decipher.final());
    await finishOutput(target);
  } catch (error) {
    await abortOutput(target);
    throw error;
  }
}

export function generateKeyFile(path) {
  if (!path) throw new Error('key_file_required');
  if (existsSync(path)) throw new Error('key_file_exists');
  const key = randomBytes(32);
  const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(fd, `${key.toString('base64')}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return keyFingerprint(key);
}

export function inspectBufferPrefix(prefix) {
  if (prefix.length < FORMAT.headerLength + FORMAT.ivLength) throw new Error('truncated_file');
  return parseHeader(prefix.subarray(0, FORMAT.headerLength));
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name.startsWith('--') || index + 1 >= args.length) throw new Error('invalid_arguments');
    if (Object.hasOwn(options, name)) throw new Error('duplicate_argument');
    options[name] = args[index + 1];
    index += 1;
  }
  return options;
}

async function selfTest(key) {
  const samples = [
    Buffer.alloc(0),
    Buffer.from('salary-backup-self-test\n', 'utf8'),
    randomBytes(256 * 1024 + 37),
  ];
  for (const sample of samples) {
    const encrypted = encryptBuffer(sample, key);
    if (!decryptBuffer(encrypted, key).equals(sample)) throw new Error('self_test_round_trip_failed');
  }
  const tampered = encryptBuffer(samples[1], key);
  tampered[FORMAT.headerLength + FORMAT.ivLength] ^= 1;
  let rejected = false;
  try {
    decryptBuffer(tampered, key);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('self_test_tamper_failed');
}

function safeErrorCode(error) {
  const known = new Set([
    'invalid_key_encoding',
    'invalid_key_length',
    'key_file_required',
    'invalid_key_file',
    'invalid_header_length',
    'invalid_magic',
    'unsupported_version',
    'unsupported_algorithm',
    'invalid_crypto_parameters',
    'invalid_reserved_header',
    'invalid_iv_length',
    'truncated_file',
    'output_exists',
    'key_file_exists',
    'invalid_arguments',
    'duplicate_argument',
    'self_test_round_trip_failed',
    'self_test_tamper_failed',
  ]);
  return error instanceof Error && known.has(error.message) ? error.message : 'operation_failed';
}

async function main() {
  const [command, ...rawOptions] = process.argv.slice(2);
  const options = parseArguments(rawOptions);
  if (command === 'generate-key') {
    const fingerprint = generateKeyFile(options['--key-file']);
    console.log('BACKUP_KEY_GENERATION_STATUS=generated');
    console.log(`BACKUP_KEY_FINGERPRINT=${fingerprint}`);
    return;
  }
  if (command === 'version') {
    if (rawOptions.length !== 0) throw new Error('invalid_arguments');
    console.log(`BACKUP_CRYPTO_FORMAT_VERSION=${FORMAT.version}`);
    console.log(`BACKUP_CRYPTO_ALGORITHM=${FORMAT.algorithm}`);
    return;
  }
  const key = readKeyFile(options['--key-file']);
  if (command === 'encrypt' || command === 'decrypt') {
    const input = options['--input'] ?? '-';
    const output = options['--output'] ?? '-';
    if (!options['--key-file'] || Object.keys(options).some((name) => !['--key-file', '--input', '--output'].includes(name))) {
      throw new Error('invalid_arguments');
    }
    if (command === 'encrypt') {
      await encryptStream({ key, input, output });
    } else {
      await decryptStream({ key, input, output });
    }
    return;
  }
  if (command === 'inspect') {
    if (!options['--key-file'] || !options['--input'] || Object.keys(options).some((name) => !['--key-file', '--input'].includes(name))) {
      throw new Error('invalid_arguments');
    }
    const stream = createReadStream(options['--input'], { start: 0, end: FORMAT.headerLength + FORMAT.ivLength - 1 });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const details = inspectBufferPrefix(Buffer.concat(chunks));
    console.log(`BACKUP_CRYPTO_FORMAT_VERSION=${details.version}`);
    console.log(`BACKUP_CRYPTO_ALGORITHM=${details.algorithm}`);
    console.log(`BACKUP_CRYPTO_IV_BYTES=${details.ivLength}`);
    console.log(`BACKUP_CRYPTO_TAG_BYTES=${details.tagLength}`);
    return;
  }
  if (command === 'self-test') {
    if (!options['--key-file'] || Object.keys(options).some((name) => name !== '--key-file')) {
      throw new Error('invalid_arguments');
    }
    await selfTest(key);
    console.log('BACKUP_CRYPTO_SELF_TEST=pass');
    console.log(`BACKUP_KEY_FINGERPRINT=${keyFingerprint(key)}`);
    return;
  }
  throw new Error('invalid_arguments');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`BACKUP_CRYPTO_ERROR=${safeErrorCode(error)}`);
    process.exitCode = 1;
  });
}
