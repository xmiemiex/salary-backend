import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
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

  @Get('affiliate-income/export.csv')
  async exportAffiliateIncome(@Query() query: AffiliateIncomeReconciliationQuery) {
    const result = await this.reconciliation.exportAffiliatePayoutCsv(query);
    return new StreamableFile(Buffer.from(result.csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${result.filename}"`,
    });
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
