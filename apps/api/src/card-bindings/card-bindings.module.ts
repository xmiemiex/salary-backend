import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ApiCredentialsModule } from '../api-credentials/api-credentials.module';
import { MonthLockModule } from '../month-lock/month-lock.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AirwallexClient } from '../sync-tasks/airwallex/airwallex-client';
import { AirwallexCardDiscoveryService } from './airwallex-card-discovery.service';
import { CardBindingsController } from './card-bindings.controller';
import { CardBindingsService } from './card-bindings.service';

@Module({
  imports: [PrismaModule, MonthLockModule, AuditModule, ApiCredentialsModule],
  controllers: [CardBindingsController],
  providers: [CardBindingsService, AirwallexClient, AirwallexCardDiscoveryService],
  exports: [CardBindingsService],
})
export class CardBindingsModule {}
