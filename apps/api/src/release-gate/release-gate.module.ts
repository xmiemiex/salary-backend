import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BackupRecoveryModule } from '../backup-recovery/backup-recovery.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemHealthModule } from '../system-health/system-health.module';
import { ReleaseGateController } from './release-gate.controller';
import { ReleaseGateService } from './release-gate.service';

@Module({
  imports: [PrismaModule, AuditModule, BackupRecoveryModule, SystemHealthModule],
  controllers: [ReleaseGateController],
  providers: [ReleaseGateService],
})
export class ReleaseGateModule {}
