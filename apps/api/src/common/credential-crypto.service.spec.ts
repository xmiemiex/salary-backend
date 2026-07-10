import { ERROR_CODES } from '@salary/shared';
import { CredentialCryptoService, validateEncryptionKeyConfiguration } from './credential-crypto.service';

describe('CredentialCryptoService', () => {
  const originalKey = process.env.API_CREDENTIAL_ENCRYPTION_KEY;
  const plaintextSecret = 'plain-secret-token-123456';
  let service: CredentialCryptoService;

  beforeEach(() => {
    process.env.API_CREDENTIAL_ENCRYPTION_KEY = 'unit-test-key-32-bytes-long!!!!!';
    service = new CredentialCryptoService();
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.API_CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.API_CREDENTIAL_ENCRYPTION_KEY = originalKey;
    }
  });

  it('decryptJson restores payload encrypted by encryptJson', () => {
    const payload = { apiKey: 'abcd12345678wxyz', secret: plaintextSecret, nested: { retries: 2 } };

    const encryptedPayload = service.encryptJson(payload);

    expect(encryptedPayload).not.toContain(plaintextSecret);
    expect(service.decryptJson(encryptedPayload)).toEqual(payload);
  });

  it('supports base64-encoded 32-byte keys', () => {
    process.env.API_CREDENTIAL_ENCRYPTION_KEY = Buffer.from('abcdefghijklmnopabcdefghijklmnop', 'utf8').toString('base64');
    const payload = { clientId: 'client-123456789', secret: plaintextSecret };

    const encryptedPayload = service.encryptJson(payload);

    expect(service.decryptJson(encryptedPayload)).toEqual(payload);
  });

  it('rejects an obvious placeholder during startup validation', () => {
    process.env.API_CREDENTIAL_ENCRYPTION_KEY = '<GENERATE_A_RANDOM_32_BYTE_BASE64_KEY>';
    expect(() => validateEncryptionKeyConfiguration()).toThrow('API_CREDENTIAL_ENCRYPTION_KEY must not be a placeholder.');
  });

  it('rejects the legacy fixed example key during startup validation', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.API_CREDENTIAL_ENCRYPTION_KEY = '12345678901234567890123456789012';
    try {
      expect(() => validateEncryptionKeyConfiguration()).toThrow('API_CREDENTIAL_ENCRYPTION_KEY must not be a placeholder.');
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('rejects a key with the wrong decoded length during startup validation', () => {
    process.env.API_CREDENTIAL_ENCRYPTION_KEY = Buffer.from('too-short').toString('base64');
    expect(() => validateEncryptionKeyConfiguration()).toThrow(
      'API_CREDENTIAL_ENCRYPTION_KEY must be a 32-byte string or base64-encoded 32-byte key.',
    );
  });

  it('throws a clear error when decryptJson is called without API_CREDENTIAL_ENCRYPTION_KEY', () => {
    delete process.env.API_CREDENTIAL_ENCRYPTION_KEY;

    expect(() => service.decryptJson('{}')).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'API_CREDENTIAL_ENCRYPTION_KEY is required for API credential encryption.',
      }),
    );
  });

  it('fails decryptJson with wrong key without exposing ciphertext or plaintext', () => {
    const encryptedPayload = service.encryptJson({ secret: plaintextSecret });
    process.env.API_CREDENTIAL_ENCRYPTION_KEY = 'abcdefghijklmnopabcdefghijklmnop';

    expect(() => service.decryptJson(encryptedPayload)).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'API credential payload could not be decrypted.',
      }),
    );

    try {
      service.decryptJson(encryptedPayload);
    } catch (error) {
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain(plaintextSecret);
      expect(serialized).not.toContain(JSON.parse(encryptedPayload).ciphertext);
    }
  });

  it('fails decryptJson with damaged ciphertext without exposing ciphertext or plaintext', () => {
    const encryptedPayload = service.encryptJson({ secret: plaintextSecret });
    const damaged = JSON.stringify({ ...JSON.parse(encryptedPayload), ciphertext: 'AAAA' });

    expect(() => service.decryptJson(damaged)).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'API credential payload could not be decrypted.',
      }),
    );

    try {
      service.decryptJson(damaged);
    } catch (error) {
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain(plaintextSecret);
      expect(serialized).not.toContain('AAAA');
    }
  });
});
