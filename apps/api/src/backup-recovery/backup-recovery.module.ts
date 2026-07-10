import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BackupHealthService } from './backup-health.service';
import { BackupRecoveryController } from './backup-recovery.controller';
import { BackupRecoveryService } from './backup-recovery.service';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [BackupRecoveryController],
  providers: [BackupRecoveryService, BackupHealthService],
  exports: [BackupHealthService],
})
export class BackupRecoveryModule {}
