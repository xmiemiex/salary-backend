import { HttpException } from '@nestjs/common';
import { LoginRateLimiterService } from './login-rate-limiter.service';

describe('LoginRateLimiterService', () => {
  it('returns 429 after five attempts from one IP', () => {
    const limiter = new LoginRateLimiterService();
    for (let index = 0; index < 5; index += 1) expect(() => limiter.check('127.0.0.1')).not.toThrow();
    expect(() => limiter.check('127.0.0.1')).toThrow(HttpException);
    try { limiter.check('127.0.0.1'); } catch (error) { expect((error as HttpException).getStatus()).toBe(429); }
    expect(() => limiter.check('127.0.0.2')).not.toThrow();
  });
});
