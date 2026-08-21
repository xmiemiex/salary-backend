import { CanActivate, ExecutionContext, INestApplication, Injectable, UnauthorizedException } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { AppExceptionFilter } from '../common/app-exception.filter';
import { CardBindingsController } from './card-bindings.controller';
import { ProviderCardInventoryService } from './provider-card-inventory.service';
import { PhotonPayCardGovernanceService } from './photonpay-card-governance.service';

const request: any = require('supertest');

@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (req.headers['x-test-auth'] !== 'authenticated') throw new UnauthorizedException();
    req.actor = {
      userId: 'user-1',
      roleCode: req.headers['x-test-role'] ?? 'finance',
      permissions: String(req.headers['x-test-permissions'] ?? '').split(',').filter(Boolean),
      ipAddress: '127.0.0.1',
      userAgent: 'supertest',
    };
    req.user = req.actor;
    return true;
  }
}

describe('CardBindingsController auth integration', () => {
  let app: INestApplication;
  const inventory = {
    list: jest.fn().mockResolvedValue({ items: [], summary: {} }),
    syncAll: jest.fn().mockResolvedValue({ status: 'completed', results: [] }),
    syncProvider: jest.fn().mockResolvedValue({ provider: 'airwallex', status: 'completed' }),
  };
  const audit = { failure: jest.fn().mockResolvedValue({}) };
  const governance = {
    listUnmatchedGroups: jest.fn().mockResolvedValue({ groups: [], totalCards: 0 }),
    safeSummary: jest.fn().mockResolvedValue({ totalCards: 0, unmatched: 0 }),
    listEmployeeOptions: jest.fn().mockResolvedValue([]),
    listAliases: jest.fn().mockResolvedValue({ items: [] }),
    previewAlias: jest.fn().mockResolvedValue({}),
    createAlias: jest.fn().mockResolvedValue({}),
    correctAlias: jest.fn().mockResolvedValue({}),
    previewAliasCorrection: jest.fn().mockResolvedValue({}),
    disableAlias: jest.fn().mockResolvedValue({}),
    previewDisableAlias: jest.fn().mockResolvedValue({}),
    previewRematch: jest.fn().mockResolvedValue({}),
    executeRematch: jest.fn().mockResolvedValue({}),
    listExclusions: jest.fn().mockResolvedValue({ items: [] }),
    previewExclusion: jest.fn().mockResolvedValue({}),
    createExclusion: jest.fn().mockResolvedValue({}),
    disableExclusion: jest.fn().mockResolvedValue({}),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CardBindingsController],
      providers: [
        { provide: ProviderCardInventoryService, useValue: inventory },
        { provide: PhotonPayCardGovernanceService, useValue: governance },
        { provide: AuditService, useValue: audit },
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

  it.each([
    ['get', '/card-bindings'],
    ['get', '/card-bindings/photonpay/unmatched-groups'],
    ['get', '/card-bindings/photonpay/summary'],
    ['get', '/card-bindings/photonpay/employee-options'],
    ['get', '/card-bindings/photonpay/aliases'],
    ['get', '/card-bindings/photonpay/rematch/preview'],
    ['get', '/card-bindings/photonpay/exclusions'],
    ['post', '/card-bindings/sync'],
    ['post', '/card-bindings/sync/airwallex'],
  ])('returns 401 for unauthenticated %s %s', async (method, path) => {
    await request(app.getHttpServer())[method](path).expect(401);
  });

  it('allows a super administrator with card_binding.manage to list and sync', async () => {
    const headers = { 'x-test-auth': 'authenticated', 'x-test-role': 'super_admin', 'x-test-permissions': 'card_binding.manage' };
    await request(app.getHttpServer()).get('/card-bindings').set(headers).expect(200);
    await request(app.getHttpServer()).post('/card-bindings/sync').set(headers).expect(201);
    await request(app.getHttpServer()).post('/card-bindings/sync/photonpay').set(headers).expect(201);
    expect(inventory.list).toHaveBeenCalled();
    expect(inventory.syncAll).toHaveBeenCalled();
    expect(inventory.syncProvider).toHaveBeenCalledWith('photonpay', expect.objectContaining({ roleCode: 'super_admin' }));
  });

  it.each([
    ['get', '/card-bindings'],
    ['post', '/card-bindings/sync'],
    ['post', '/card-bindings/sync/airwallex'],
  ])('returns 403 and audits low-permission %s %s', async (method, path) => {
    await request(app.getHttpServer())[method](path)
      .set('x-test-auth', 'authenticated')
      .set('x-test-role', 'finance')
      .set('x-test-permissions', 'salary.view_all')
      .expect(403);
    expect(audit.failure).toHaveBeenCalledWith(expect.objectContaining({ failureReason: 'PERMISSION_DENIED' }));
  });

  it('enforces split PhotonPay read, alias, rematch, and exclusion permissions', async () => {
    const auth = { 'x-test-auth': 'authenticated', 'x-test-role': 'operations_manager' };
    await request(app.getHttpServer()).get('/card-bindings/photonpay/unmatched-groups')
      .set({ ...auth, 'x-test-permissions': 'photonpay_unmatched.read' }).expect(200);
    await request(app.getHttpServer()).get('/card-bindings/photonpay/summary')
      .set({ ...auth, 'x-test-permissions': 'photonpay_unmatched.read' }).expect(200);
    await request(app.getHttpServer()).post('/card-bindings/photonpay/aliases/preview')
      .set({ ...auth, 'x-test-permissions': 'photonpay_unmatched.read' }).send({}).expect(403);
    await request(app.getHttpServer()).post('/card-bindings/photonpay/aliases/preview')
      .set({ ...auth, 'x-test-permissions': 'photonpay_unmatched.read,photonpay_email_alias.manage' }).send({}).expect(201);
    await request(app.getHttpServer()).get('/card-bindings/photonpay/employee-options')
      .set({ ...auth, 'x-test-permissions': 'photonpay_email_alias.manage' }).expect(200);
    await request(app.getHttpServer()).post('/card-bindings/photonpay/aliases/alias-1/preview')
      .set({ ...auth, 'x-test-permissions': 'photonpay_email_alias.manage' }).send({}).expect(201);
    await request(app.getHttpServer()).post('/card-bindings/photonpay/aliases')
      .set({ ...auth, 'x-test-permissions': 'photonpay_email_alias.manage' }).send({}).expect(403);
    await request(app.getHttpServer()).post('/card-bindings/photonpay/aliases')
      .set({ ...auth, 'x-test-permissions': 'photonpay_email_alias.manage,photonpay_rematch.execute' }).send({}).expect(201);
    await request(app.getHttpServer()).post('/card-bindings/photonpay/rematch')
      .set({ ...auth, 'x-test-permissions': 'photonpay_rematch.execute' }).send({ confirm: true }).expect(201);
    await request(app.getHttpServer()).post('/card-bindings/photonpay/exclusions/preview')
      .set({ ...auth, 'x-test-permissions': 'provider_card_exclusion.manage' }).send({}).expect(201);
    await request(app.getHttpServer()).post('/card-bindings/photonpay/exclusions')
      .set({ ...auth, 'x-test-permissions': 'provider_card_exclusion.manage' }).send({ confirm: true }).expect(201);
  });
});
