import { Module } from '@nestjs/common';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogsExportService } from './audit-logs-export.service';
import { AuditLogsQueryService } from './audit-logs-query.service';
import { AuditService } from './audit.service';

@Module({
  controllers: [AuditLogsController],
  providers: [AuditService, AuditLogsQueryService, AuditLogsExportService],
  exports: [AuditService],
})
export class AuditModule {}
