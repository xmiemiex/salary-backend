import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AffiliateAccountsController } from './affiliate-accounts.controller';
import { AffiliateAccountsService } from './affiliate-accounts.service';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [AffiliateAccountsController],
  providers: [AffiliateAccountsService],
  exports: [AffiliateAccountsService],
})
export class AffiliateAccountsModule {}
