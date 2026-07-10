import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ERROR_CODES } from '@salary/shared';
import { AppError } from './app-error';

const KEY_ENV = 'API_CREDENTIAL_ENCRYPTION_KEY';
const ALG = 'aes-256-gcm';

type EncryptedCredentialPayload = {
  alg: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

@Injectable()
export class CredentialCryptoService {
  encryptJson(value: unknown): string {
    const key = encryptionKeyFromEnv();
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALG, key, iv);
    const plaintext = JSON.stringify(value);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return JSON.stringify({
      alg: ALG,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    });
  }

  decryptJson(encryptedPayload: string): unknown {
    const key = encryptionKeyFromEnv();
    const payload = parseEncryptedPayload(encryptedPayload);

    try {
      const decipher = createDecipheriv(ALG, key, Buffer.from(payload.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return JSON.parse(plaintext);
    } catch {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'API credential payload could not be decrypted.');
    }
  }
}

function parseEncryptedPayload(encryptedPayload: string): EncryptedCredentialPayload {
  try {
    const parsed = JSON.parse(encryptedPayload) as Partial<EncryptedCredentialPayload>;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      parsed.alg !== ALG ||
      !isBase64String(parsed.iv) ||
      !isBase64String(parsed.tag) ||
      !isBase64String(parsed.ciphertext)
    ) {
      throw new Error('Invalid encrypted credential payload.');
    }
    return {
      alg: parsed.alg,
      iv: parsed.iv,
      tag: parsed.tag,
      ciphertext: parsed.ciphertext,
    };
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'API credential payload format is invalid.');
  }
}

function isBase64String(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.from(value, 'base64').toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '');
}

const PLACEHOLDER_MARKERS = ['<', '>', 'replace', 'change_me', 'changeme', 'example', 'generate_a_random'];
const KNOWN_INSECURE_KEYS = new Set(['12345678901234567890123456789012']);

export function validateEncryptionKeyConfiguration(): void {
  encryptionKeyFromEnv();
}

function encryptionKeyFromEnv(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${KEY_ENV} is required for API credential encryption.`);
  }

  const normalized = raw.trim().toLowerCase();
  const isKnownProductionKey = process.env.NODE_ENV === 'production' && KNOWN_INSECURE_KEYS.has(raw);
  if (isKnownProductionKey || PLACEHOLDER_MARKERS.some((marker) => normalized.includes(marker))) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${KEY_ENV} must not be a placeholder.`);
  }

  if (Buffer.byteLength(raw, 'utf8') === 32) {
    return Buffer.from(raw, 'utf8');
  }

  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) {
    return decoded;
  }

  throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${KEY_ENV} must be a 32-byte string or base64-encoded 32-byte key.`);
}
