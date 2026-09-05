import { Injectable } from '@nestjs/common';
import { Prisma, Provider, SyncTaskPlatform, SyncTaskType } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { parseSettlementMonthParam } from '../settlement/settlement-month.util';
import { resolveEffectiveSubIdMappings, EffectiveSubIdMappingReader } from '../sub-id-mappings/effective-sub-id-mappings';

const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);
const active = ['pending', 'running', 'retry_wait'];
export function financeAmounts(income: Prisma.Decimal.Value, spends: Record<string, Prisma.Decimal.Value>, rates: Record<string, string | null>) {
  let raw = D(0), total = D(0);
  const missing: string[] = [];
  for (const [provider, amount] of Object.entries(spends)) {
    const spend = D(amount); raw = raw.plus(spend);
    if (!spend.isZero() && rates[provider] == null) missing.push(provider);
    else total = total.plus(spend.times(D(1).plus(rates[provider] ?? '0')));
  }
  const profit = D(income).minus(total);
  return { rawSpend: raw.toString(), totalSpend: missing.length ? null : total.toString(), profit: missing.length ? null : profit.toString(), margin: missing.length || total.isZero() ? null : profit.div(total).times(100).toFixed(2), missingRates: missing };
}

@Injectable()
export class MonthlyFinanceService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async read(input: string) {
    const month = parseSettlementMonthParam(input);
    const [accounts, mappings, income, spend, manual, fees, adposFee, settlement, tasks, latestBatch, employeeRows] = await Promise.all([
      this.prisma.affiliateAccount.findMany({ orderBy: { createdAt: 'asc' }, include: { credential: { select: { status: true } } } }),
      resolveEffectiveSubIdMappings(this.prisma as unknown as EffectiveSubIdMappingReader, { settlementMonth: month }),
      this.prisma.incomeRecord.findMany({ where: { settlementMonth: month, status: 'confirmed' } }),
      this.prisma.cardSpendEvent.findMany({ where: { settlementMonth: month, status: 'confirmed' } }),
      this.prisma.manualCardSpendEntry.findMany({ where: { settlementMonth: month, status: 'confirmed' } }),
      this.prisma.monthlyCardProviderFeeRate.findMany({ where: { settlementMonth: month, status: { in: ['active', 'confirmed'] } } }),
      this.prisma.monthlyAdposFeeRate.findUnique({ where: { settlementMonth: month } }),
      this.prisma.monthlySettlement.findUnique({ where: { settlementMonth: month }, select: { status: true } }),
      this.prisma.syncTask.findMany({ where: { settlementMonth: month }, orderBy: { createdAt: 'desc' } }),
      this.prisma.monthlyRefreshBatch.findFirst({ where: { settlementMonth: month }, orderBy: { createdAt: 'desc' } }),
      this.prisma.employee.findMany({ select: { id: true, businessSubId: true } }),
    ]);
    const columns = accounts.filter(a => a.status === 'active' || income.some(i => i.affiliateAccountId === a.id));
    const rates: Record<string, string | null> = { airwallex: null, photonpay: null, adpos: adposFee?.feeRate.toString() ?? null };
    fees.forEach(f => { rates[f.provider] = f.feeRate.toString(); });
    const sources = [...columns.filter(a => a.status === 'active').map(a => ({ key: a.id, name: a.accountName ?? a.accountCode })), { key: 'airwallex', name: 'Airwallex' }, { key: 'photonpay', name: 'PhotonPay' }].map(source => {
      const history = tasks.filter(t => (t.affiliateAccountId ?? t.provider) === source.key && !(t.requestPayload && typeof t.requestPayload === 'object' && !Array.isArray(t.requestPayload) && t.requestPayload.inventoryOnly === true));
      const latest = history[0];
      const success = history.find(t => t.status === 'completed' && t.failedCount === 0);
      const reason = latest?.lastErrorCategory === 'CREDENTIAL_MISSING' ? '尚未配置有效凭据' : latest?.lastErrorCategory === 'TIMEOUT' ? '来源响应超时' : latest?.lastErrorCategory === 'RATE_LIMITED' ? '来源请求限流' : latest?.status === 'failed' ? '来源未完成，请重试或查看同步详情' : null;
      return { ...source, reason, status: !latest ? 'missing' : latest.failedCount > 0 && latest.successCount > 0 ? 'partial' : latest.status, lastSuccessAt: success?.finishedAt ?? null, updatedAt: latest?.finishedAt ?? null };
    });
    const employees = new Set([...mappings.filter(m => m.status === 'active').map(m => m.employeeId), ...income.map(i => i.employeeId), ...spend.map(s => s.employeeId), ...manual.map(m => m.employeeId)]);
    const rows = [...employees].map(employeeId => {
      const subIds = [...new Set([...mappings.filter(m => m.employeeId === employeeId && m.status === 'active').map(m => m.subValue), ...income.filter(i => i.employeeId === employeeId && i.subValue).map(i => i.subValue!)])].sort();
      const details: Array<{ category: string; source: string; amount: string; date: string | null }> = [];
      const byAffiliate: Record<string, string> = {};
      let totalIncome = D(0), otherIncome = D(0);
      for (const i of income.filter(i => i.employeeId === employeeId)) {
        totalIncome = totalIncome.plus(i.incomeUsd);
        if (i.affiliateAccountId) byAffiliate[i.affiliateAccountId] = D(byAffiliate[i.affiliateAccountId] ?? 0).plus(i.incomeUsd).toString();
        else otherIncome = otherIncome.plus(i.incomeUsd);
        details.push({ category: 'income', source: accounts.find(a => a.id === i.affiliateAccountId)?.accountName ?? (i.affiliateAccountId ? '联盟收入' : '其他手动收入 / 已确认调整'), amount: i.incomeUsd.toString(), date: null });
      }
      const spends: Record<string, string> = { airwallex: '0', photonpay: '0', adpos: '0' };
      for (const s of spend.filter(s => s.employeeId === employeeId)) {
        spends[s.provider] = D(spends[s.provider]).plus(s.spendUsd).toString();
        details.push({ category: s.provider, source: s.provider === 'airwallex' ? 'Airwallex · 已结算' : 'PhotonPay · 实际 USD 本金', amount: s.spendUsd.toString(), date: s.transactionAt.toISOString() });
      }
      let otherManualCost = D(0);
      for (const m of manual.filter(m => m.employeeId === employeeId)) {
        if (m.providerName.trim().toLowerCase() === 'adpos') spends.adpos = D(spends.adpos).plus(m.settledSpendUsd).toString();
        else otherManualCost = otherManualCost.plus(m.actualSpendUsd);
        details.push({ category: 'adpos', source: m.providerName, amount: m.settledSpendUsd.toString(), date: null });
      }
      const amounts = financeAmounts(totalIncome, spends, rates);
      // Legacy manual providers remain visible and included instead of silently disappearing.
      if (!otherManualCost.isZero()) {
        amounts.rawSpend = D(amounts.rawSpend).plus(manual.filter(m => m.employeeId === employeeId && m.providerName.trim().toLowerCase() !== 'adpos').reduce((n, m) => n.plus(m.settledSpendUsd), D(0))).toString();
        if (amounts.totalSpend !== null) {
          amounts.totalSpend = D(amounts.totalSpend).plus(otherManualCost).toString();
          amounts.profit = totalIncome.minus(amounts.totalSpend).toString();
          amounts.margin = D(amounts.totalSpend).isZero() ? null : D(amounts.profit).div(amounts.totalSpend).times(100).toFixed(2);
        }
      }
      const unified = employeeId ? employeeRows.find(e => e.id === employeeId)?.businessSubId ?? (subIds.length === 1 ? subIds[0] : null) : null;
      return { key: employeeId ?? 'unassigned', subId: unified ?? '待统一 SUB ID', subIds, attributionPending: !unified, byAffiliate, otherIncome: otherIncome.toString(), totalIncome: totalIncome.toString(), spends, otherManualCost: otherManualCost.toString(), ...amounts, details };
    });
    const duplicateSubs = new Set(rows.filter(row => !row.attributionPending && rows.filter(other => other.subId === row.subId).length > 1).map(row => row.subId));
    for (const row of rows) if (duplicateSubs.has(row.subId)) { row.subId = '待统一 SUB ID'; row.attributionPending = true; }
    const totals = { totalIncome: '0', otherIncome: '0', rawSpend: '0', totalSpend: null as string | null, profit: null as string | null, margin: null as string | null, byAffiliate: {} as Record<string, string>, spends: { airwallex: '0', photonpay: '0', adpos: '0' } as Record<string, string> };
    for (const row of rows) {
      for (const key of ['totalIncome', 'otherIncome', 'rawSpend'] as const) totals[key] = D(totals[key]).plus(row[key]).toString();
      for (const [key, value] of Object.entries(row.byAffiliate)) totals.byAffiliate[key] = D(totals.byAffiliate[key] ?? 0).plus(value).toString();
      for (const [key, value] of Object.entries(row.spends)) totals.spends[key] = D(totals.spends[key]).plus(value).toString();
    }
    if (rows.every(row => row.totalSpend !== null)) {
      totals.totalSpend = rows.reduce((n, r) => n.plus(r.totalSpend!), D(0)).toString();
      totals.profit = D(totals.totalIncome).minus(totals.totalSpend).toString();
      totals.margin = D(totals.totalSpend).isZero() ? null : D(totals.profit).div(totals.totalSpend).times(100).toFixed(2);
    }
    return { localSample: income.some(i => i.rawData && typeof i.rawData === 'object' && !Array.isArray(i.rawData) && i.rawData.fixture === 'SIMULATED_LOCAL_ONLY'), month: input, locked: settlement?.status === 'locked', columns: columns.map(a => ({ key: a.id, name: a.accountName ?? a.accountCode })), rates, rows, totals, sources, complete: sources.every(s => s.status === 'completed') && rows.every(r => !r.attributionPending && r.missingRates.length === 0), batchId: latestBatch?.id ?? null, refreshing: tasks.some(t => t.refreshBatchId && active.includes(t.status)), asOf: new Date() };
  }

  async saveFees(input: string, values: Record<string, string>, actor: Actor) {
    const month = parseSettlementMonthParam(input);
    const rates = Object.fromEntries(['airwallex', 'photonpay', 'adpos'].map(key => [key, decimal(values[key], 1)]));
    return this.write(month, actor, 'monthly_finance.fees', async tx => {
      for (const provider of [Provider.airwallex, Provider.photonpay]) await tx.monthlyCardProviderFeeRate.upsert({ where: { settlementMonth_provider: { settlementMonth: month, provider } }, create: { settlementMonth: month, provider, feeRate: rates[provider], createdBy: actor.userId }, update: { feeRate: rates[provider], status: 'active' } });
      await tx.monthlyAdposFeeRate.upsert({ where: { settlementMonth: month }, create: { settlementMonth: month, feeRate: rates.adpos, createdBy: actor.userId }, update: { feeRate: rates.adpos } });
      const entries = await tx.manualCardSpendEntry.findMany({ where: { settlementMonth: month, providerName: { equals: 'adpos', mode: 'insensitive' } } });
      for (const entry of entries) await tx.manualCardSpendEntry.update({ where: { id: entry.id }, data: { feeRate: rates.adpos, actualSpendUsd: entry.settledSpendUsd.times(D(1).plus(rates.adpos)) } });
      return { saved: true, rates: Object.fromEntries(Object.entries(rates).map(([k,v]) => [k,v.toString()])) };
    });
  }

  async saveAdpos(input: string, subId: string, value: string, actor: Actor) {
    const month = parseSettlementMonthParam(input), amount = decimal(value, 999999999999);
    const mappings = (await resolveEffectiveSubIdMappings(this.prisma as unknown as EffectiveSubIdMappingReader, { settlementMonth: month })).filter(m => m.status === 'active');
    const unified = await this.prisma.employee.findUnique({ where: { businessSubId: subId } });
    const owners = unified ? [unified.id] : [...new Set(mappings.filter(m => m.subValue === subId).map(m => m.employeeId))];
    if (owners.length !== 1 || (!unified && new Set(mappings.filter(m => m.employeeId === owners[0]).map(m => m.subValue)).size !== 1)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, '该 SUB ID 的成本归属需要确认。');
    return this.write(month, actor, 'monthly_finance.adpos', async tx => {
      const fee = await tx.monthlyAdposFeeRate.findUnique({ where: { settlementMonth: month } });
      const rows = await tx.manualCardSpendEntry.findMany({ where: { settlementMonth: month, employeeId: owners[0], providerName: { equals: 'adpos', mode: 'insensitive' } } });
      // Preserve historical entries; an audited balancing entry edits the monthly aggregate.
      const editable = rows.find(r => r.cardIdentifier === 'monthly-dashboard');
      const retained = rows.filter(r => r.id !== editable?.id && r.status === 'confirmed').reduce((sum, r) => sum.plus(r.settledSpendUsd), D(0));
      const delta = amount.minus(retained), rate = fee?.feeRate ?? D(0);
      const data = { settledSpendUsd: delta, feeRate: rate, actualSpendUsd: delta.times(D(1).plus(rate)), status: 'confirmed' as const };
      if (editable) await tx.manualCardSpendEntry.update({ where: { id: editable.id }, data });
      else await tx.manualCardSpendEntry.create({ data: { ...data, settlementMonth: month, employeeId: owners[0], providerName: 'Adpos', cardIdentifier: 'monthly-dashboard', createdBy: actor.userId, reason: '月度收支原始花费调整' } });
      return { saved: true, subId, previousAmount: retained.plus(editable?.settledSpendUsd ?? 0).toString(), amount: amount.toString() };
    });
  }

  async refresh(input: string, actor: Actor, source?: string) {
    const month = parseSettlementMonthParam(input);
    return this.write(month, actor, 'monthly_finance.refresh', async tx => {
      const existing = await tx.syncTask.findFirst({ where: { settlementMonth: month, refreshBatchId: { not: null }, status: { in: ['pending', 'running', 'retry_wait'] } } });
      if (existing) return { batchId: existing.refreshBatchId, reused: true };
      const recent = await tx.monthlyRefreshBatch.findFirst({ where: { settlementMonth: month, createdAt: { gte: new Date(Date.now() - 3000) } }, orderBy: { createdAt: 'desc' }, include: { tasks: { select: { provider: true, affiliateAccountId: true } } } });
      if (recent && (!source || (recent.tasks.length === 1 && (recent.tasks[0].provider ?? recent.tasks[0].affiliateAccountId) === source))) return { batchId: recent.id, reused: true };
      const batch = await tx.monthlyRefreshBatch.create({ data: { settlementMonth: month, requestedBy: actor.userId } });
      const accounts = await tx.affiliateAccount.findMany({ where: { status: 'active' }, include: { credential: { select: { status: true } } } });
      const providers = await tx.cardProviderCredential.findMany({ where: { status: 'active' }, select: { provider: true } });
      const candidates = [...accounts.map(a => ({ key: a.id, platform: a.platform, affiliateAccountId: a.id, provider: null as Provider | null, configured: a.credential?.status === 'active' })), ...[Provider.airwallex, Provider.photonpay].map(provider => ({ key: provider, platform: provider as string, affiliateAccountId: null, provider, configured: providers.some(p => p.provider === provider) }))];
      if (source && !candidates.some(c => c.key === source)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, '同步来源不存在。');
      for (const c of candidates.filter(c => !source || c.key === source)) {
        const supported = ['everflow', 'cake', 'airwallex', 'photonpay'].includes(c.platform.toLowerCase());
        if (!supported) continue;
        await tx.syncTask.create({ data: { settlementMonth: month, refreshBatchId: batch.id, requestedBy: actor.userId, triggerType: 'manual', planningKey: `dashboard:${batch.id}:${c.key}`, sourceType: c.provider ? 'card_spend' : 'affiliate_income', taskType: c.provider ? (c.provider === 'airwallex' ? SyncTaskType.airwallex_card : SyncTaskType.photonpay_card) : SyncTaskType.affiliate_income, platform: c.platform.toLowerCase() as SyncTaskPlatform, affiliateAccountId: c.affiliateAccountId, provider: c.provider, status: c.configured ? 'pending' : 'failed', errorMessage: c.configured ? null : '尚未配置此来源的有效凭据', lastErrorCategory: c.configured ? null : 'CREDENTIAL_MISSING', finishedAt: c.configured ? null : new Date(), requestPayload: { settlementMonth: input } } });
      }
      return { batchId: batch.id, reused: false };
    });
  }

  async saveSubId(input: string, rowKey: string, subId: string, actor: Actor) {
    if (typeof subId !== 'string' || !subId.trim() || subId.length > 255) throw new AppError(ERROR_CODES.VALIDATION_ERROR, '请填写统一 SUB ID。');
    return this.write(parseSettlementMonthParam(input), actor, 'monthly_finance.sub_id', async tx => {
      const before = await tx.employee.findUnique({ where: { id: rowKey } });
      if (!before) throw new AppError(ERROR_CODES.NOT_FOUND, '未找到归属记录。');
      await tx.employee.update({ where: { id: rowKey }, data: { businessSubId: subId.trim() } });
      return { saved: true, previousSubId: before.businessSubId, subId: subId.trim() };
    });
  }

  private async write<T>(month: Date, actor: Actor, action: string, operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`monthly-finance:${month.toISOString()}`}, 0))`;
      const locked = await tx.monthlySettlement.findUnique({ where: { settlementMonth: month } });
      if (locked?.status === 'locked') throw new AppError(ERROR_CODES.MONTH_LOCKED, '本月已锁账，不能修改或刷新。');
      const result = await operation(tx);
      await this.audit.success({ actorUserId: actor.userId, actorRole: actor.roleCode, action, objectType: 'monthly_finance', settlementMonth: month, afterData: result, changedFields: [action] }, tx);
      return result;
    });
  }
}

function decimal(value: unknown, max: number) {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,6})?$/.test(value) || D(value).gt(max)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, '请填写有效非负金额或费率，最多六位小数；0 合法，空值不合法。');
  return D(value);
}
