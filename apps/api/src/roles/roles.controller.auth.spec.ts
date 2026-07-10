import { CanActivate, ExecutionContext, INestApplication, Injectable } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { AppExceptionFilter } from '../common/app-exception.filter';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
const request: any = require('supertest');
const ID = '11111111-1111-4111-8111-111111111111';
@Injectable() class TestAuth implements CanActivate { canActivate(c: ExecutionContext) { const req = c.switchToHttp().getRequest(); req.actor = { userId: ID, roleCode: 'test', permissions: String(req.headers['x-test-permissions'] ?? '').split(',').filter(Boolean) }; return true; } }
describe('RolesController permission integration', () => {
  let app: INestApplication;
  const service = { list: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }), permissions: jest.fn().mockResolvedValue([]), get: jest.fn().mockResolvedValue({ id: ID }), create: jest.fn().mockResolvedValue({ id: ID }), update: jest.fn().mockResolvedValue({ id: ID }), setEnabled: jest.fn().mockResolvedValue({ id: ID }) };
  beforeAll(async () => { const module = await Test.createTestingModule({ controllers: [RolesController], providers: [{ provide: RolesService, useValue: service }, { provide: AuditService, useValue: { failure: jest.fn() } }, { provide: APP_FILTER, useClass: AppExceptionFilter }, { provide: APP_GUARD, useClass: TestAuth }, { provide: APP_GUARD, useClass: PermissionsGuard }] }).compile(); app = module.createNestApplication(); await app.init(); });
  afterAll(async () => app.close()); beforeEach(() => jest.clearAllMocks());
  it.each(['/roles', '/roles/permissions', `/roles/${ID}`])('requires role.read: %s', async (path) => { await request(app.getHttpServer()).get(path).set('x-test-permissions', 'role.manage').expect(403); });
  it('allows reads with role.read', async () => { await request(app.getHttpServer()).get('/roles').set('x-test-permissions', 'role.read').expect(200); await request(app.getHttpServer()).get('/roles/permissions').set('x-test-permissions', 'role.read').expect(200); });
  it.each([['post', '/roles'], ['patch', `/roles/${ID}`], ['post', `/roles/${ID}/enable`], ['post', `/roles/${ID}/disable`]])('requires role.manage: %s %s', async (method, path) => { await request(app.getHttpServer())[method](path).set('x-test-permissions', 'role.read').send({}).expect(403); });
  it('allows create with role.manage', async () => { await request(app.getHttpServer()).post('/roles').set('x-test-permissions', 'role.manage').send({}).expect(201); expect(service.create).toHaveBeenCalled(); });
});
