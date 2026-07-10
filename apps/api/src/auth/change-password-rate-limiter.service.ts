import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

const WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 5;

@Injectable()
export class ChangePasswordRateLimiterService {
  private readonly failures = new Map<string, number[]>();

  check(adminUserId: string, ipAddress: string): void {
    const key = this.key(adminUserId, ipAddress);
    const recent = this.recent(key);
    if (recent.length >= MAX_FAILURES) {
      throw new HttpException('Too many password verification attempts. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  recordFailure(adminUserId: string, ipAddress: string): void {
    const key = this.key(adminUserId, ipAddress);
    const recent = this.recent(key);
    recent.push(Date.now());
    this.failures.set(key, recent);
  }

  reset(adminUserId: string, ipAddress: string): void {
    this.failures.delete(this.key(adminUserId, ipAddress));
  }

  private recent(key: string): number[] {
    const cutoff = Date.now() - WINDOW_MS;
    const recent = (this.failures.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length) this.failures.set(key, recent);
    else this.failures.delete(key);
    return recent;
  }

  private key(adminUserId: string, ipAddress: string): string {
    return `${adminUserId}:${ipAddress}`;
  }
}
