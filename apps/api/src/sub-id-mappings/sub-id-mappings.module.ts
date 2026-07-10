import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MonthLockModule } from '../month-lock/month-lock.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SubIdMappingsController } from './sub-id-mappings.controller';
import { SubIdMappingsService } from './sub-id-mappings.service';

@Module({
  imports: [PrismaModule, MonthLockModule, AuditModule],
  controllers: [SubIdMappingsController],
  providers: [SubIdMappingsService],
  exports: [SubIdMappingsService],
})
export class SubIdMappingsModule {}
