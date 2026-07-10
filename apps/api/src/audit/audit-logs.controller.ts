import { Controller, Get, Param, Query, StreamableFile } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { AuditLogsExportQuery, AuditLogsExportService } from './audit-logs-export.service';
import { AuditLogsQuery, AuditLogsQueryService } from './audit-logs-query.service';

@Controller('audit-logs')
@RequirePermissions('audit_log.view')
export class AuditLogsController {
  constructor(
    private readonly auditLogs: AuditLogsQueryService,
    private readonly auditExport: AuditLogsExportService,
  ) {}

  @Get()
  list(@Query() query: AuditLogsQuery) {
    return this.auditLogs.list(query);
  }

  @Get(['export', 'export.csv'])
  @RequirePermissions('audit_log.view', 'audit_log.export')
  async export(@Query() query: AuditLogsExportQuery, @CurrentActor() actor: Actor) {
    const result = await this.auditExport.export(query, actor);
    return new StreamableFile(Buffer.from(result.csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${result.filename}"`,
    });
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.auditLogs.getById(id);
  }
}
