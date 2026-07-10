import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { PermissionsGuard } from './permissions.guard';
import { AuthConfigService } from './auth-config.service';
import { AuthService } from './auth.service';
import { LoginRateLimiterService } from './login-rate-limiter.service';
import { PasswordHashService } from './password-hash.service';
import { ChangePasswordRateLimiterService } from './change-password-rate-limiter.service';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [AuthController],
  providers: [AuthGuard, PermissionsGuard, AuthConfigService, AuthService, LoginRateLimiterService, ChangePasswordRateLimiterService, PasswordHashService],
  exports: [AuthGuard, PermissionsGuard, PasswordHashService],
})
export class AuthModule {}
