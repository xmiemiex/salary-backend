import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemHealthModule } from '../system-health/system-health.module';
import { BackupRecoveryModule } from '../backup-recovery/backup-recovery.module';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [PrismaModule, AuditModule, SystemHealthModule, BackupRecoveryModule],
  controllers: [AlertsController, NotificationsController],
  providers: [AlertsService, NotificationsService],
})
export class AlertsModule {}
