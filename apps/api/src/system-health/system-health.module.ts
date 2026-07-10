import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BackupRecoveryModule } from '../backup-recovery/backup-recovery.module';
import { SystemHealthController } from './system-health.controller';
import { SystemHealthService } from './system-health.service';

@Module({
  imports: [PrismaModule, BackupRecoveryModule],
  controllers: [SystemHealthController],
  providers: [SystemHealthService],
  exports: [SystemHealthService],
})
export class SystemHealthModule {}
