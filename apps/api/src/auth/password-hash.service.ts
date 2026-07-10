import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

function derive(password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, key) => error ? reject(error) : resolve(key));
  });
}
const VERSION = 'scrypt-v1';
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 256;

@Injectable()
export class PasswordHashService {
  validate(password: string): void {
    if (password.length < 12 || password.length > MAX_PASSWORD_LENGTH || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      throw new Error(`Password must be 12-${MAX_PASSWORD_LENGTH} characters and contain at least one letter and one digit.`);
    }
  }

  async hash(password: string): Promise<string> {
    this.validate(password);
    const salt = randomBytes(16);
    const derived = await derive(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
    return [VERSION, `N=${N},r=${R},p=${P}`, salt.toString('base64url'), derived.toString('base64url')].join('$');
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    if (password.length > MAX_PASSWORD_LENGTH) return false;
    const [version, parameterText, saltText, hashText, extra] = encoded.split('$');
    if (version !== VERSION || extra !== undefined || !saltText || !hashText) return false;
    const match = parameterText?.match(/^N=(\d+),r=(\d+),p=(\d+)$/);
    if (!match) return false;
    const [n, r, p] = match.slice(1).map(Number);
    if (n !== N || r !== R || p !== P) return false;
    try {
      const expected = Buffer.from(hashText, 'base64url');
      const salt = Buffer.from(saltText, 'base64url');
      if (salt.length !== 16) return false;
      if (expected.length !== KEY_LENGTH) return false;
      const actual = await derive(password, salt, expected.length, {
        N: n, r, p, maxmem: 64 * 1024 * 1024,
      });
      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
}
