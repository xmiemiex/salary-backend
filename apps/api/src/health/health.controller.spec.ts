import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

const request: any = require('supertest');

describe('HealthController', () => {
  let app: INestApplication;
  const health = { isDatabaseReady: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: health }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => app.close());
  beforeEach(() => health.isDatabaseReady.mockReset());

  it('returns 200 for liveness without checking the database', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' });
    expect(health.isDatabaseReady).not.toHaveBeenCalled();
  });

  it('returns 200 when the database is ready', async () => {
    health.isDatabaseReady.mockResolvedValue(true);
    await request(app.getHttpServer()).get('/health/ready').expect(200, { status: 'ready' });
  });

  it('returns 503 without leaking errors when the database is unavailable', async () => {
    health.isDatabaseReady.mockResolvedValue(false);
    const response = await request(app.getHttpServer()).get('/health/ready').expect(503, { status: 'not_ready' });
    expect(JSON.stringify(response.body)).not.toMatch(/database_url|password|token|stack/i);
  });
});
