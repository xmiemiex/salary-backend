import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ApiCredentialsModule } from '../api-credentials/api-credentials.module';
import { MonthLockModule } from '../month-lock/month-lock.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AirwallexClient } from '../sync-tasks/airwallex/airwallex-client';
import { PhotonPayClient } from '../sync-tasks/photonpay/photonpay-client';
import { CardBindingsController } from './card-bindings.controller';
import { CardBindingsService } from './card-bindings.service';
import { ProviderCardInventoryService } from './provider-card-inventory.service';
import { PhotonPayCardGovernanceService } from './photonpay-card-governance.service';

@Module({
  imports: [PrismaModule, MonthLockModule, AuditModule, ApiCredentialsModule],
  controllers: [CardBindingsController],
  providers: [CardBindingsService, AirwallexClient, PhotonPayClient, ProviderCardInventoryService, PhotonPayCardGovernanceService],
  exports: [CardBindingsService, AirwallexClient, PhotonPayClient, ProviderCardInventoryService, PhotonPayCardGovernanceService],
})
export class CardBindingsModule {}
