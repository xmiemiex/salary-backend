import { CanActivate, ExecutionContext, INestApplication, Injectable } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import { AppExceptionFilter } from '../common/app-exception.filter';
import { PermissionsGuard } from '../auth/permissions.guard';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';

const request: any = require('supertest');

@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const permissions = String(request.headers['x-test-permissions'] ?? '')
      .split(',')
      .map((permission) => permission.trim())
      .filter(Boolean);
    request.actor = {
      userId: 'user-1',
      roleCode: 'finance',
      permissions,
      ipAddress: '127.0.0.1',
      userAgent: 'supertest',
    };
    request.user = request.actor;
    return true;
  }
}

describe('EmployeesController auth integration', () => {
  let app: INestApplication;
  const employeesService = {
    create: jest.fn().mockResolvedValue({ id: 'employee-1', employeeCode: 'E001', name: 'Alice' }),
  };
  const auditService = {
    failure: jest.fn().mockResolvedValue({ id: 'audit-1' }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EmployeesController],
      providers: [
        { provide: EmployeesService, useValue: employeesService },
        { provide: AuditService, useValue: auditService },
        { provide: APP_FILTER, useClass: AppExceptionFilter },
        { provide: APP_GUARD, useClass: TestAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows creating employee with employee.manage permission', async () => {
    await request(app.getHttpServer())
      .post('/employees')
      .set('x-test-permissions', 'employee.manage')
      .send({ employeeCode: 'E001', name: 'Alice' })
      .expect(201)
      .expect({ id: 'employee-1', employeeCode: 'E001', name: 'Alice' });

    expect(employeesService.create).toHaveBeenCalledWith(
      { employeeCode: 'E001', name: 'Alice' },
      expect.objectContaining({ userId: 'user-1', permissions: ['employee.manage'] }),
    );
  });

  it('returns PERMISSION_DENIED when creating employee without employee.manage permission', async () => {
    await request(app.getHttpServer())
      .post('/employees')
      .set('x-test-permissions', 'salary.view_all')
      .send({ employeeCode: 'E001', name: 'Alice' })
      .expect(403)
      .expect({
        success: false,
        error: {
          code: 'PERMISSION_DENIED',
          message: 'Permission denied.',
          details: {
            requiredPermissions: ['employee.manage'],
            missingPermissions: ['employee.manage'],
          },
        },
      });

    expect(employeesService.create).not.toHaveBeenCalled();
    expect(auditService.failure).toHaveBeenCalledWith(expect.objectContaining({ failureReason: 'PERMISSION_DENIED' }));
  });
});
