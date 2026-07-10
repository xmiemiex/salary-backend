import { Controller, Get } from '@nestjs/common';
import { RequireAnyPermissions } from '../auth/require-permissions.decorator';
import { SyncAutoExecutionService } from './sync-auto-execution.service';

@Controller('sync-auto-execution')
export class SyncAutoExecutionController {
  constructor(private readonly execution: SyncAutoExecutionService) {}

  @Get('status')
  @RequireAnyPermissions('salary.view_all', 'income.import', 'manual_card_spend.manage')
  status() { return this.execution.status(); }
}
