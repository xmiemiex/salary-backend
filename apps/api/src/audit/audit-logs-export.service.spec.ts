import { AuditResult } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { Actor } from '../auth/auth.types';
import { AuditLogsExportService } from './audit-logs-export.service';
import { AuditLogsQueryService } from './audit-logs-query.service';

const ACTOR: Actor = {
  userId: '22222222-2222-4222-8222-222222222222',
  roleCode: 'auditor',
  permissions: ['audit_log.view', 'audit_log.export'],
  ipAddress: '127.0.0.1',
};

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    createdAt: new Date('2026-06-20T12:34:56.000Z'),
    result: AuditResult.success,
    action: 'settlement.generate',
    objectType: 'monthly_settlement',
    objectId: null,
    settlementMonth: new Date('2026-06-01T00:00:00.000Z'),
    actorUserId: ACTOR.userId,
    actorRole: ACTOR.roleCode,
    failureReason: null,
    errorMessage: null,
    changedFields: ['status', 'note'],
    ipAddress: ACTOR.ipAddress,
    afterData: null,
    ...overrides,
  };
}

describe('AuditLogsExportService', () => {
  function harness(records: ReturnType<typeof record>[] = []) {
    const auditLog = {
      findMany: jest.fn().mockResolvedValue(records),
      count: jest.fn().mockResolvedValue(records.length),
    };
    const prisma = {
      auditLog,
      $transaction: jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
    };
    const audit = { success: jest.fn().mockResolvedValue({}), failure: jest.fn().mockResolvedValue({}) };
    return {
      service: new AuditLogsExportService(prisma as never, audit as never),
      listService: new AuditLogsQueryService(prisma as never),
      auditLog,
      audit,
    };
  }

  it('uses the same parsed filters as list and stable bounded ordering', async () => {
    const { service, listService, auditLog } = harness();
    const filters = {
      settlementMonth: '2026-06', action: ' settlement.generate ', objectType: 'salary',
      objectId: 'obj-1', actorUserId: ACTOR.userId, actorRole: ' auditor ', result: 'success',
      failureReason: 'none', createdFrom: '2026-06-01T00:00:00Z', createdTo: '2026-06-30T00:00:00Z',
    };
    await listService.list(filters);
    await service.export(filters, ACTOR);

    const listWhere = auditLog.findMany.mock.calls[0][0].where;
    const exportCall = auditLog.findMany.mock.calls[1][0];
    expect(exportCall.where).toEqual(listWhere);
    expect(exportCall.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(exportCall.take).toBe(10_001);
    expect(exportCall).not.toHaveProperty('skip');
    expect(exportCall.select).not.toHaveProperty('beforeData');
    expect(exportCall.select).toHaveProperty('requestPayload');
    expect(exportCall.select).toHaveProperty('userAgent');
  });

  it('defaults missing range, rejects partial, overlong ranges and pagination', async () => {
    const { service, auditLog, audit } = harness();
    await expect(service.export({}, ACTOR)).resolves.toMatchObject({ exportedCount: 0 });
    await expect(service.export({ createdFrom: '2026-01-01T00:00:00Z' }, ACTOR)).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    await expect(service.export({
      createdFrom: '2025-01-01T00:00:00Z', createdTo: '2026-01-03T00:00:00Z',
    }, ACTOR)).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    await expect(service.export({ settlementMonth: '2026-06', page: '1' }, ACTOR)).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    expect(auditLog.findMany).toHaveBeenCalledTimes(1);
    expect(audit.failure).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(audit.failure.mock.calls)).not.toContain('2025-01-01T00:00:00Z');
  });

  it('rejects more than 10000 rows and requests only 10001', async () => {
    const rows = Array.from({ length: 10_001 }, (_, index) => record({ id: String(index) }));
    const { service, auditLog } = harness(rows);
    await expect(service.export({ settlementMonth: '2026-06' }, ACTOR)).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: expect.stringContaining('narrow'),
    });
    expect(auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10_001 }));
  });

  it('writes BOM-safe CSV with escaping, formula protection, whitelist preflight, and no raw JSON secrets', async () => {
    const { service, audit } = harness([record({
      action: 'a,b"c\nline',
      objectId: '  =1+1',
      actorRole: '+SUM(A1:A2)',
      failureReason: '-cmd',
      errorMessage: '@evil',
      afterData: {
        preflight: {
          severity: 'warning',
          canGenerate: false,
          acknowledgedWarningCodes: ['WARN_A', 'WARN_B'],
          checks: [{ code: 'CHECK_A', message: 'token=secret' }, { code: 'CHECK_B', apiKey: 'hidden' }],
          token: 'do-not-export',
        },
        details: { apiKey: 'key', token: 'token', secret: 'secret' },
      },
    })]);

    const result = await service.export({ settlementMonth: '2026-06' }, ACTOR);
    expect(result.csv.charCodeAt(0)).toBe(0xFEFF);
    expect(result.csv).toContain('"a,b""c\nline"');
    expect(result.csv).toContain("\"'  =1+1\"");
    expect(result.csv).toContain("\"'+SUM(A1:A2)\"");
    expect(result.csv).toContain("'-cmd");
    expect(result.csv).toContain('@evil');
    expect(result.csv).toContain('"system","monthly_settlement"');
    expect(result.csv).not.toContain('do-not-export');
    expect(result.csv).not.toContain('token=secret');
    expect(result.csv).not.toContain('apiKey');
    expect(result.csv).not.toContain('beforeData');
    expect(result.csv).not.toContain('afterData');
    expect(result.csv).not.toContain('requestPayload');
    expect(audit.success).toHaveBeenCalledWith(expect.objectContaining({
      action: 'audit_logs.exported',
      objectType: 'audit_logs',
      requestPayload: expect.objectContaining({ settlementMonth: '2026-06-01' }),
      afterData: { exportedCount: 1 },
    }));
    expect(result.csv).not.toContain('audit_logs.exported');
    expect(result.filename).toMatch(/^audit-logs-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('leaves malformed preflight fields empty instead of failing', async () => {
    const { service } = harness([record({ afterData: { preflight: { severity: 1, canGenerate: 'yes', checks: 'bad' } } })]);
    const result = await service.export({ settlementMonth: '2026-06' }, ACTOR);
    expect(result.exportedCount).toBe(1);
    expect(result.csv.split('\r\n')[1]).toMatch(/"2026-06-01T00:00:00.000Z","",""$/);
  });
});
