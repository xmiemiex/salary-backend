import { AuditResult, Prisma } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditLogsQueryService } from './audit-logs-query.service';

const ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';

describe('AuditLogsQueryService', () => {
  function harness() {
    const auditLog = {
      count: jest.fn().mockResolvedValue(2),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
    };
    const prisma = {
      auditLog,
      $transaction: jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
    };
    return { service: new AuditLogsQueryService(prisma as never), auditLog, prisma };
  }

  it('paginates with stable ordering and selects no large JSON fields', async () => {
    const { service, auditLog } = harness();
    await expect(service.list({ page: '2', pageSize: '10' })).resolves.toEqual({
      total: 2,
      page: 2,
      pageSize: 10,
      items: [],
    });

    expect(auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 10,
      take: 10,
      select: expect.objectContaining({ id: true, changedFields: true }),
    }));
    const select = auditLog.findMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty('beforeData');
    expect(select).not.toHaveProperty('afterData');
    expect(select).toHaveProperty('requestPayload');
    expect(select).toHaveProperty('userAgent');
  });

  it('filters by settlementMonth, action, result, and actor fields', async () => {
    const { service, auditLog } = harness();
    await service.list({
      settlementMonth: '2026-06-01',
      action: 'settlement.generate',
      result: 'success',
      actorUserId: ACTOR_ID,
      actorRole: 'finance',
    });

    const where = auditLog.count.mock.calls[0][0].where;
    expect(where.AND[1]).toMatchObject({
      settlementMonth: new Date('2026-06-01T00:00:00.000Z'),
      action: 'settlement.generate',
      result: AuditResult.success,
      actorUserId: ACTOR_ID,
      actorRole: 'finance',
    });
  });

  it('validates created range, ISO timestamps, and pageSize maximum', async () => {
    const { service } = harness();
    await expect(service.list({ createdFrom: '2026-06-02' })).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    await expect(service.list({
      createdFrom: '2026-06-02T00:00:00Z',
      createdTo: '2026-06-01T00:00:00Z',
    })).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    await expect(service.list({ pageSize: '101' })).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    await expect(service.list({ action: ['duplicate'] })).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    await expect(service.list({ createdFrom: '2026-02-30T00:00:00Z' })).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
  });

  it('recursively redacts sensitive object and array keys without mutating the source', async () => {
    const { service, auditLog } = harness();
    const afterData = {
      Password: 'plain',
      nested: { API_KEY: 'key', normal: 'safe' },
      entries: [{ clientSecret: 'secret', Card_Number: '4111', message: 'keep me' }],
    } satisfies Prisma.JsonObject;
    auditLog.findUnique.mockResolvedValue({ id: ID, beforeData: null, afterData, requestPayload: { TOKEN: 'token' } });

    const result = await service.getById(ID);
    expect((result.sanitizedRaw as any).afterData).toEqual({
      redactedField1: '[REDACTED]',
      nested: { redactedField1: '[REDACTED]', normal: 'safe' },
      entries: [{ redactedField1: '[REDACTED]', redactedField2: '[REDACTED]', message: 'keep me' }],
    });
    expect((result.sanitizedRaw as any).requestPayload).toEqual({ redactedField1: '[REDACTED]' });
    expect(afterData.Password).toBe('plain');
  });

  it('returns the complete safe preflight snapshot', async () => {
    const { service, auditLog } = harness();
    const preflight = {
      severity: 'warning',
      checks: [{ code: 'MISSING_RATE', message: 'Exchange rate is missing', severity: 'warning' }],
      summary: { warningCount: 1, blockingCount: 0 },
      acknowledgedWarningCodes: ['MISSING_RATE'],
    };
    auditLog.findUnique.mockResolvedValue({ id: ID, beforeData: null, afterData: { preflight }, requestPayload: null });

    const result = await service.getById(ID);
    expect((result.sanitizedRaw as any).afterData).toEqual({ preflight });
  });

  it('returns NOT_FOUND and never creates an audit log for queries', async () => {
    const { service, auditLog } = harness();
    auditLog.findUnique.mockResolvedValue(null);
    await expect(service.getById(ID)).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
    await service.list();
    expect(auditLog.create).not.toHaveBeenCalled();
  });
});
