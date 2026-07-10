import { CanActivate, ExecutionContext, INestApplication, Injectable } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { AppExceptionFilter } from '../common/app-exception.filter';
import { ReleaseGateController } from './release-gate.controller';
import { ReleaseGateService } from './release-gate.service';

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

describe('ReleaseGateController auth integration', () => {
  let app: INestApplication;
  const releaseGate = {
    getReleaseGate: jest.fn().mockResolvedValue({ status: 'pass', generatedAt: new Date().toISOString(), checks: [], summary: { pass: 0, warning: 0, fail: 0 } }),
    runReleaseGate: jest.fn().mockResolvedValue({ status: 'pass', generatedAt: new Date().toISOString(), checks: [], summary: { pass: 0, warning: 0, fail: 0 } }),
  };
  const auditService = { failure: jest.fn().mockResolvedValue({}) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ReleaseGateController],
      providers: [
        { provide: ReleaseGateService, useValue: releaseGate },
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

  it('requires release_gate.read for GET', async () => {
    await request(app.getHttpServer()).get('/release-gate').set('x-test-permissions', 'system_health.read').expect(403);
    expect(releaseGate.getReleaseGate).not.toHaveBeenCalled();
    expect(auditService.failure).toHaveBeenCalledWith(expect.objectContaining({ action: 'permission.denied', failureReason: 'PERMISSION_DENIED' }));
  });

  it('requires release_gate.run for POST run', async () => {
    await request(app.getHttpServer()).post('/release-gate/run').set('x-test-permissions', 'release_gate.read').expect(403);
    expect(releaseGate.runReleaseGate).not.toHaveBeenCalled();
  });

  it('allows read and run permissions separately', async () => {
    await request(app.getHttpServer()).get('/release-gate').set('x-test-permissions', 'release_gate.read').expect(200);
    await request(app.getHttpServer()).post('/release-gate/run').set('x-test-permissions', 'release_gate.run').expect(201);
    expect(releaseGate.getReleaseGate).toHaveBeenCalledTimes(1);
    expect(releaseGate.runReleaseGate).toHaveBeenCalledTimes(1);
  });
});
