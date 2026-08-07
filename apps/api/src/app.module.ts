import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AffiliateAccountsModule } from './affiliate-accounts/affiliate-accounts.module';
import { ApiCredentialsModule } from './api-credentials/api-credentials.module';
import { AuditModule } from './audit/audit.module';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { PermissionsGuard } from './auth/permissions.guard';
import { CardBindingsModule } from './card-bindings/card-bindings.module';
import { AppExceptionFilter } from './common/app-exception.filter';
import { EmployeesModule } from './employees/employees.module';
import { HistoricalNegativeProfitsModule } from './historical-negative-profits/historical-negative-profits.module';
import { HealthModule } from './health/health.module';
import { ManualCardSpendEntriesModule } from './manual-card-spend-entries/manual-card-spend-entries.module';
import { ManualIncomeRecordsModule } from './manual-income-records/manual-income-records.module';
import { MonthLockModule } from './month-lock/month-lock.module';
import { MonthlyCardProviderFeeRatesModule } from './monthly-card-provider-fee-rates/monthly-card-provider-fee-rates.module';
import { MonthlyExchangeRatesModule } from './monthly-exchange-rates/monthly-exchange-rates.module';
import { PerformanceGroupsModule } from './performance-groups/performance-groups.module';
import { PrismaModule } from './prisma/prisma.module';
import { SalaryManualItemsModule } from './salary-manual-items/salary-manual-items.module';
import { SettlementModule } from './settlement/settlement.module';
import { SubIdMappingsModule } from './sub-id-mappings/sub-id-mappings.module';
import { SyncReconciliationModule } from './sync-reconciliation/sync-reconciliation.module';
import { SyncTasksModule } from './sync-tasks/sync-tasks.module';
import { SyncUnmatchedEventsModule } from './sync-unmatched-events/sync-unmatched-events.module';
import { AdminUsersModule } from './admin-users/admin-users.module';
import { RolesModule } from './roles/roles.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { SystemHealthModule } from './system-health/system-health.module';
import { AlertsModule } from './alerts/alerts.module';
import { BackupRecoveryModule } from './backup-recovery/backup-recovery.module';
import { ReleaseGateModule } from './release-gate/release-gate.module';
import { CakeIncomeAdjustmentsModule } from './cake-income-adjustments/cake-income-adjustments.module';

@Module({
  imports: [
    PrismaModule,
    HealthModule,
    AuditModule,
    AuthModule,
    MonthLockModule,
    SettlementModule,
    EmployeesModule,
    AffiliateAccountsModule,
    ApiCredentialsModule,
    SubIdMappingsModule,
    CardBindingsModule,
    MonthlyExchangeRatesModule,
    MonthlyCardProviderFeeRatesModule,
    ManualIncomeRecordsModule,
    ManualCardSpendEntriesModule,
    HistoricalNegativeProfitsModule,
    PerformanceGroupsModule,
    SalaryManualItemsModule,
    SyncTasksModule,
    SyncReconciliationModule,
    SyncUnmatchedEventsModule,
    AdminUsersModule,
    RolesModule,
    DashboardModule,
    BackupRecoveryModule,
    SystemHealthModule,
    AlertsModule,
    ReleaseGateModule,
    CakeIncomeAdjustmentsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
