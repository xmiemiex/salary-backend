import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequireAnyPermissions, RequirePermissions } from '../auth/require-permissions.decorator';
import {
  CreateAffiliateIncomeSyncTaskInput,
  CreateCardSpendSyncTaskInput,
  SyncTasksQuery,
  SyncTasksService,
} from './sync-tasks.service';
import { SyncTaskExecutionService } from './sync-task-execution.service';
import {
  SyncTaskOperationActionInput,
  SyncTaskOperationsQuery,
  SyncTaskOperationsService,
} from './sync-task-operations.service';

@Controller('sync-tasks')
export class SyncTasksController {
  constructor(
    private readonly syncTasks: SyncTasksService,
    private readonly syncTaskExecution: SyncTaskExecutionService,
    private readonly syncTaskOperations: SyncTaskOperationsService,
  ) {}

  @Get()
  @RequireAnyPermissions('salary.view_all', 'income.import', 'manual_card_spend.manage')
  list(@Query() query: SyncTasksQuery) {
    return this.syncTasks.list(query);
  }

  @Get('operations')
  @RequireAnyPermissions('salary.view_all', 'income.import', 'manual_card_spend.manage')
  operations(@Query() query: SyncTaskOperationsQuery) {
    return this.syncTaskOperations.list(query);
  }

  @Get(':taskId/operation-detail')
  @RequireAnyPermissions('salary.view_all', 'income.import', 'manual_card_spend.manage')
  operationDetail(@Param('taskId') taskId: string) {
    return this.syncTaskOperations.detail(taskId);
  }

  @Post('affiliate-income')
  @RequirePermissions('income.import')
  createAffiliateIncome(@Body() body: CreateAffiliateIncomeSyncTaskInput, @CurrentActor() actor: Actor) {
    return this.syncTasks.createAffiliateIncome(body, actor);
  }

  @Post('card-spend/:provider')
  @RequirePermissions('manual_card_spend.manage')
  createCardSpend(
    @Param('provider') provider: string,
    @Body() body: CreateCardSpendSyncTaskInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.syncTasks.createCardSpend(provider, body, actor);
  }

  @Post(':taskId/execute')
  @RequireAnyPermissions('income.import', 'manual_card_spend.manage')
  execute(@Param('taskId') taskId: string, @CurrentActor() actor: Actor) {
    return this.syncTaskExecution.execute(taskId, actor);
  }

  @Post(':taskId/request-retry')
  @RequireAnyPermissions('income.import', 'manual_card_spend.manage')
  requestRetry(
    @Param('taskId') taskId: string,
    @Body() body: SyncTaskOperationActionInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.syncTaskOperations.requestRetry(taskId, body, actor);
  }

  @Post(':taskId/cancel')
  @RequireAnyPermissions('income.import', 'manual_card_spend.manage')
  cancel(
    @Param('taskId') taskId: string,
    @Body() body: SyncTaskOperationActionInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.syncTaskOperations.cancel(taskId, body, actor);
  }
}
