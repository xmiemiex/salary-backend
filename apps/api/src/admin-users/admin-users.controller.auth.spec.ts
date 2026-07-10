import { CanActivate, ExecutionContext, INestApplication, Injectable } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { AppExceptionFilter } from '../common/app-exception.filter';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

const request: any = require('supertest');
const ID = '11111111-1111-4111-8111-111111111111';

@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    req.actor = {
      userId: ID,
      roleCode: 'test',
      permissions: String(req.headers['x-test-permissions'] ?? '').split(',').filter(Boolean),
    };
    return true;
  }
}

describe('AdminUsersController permission integration', () => {
  let app: INestApplication;
  const service = {
    list: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    listRoles: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({ id: ID }),
    create: jest.fn().mockResolvedValue({ id: ID }),
    update: jest.fn().mockResolvedValue({ id: ID }),
    resetPassword: jest.fn().mockResolvedValue({ success: true }),
    setEnabled: jest.fn().mockResolvedValue({ id: ID }),
  };
  const audit = { failure: jest.fn().mockResolvedValue({}) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminUsersController],
      providers: [
        { provide: AdminUsersService, useValue: service },
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

  it.each(['/admin-users', '/admin-users/roles', `/admin-users/${ID}`])('read endpoint requires admin_users.read: %s', async (path) => {
    await request(app.getHttpServer()).get(path).set('x-test-permissions', 'user.manage,role.manage').expect(403);
  });

  it('read permission allows list and detail', async () => {
    await request(app.getHttpServer()).get('/admin-users').set('x-test-permissions', 'admin_users.read').expect(200);
    await request(app.getHttpServer()).get(`/admin-users/${ID}`).set('x-test-permissions', 'admin_users.read').expect(200);
    expect(service.list).toHaveBeenCalled();
    expect(service.get).toHaveBeenCalledWith(ID);
  });

  it.each([
    ['post', '/admin-users'],
    ['patch', `/admin-users/${ID}`],
    ['post', `/admin-users/${ID}/reset-password`],
    ['post', `/admin-users/${ID}/enable`],
    ['post', `/admin-users/${ID}/disable`],
  ])('write endpoint requires admin_users.manage: %s %s', async (method, path) => {
    await request(app.getHttpServer())[method](path).set('x-test-permissions', 'admin_users.read').send({}).expect(403);
  });

  it('manage permission allows create', async () => {
    await request(app.getHttpServer()).post('/admin-users').set('x-test-permissions', 'admin_users.manage').send({}).expect(201);
    expect(service.create).toHaveBeenCalledWith({}, expect.objectContaining({ userId: ID }));
  });
});
