import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MonthLockModule } from '../month-lock/month-lock.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CardBindingsController } from './card-bindings.controller';
import { CardBindingsService } from './card-bindings.service';

@Module({
  imports: [PrismaModule, MonthLockModule, AuditModule],
  controllers: [CardBindingsController],
  providers: [CardBindingsService],
  exports: [CardBindingsService],
})
export class CardBindingsModule {}
