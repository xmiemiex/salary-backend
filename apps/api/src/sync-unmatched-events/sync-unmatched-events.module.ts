import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SyncUnmatchedEventsController } from './sync-unmatched-events.controller';
import { SyncUnmatchedEventsService } from './sync-unmatched-events.service';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [SyncUnmatchedEventsController],
  providers: [SyncUnmatchedEventsService],
  exports: [SyncUnmatchedEventsService],
})
export class SyncUnmatchedEventsModule {}
