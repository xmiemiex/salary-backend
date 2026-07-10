import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ApiCredentialsController } from './api-credentials.controller';
import { ApiCredentialsService } from './api-credentials.service';
import { CredentialReaderService } from './credential-reader.service';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [ApiCredentialsController],
  providers: [ApiCredentialsService, CredentialCryptoService, CredentialReaderService],
  exports: [CredentialReaderService],
})
export class ApiCredentialsModule {}
