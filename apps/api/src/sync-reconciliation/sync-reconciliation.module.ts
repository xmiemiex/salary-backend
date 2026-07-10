import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SyncReconciliationController } from './sync-reconciliation.controller';
import { SyncReconciliationService } from './sync-reconciliation.service';

@Module({
  imports: [PrismaModule],
  controllers: [SyncReconciliationController],
  providers: [SyncReconciliationService],
  exports: [SyncReconciliationService],
})
export class SyncReconciliationModule {}
