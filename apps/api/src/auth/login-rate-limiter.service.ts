import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

@Injectable()
export class LoginRateLimiterService {
  private readonly attempts = new Map<string, number[]>();

  check(ipAddress: string): void {
    const now = Date.now();
    const recent = (this.attempts.get(ipAddress) ?? []).filter((timestamp) => timestamp > now - WINDOW_MS);
    if (recent.length >= MAX_ATTEMPTS) {
      this.attempts.set(ipAddress, recent);
      throw new HttpException('Too many login attempts.', HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    this.attempts.set(ipAddress, recent);
  }
}
