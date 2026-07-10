import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import {
  AffiliateIncomeReconciliationQuery,
  CardSpendReconciliationQuery,
  SyncReconciliationService,
  UnmatchedReconciliationQuery,
} from './sync-reconciliation.service';

@Controller('sync-reconciliation')
@RequirePermissions('salary.view_all')
export class SyncReconciliationController {
  constructor(private readonly reconciliation: SyncReconciliationService) {}

  @Get('affiliate-income')
  affiliateIncome(@Query() query: AffiliateIncomeReconciliationQuery) {
    return this.reconciliation.affiliateIncome(query);
  }

  @Get('card-spend')
  cardSpend(@Query() query: CardSpendReconciliationQuery) {
    return this.reconciliation.cardSpend(query);
  }

  @Get('monthly-employee-summary')
  monthlyEmployeeSummary(@Query('settlementMonth') settlementMonth: string) {
    return this.reconciliation.monthlyEmployeeSummary({ settlementMonth });
  }

  @Get('unmatched')
  unmatched(@Query() query: UnmatchedReconciliationQuery) {
    return this.reconciliation.unmatched(query);
  }
}
