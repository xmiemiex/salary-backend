import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { CurrentActor } from './current-actor.decorator';
import { Actor } from './auth.types';
import { ChangePasswordInput, RequestWithActor, LoginInput } from './auth.types';
import { Public } from './public.decorator';
import { AuthService } from './auth.service';
import { LoginRateLimiterService } from './login-rate-limiter.service';
import { ChangePasswordRateLimiterService } from './change-password-rate-limiter.service';

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly limiter: LoginRateLimiterService,
    private readonly passwordLimiter: ChangePasswordRateLimiterService,
  ) {}

  @Public()
  @Post('auth/login')
  login(@Body() input: LoginInput, @Req() request: RequestWithActor) {
    const ipAddress = request.ip || 'unknown';
    this.limiter.check(ipAddress);
    return this.auth.login(input, { ipAddress, userAgent: this.firstHeader(request.headers['user-agent']) });
  }

  @Post('auth/logout')
  async logout(@CurrentActor() actor: Actor, @Req() request: RequestWithActor) {
    await this.auth.logout(request.authSessionId!, actor);
    return { success: true };
  }

  @Get('auth/security')
  security(@CurrentActor() actor: Actor) {
    return this.auth.getSecurity(actor.userId);
  }

  @Post('auth/change-password')
  async changePassword(@Body() input: ChangePasswordInput, @CurrentActor() actor: Actor, @Req() request: RequestWithActor) {
    const ipAddress = request.ip || 'unknown';
    this.passwordLimiter.check(actor.userId, ipAddress);
    try {
      const result = await this.auth.changePassword(input, actor);
      this.passwordLimiter.reset(actor.userId, ipAddress);
      return result;
    } catch (error) {
      if (this.auth.isCurrentPasswordError(error)) this.passwordLimiter.recordFailure(actor.userId, ipAddress);
      throw error;
    }
  }

  @Get('auth/sessions')
  sessions(@CurrentActor() actor: Actor, @Req() request: RequestWithActor) {
    return this.auth.listSessions(actor.userId, request.authSessionId!);
  }

  @Post('auth/sessions/:id/revoke')
  revokeSession(@Param('id') id: string, @CurrentActor() actor: Actor, @Req() request: RequestWithActor) {
    return this.auth.revokeSession(id, request.authSessionId!, actor);
  }

  @Post('auth/logout-all')
  logoutAll(@CurrentActor() actor: Actor) {
    return this.auth.logoutAll(actor);
  }

  @Get('me')
  me(@CurrentActor() actor: Actor) {
    return { actor };
  }

  private firstHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}
