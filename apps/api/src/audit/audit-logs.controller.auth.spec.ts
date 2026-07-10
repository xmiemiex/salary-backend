import { CanActivate, ExecutionContext, INestApplication, Injectable } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuditService } from './audit.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { AppExceptionFilter } from '../common/app-exception.filter';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogsQueryService } from './audit-logs-query.service';
import { AuditLogsExportService } from './audit-logs-export.service';

const request: any = require('supertest');
const ID = '11111111-1111-4111-8111-111111111111';

@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    req.actor = {
      userId: ID,
      roleCode: 'finance',
      permissions: String(req.headers['x-test-permissions'] ?? '').split(',').filter(Boolean),
    };
    return true;
  }
}

describe('AuditLogsController auth integration', () => {
  let app: INestApplication;
  const queryService = {
    list: jest.fn().mockResolvedValue({ total: 0, page: 1, pageSize: 20, items: [] }),
    getById: jest.fn().mockResolvedValue({ id: ID }),
  };
  const exportService = {
    export: jest.fn().mockResolvedValue({ csv: '\uFEFF"id"', filename: 'audit-logs-2026-06.csv', exportedCount: 0 }),
  };
  const auditService = { failure: jest.fn().mockResolvedValue({}) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuditLogsController],
      providers: [
        { provide: AuditLogsQueryService, useValue: queryService },
        { provide: AuditLogsExportService, useValue: exportService },
        { provide: AuditService, useValue: auditService },
        { provide: APP_FILTER, useClass: AppExceptionFilter },
        { provide: APP_GUARD, useClass: TestAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app.close());

  it.each(['/audit-logs', `/audit-logs/${ID}`])('requires audit_log.view for %s', async (path) => {
    await request(app.getHttpServer()).get(path).set('x-test-permissions', 'salary.view_all,settlement.generate').expect(403);
    expect(queryService.list).not.toHaveBeenCalled();
    expect(queryService.getById).not.toHaveBeenCalled();
  });

  it('allows both endpoints with audit_log.view', async () => {
    await request(app.getHttpServer()).get('/audit-logs').set('x-test-permissions', 'audit_log.view').expect(200);
    await request(app.getHttpServer()).get(`/audit-logs/${ID}`).set('x-test-permissions', 'audit_log.view').expect(200);
    expect(queryService.list).toHaveBeenCalled();
    expect(queryService.getById).toHaveBeenCalledWith(ID);
    expect(auditService.failure).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'audit_log.view',
    'audit_log.export',
    'salary.view_all,salary.export',
    'audit_log.view,salary.export',
  ])('export rejects permissions that do not contain both audit permissions: %s', async (permissions) => {
    await request(app.getHttpServer())
      .get('/audit-logs/export?settlementMonth=2026-06')
      .set('x-test-permissions', permissions)
      .expect(403);
    expect(exportService.export).not.toHaveBeenCalled();
  });

  it('exports only with audit_log.view and audit_log.export and sets download headers', async () => {
    const response = await request(app.getHttpServer())
      .get('/audit-logs/export?settlementMonth=2026-06')
      .set('x-test-permissions', 'audit_log.view,audit_log.export,salary.export')
      .expect(200);

    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe('attachment; filename="audit-logs-2026-06.csv"');
    expect(exportService.export).toHaveBeenCalledWith(
      { settlementMonth: '2026-06' },
      expect.objectContaining({ userId: ID }),
    );
    expect(queryService.getById).not.toHaveBeenCalledWith('export');
  });
});
