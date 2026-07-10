import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Actor } from '../auth/auth.types';
import { RequireAnyPermissions, RequirePermissions } from '../auth/require-permissions.decorator';
import { BackupHealthService } from './backup-health.service';
import { BackupRecoveryService } from './backup-recovery.service';

@Controller()
export class BackupRecoveryController {
  constructor(
    private readonly records: BackupRecoveryService,
    private readonly health: BackupHealthService,
  ) {}

  @Get('backup-records')
  @RequirePermissions('backup_status.read')
  listBackups(@Query() query: Record<string, unknown>) {
    return this.records.listBackups(query);
  }

  @Get('backup-records/:id')
  @RequirePermissions('backup_status.read')
  getBackup(@Param('id') id: string) {
    return this.records.getBackup(id);
  }

  @Post('backup-records')
  @RequirePermissions('backup_status.manage')
  createBackup(@CurrentActor() actor: Actor, @Body() body: Record<string, unknown>) {
    return this.records.createBackup(body, actor);
  }

  @Patch('backup-records/:id')
  @RequirePermissions('backup_status.manage')
  updateBackup(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.records.updateBackup(id, body, actor);
  }

  @Get('restore-drills')
  @RequirePermissions('restore_drill.read')
  listDrills(@Query() query: Record<string, unknown>) {
    return this.records.listDrills(query);
  }

  @Get('restore-drills/:id')
  @RequirePermissions('restore_drill.read')
  getDrill(@Param('id') id: string) {
    return this.records.getDrill(id);
  }

  @Post('restore-drills')
  @RequirePermissions('restore_drill.manage')
  createDrill(@CurrentActor() actor: Actor, @Body() body: Record<string, unknown>) {
    return this.records.createDrill(body, actor);
  }

  @Patch('restore-drills/:id')
  @RequirePermissions('restore_drill.manage')
  updateDrill(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.records.updateDrill(id, body, actor);
  }

  @Get('backup-health')
  @RequireAnyPermissions('backup_status.read', 'restore_drill.read')
  getHealth() {
    return this.health.getHealth();
  }
}
