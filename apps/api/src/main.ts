import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { parseWebOrigin } from './auth/auth-config.service';
import { validateEncryptionKeyConfiguration } from './common/credential-crypto.service';
import { readSyncPlannerConfig } from './sync-tasks/sync-planner-config';
import { readSyncAutoExecutionConfig } from './sync-tasks/sync-auto-execution-config';

async function bootstrap() {
  validateEncryptionKeyConfiguration();
  readSyncPlannerConfig();
  readSyncAutoExecutionConfig();
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: parseWebOrigin(process.env.CORS_ALLOWED_ORIGIN ?? process.env.WEB_ORIGIN),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: false,
  });
  await app.listen(parseApiPort(process.env.API_PORT ?? process.env.PORT));
}

export function parseApiPort(value: string | undefined): number {
  if (value === undefined || value === '') return 3000;
  if (!/^\d+$/.test(value)) throw new Error('API_PORT must be an integer between 1 and 65535.');
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error('API_PORT must be an integer between 1 and 65535.');
  return port;
}

void bootstrap();
