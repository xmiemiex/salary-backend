import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

@Module({ imports: [PrismaModule, AuditModule], controllers: [RolesController], providers: [RolesService] })
export class RolesModule {}
