import { HttpException } from '@nestjs/common';
import { ChangePasswordRateLimiterService } from './change-password-rate-limiter.service';

describe('ChangePasswordRateLimiterService', () => {
  it('blocks after five failures and never needs a password as key material', () => {
    const limiter = new ChangePasswordRateLimiterService();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.check('user-1', '127.0.0.1');
      limiter.recordFailure('user-1', '127.0.0.1');
    }
    expect(() => limiter.check('user-1', '127.0.0.1')).toThrow(HttpException);
    expect(() => limiter.check('user-2', '127.0.0.1')).not.toThrow();
    limiter.reset('user-1', '127.0.0.1');
    expect(() => limiter.check('user-1', '127.0.0.1')).not.toThrow();
  });
});
