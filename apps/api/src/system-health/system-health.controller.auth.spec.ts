import { CanActivate, ExecutionContext, INestApplication, Injectable } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { AppExceptionFilter } from '../common/app-exception.filter';
import { SystemHealthController } from './system-health.controller';
import { SystemHealthService } from './system-health.service';

const request: any = require('supertest');

@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    req.actor = {
      userId: '11111111-1111-4111-8111-111111111111',
      roleCode: 'test',
      permissions: String(req.headers['x-test-permissions'] ?? '').split(',').filter(Boolean),
    };
    return true;
  }
}

describe('SystemHealthController auth integration', () => {
  let app: INestApplication;
  const systemHealth = {
    getSystemHealth: jest.fn().mockResolvedValue({ status: 'ok', generatedAt: new Date().toISOString(), checks: [] }),
  };
  const auditService = { failure: jest.fn().mockResolvedValue({}) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SystemHealthController],
      providers: [
        { provide: SystemHealthService, useValue: systemHealth },
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

  it.each(['/system-health', '/system-health/summary', '/system-health/checks'])('requires system_health.read for %s', async (path) => {
    await request(app.getHttpServer()).get(path).set('x-test-permissions', 'audit_log.view').expect(403);
    expect(systemHealth.getSystemHealth).not.toHaveBeenCalled();
    expect(auditService.failure).toHaveBeenCalledWith(expect.objectContaining({
      action: 'permission.denied',
      failureReason: 'PERMISSION_DENIED',
    }));
  });

  it('allows system_health.read', async () => {
    await request(app.getHttpServer()).get('/system-health').set('x-test-permissions', 'system_health.read').expect(200);
    await request(app.getHttpServer()).get('/system-health/checks').set('x-test-permissions', 'system_health.read').expect(200);
    expect(systemHealth.getSystemHealth).toHaveBeenCalledTimes(2);
  });
});
