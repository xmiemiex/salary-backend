import { safeJsonText } from './data-sync-utils';

export type PreflightSeverity = 'ok' | 'warning' | 'blocking';

export type SettlementPrecheckFailure = {
  kind: 'blocking';
  settlementMonth?: string;
  severity?: string;
  blockingChecks: Array<{ code: string; message: string }>;
};

export type SettlementWarningAckFailure = {
  kind: 'warningAck';
  settlementMonth?: string;
  requiredWarningCodes: string[];
  acknowledgedWarningCodes: string[];
  missingWarningCodes: string[];
  unknownWarningCodes: string[];
};

export type SettlementGenerateRejection = SettlementPrecheckFailure | SettlementWarningAckFailure;

type ErrorWithCode = Error & {
  code?: unknown;
  details?: unknown;
};

export function parseSettlementPrecheckFailure(error: unknown): SettlementPrecheckFailure | null {
  if (!(error instanceof Error) || (error as ErrorWithCode).code !== 'SETTLEMENT_PRECHECK_FAILED') {
    return null;
  }

  const details = (error as ErrorWithCode).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return { kind: 'blocking', blockingChecks: [] };
  }

  const source = details as Record<string, unknown>;
  const result: SettlementPrecheckFailure = { kind: 'blocking', blockingChecks: [] };
  if (typeof source.settlementMonth === 'string') result.settlementMonth = source.settlementMonth;
  if (typeof source.severity === 'string') result.severity = source.severity;
  if (Array.isArray(source.blockingChecks)) {
    result.blockingChecks = source.blockingChecks.flatMap((check) => {
      if (!check || typeof check !== 'object' || Array.isArray(check)) return [];
      const candidate = check as Record<string, unknown>;
      if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') return [];
      return [{ code: candidate.code, message: candidate.message }];
    });
  }

  return result;
}

function stringArrayField(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function parseSettlementWarningAckFailure(error: unknown): SettlementWarningAckFailure | null {
  if (!(error instanceof Error) || (error as ErrorWithCode).code !== 'SETTLEMENT_WARNING_ACK_REQUIRED') {
    return null;
  }
  const details = (error as ErrorWithCode).details;
  const source = details && typeof details === 'object' && !Array.isArray(details)
    ? details as Record<string, unknown>
    : {};
  return {
    kind: 'warningAck',
    settlementMonth: typeof source.settlementMonth === 'string' ? source.settlementMonth : undefined,
    requiredWarningCodes: stringArrayField(source, 'requiredWarningCodes'),
    acknowledgedWarningCodes: stringArrayField(source, 'acknowledgedWarningCodes'),
    missingWarningCodes: stringArrayField(source, 'missingWarningCodes'),
    unknownWarningCodes: stringArrayField(source, 'unknownWarningCodes'),
  };
}

export async function handleSettlementPrecheckFailure(
  error: unknown,
  onRejected: (failure: SettlementGenerateRejection) => void,
  refreshPreflight: () => Promise<void>,
): Promise<boolean> {
  const failure = parseSettlementPrecheckFailure(error) ?? parseSettlementWarningAckFailure(error);
  if (!failure) return false;
  onRejected(failure);
  await refreshPreflight();
  return true;
}

export type WarningAcknowledgement = { settlementMonth: string; codes: string[] };

export function currentWarningCodes(preflight: SettlementPreflightResult | null | undefined): string[] {
  return preflight?.checks.filter((check) => check.severity === 'warning').map((check) => check.code) ?? [];
}

export function isWarningAcknowledgementCurrent(
  acknowledgement: WarningAcknowledgement | null | undefined,
  settlementMonth: string,
  preflight: SettlementPreflightResult | null | undefined,
): boolean {
  if (!acknowledgement || acknowledgement.settlementMonth !== settlementMonth) return false;
  const codes = currentWarningCodes(preflight);
  return codes.length === acknowledgement.codes.length
    && codes.every((code) => acknowledgement.codes.includes(code));
}

export function buildSettlementGenerateBody(
  attendanceByEmployeeId: Record<string, string>,
  acknowledgement: WarningAcknowledgement | null | undefined,
  settlementMonth: string,
  preflight: SettlementPreflightResult | null | undefined,
): { attendanceByEmployeeId: Record<string, string>; acknowledgedWarningCodes?: string[] } {
  if (isWarningAcknowledgementCurrent(acknowledgement, settlementMonth, preflight)) {
    return { attendanceByEmployeeId, acknowledgedWarningCodes: [...acknowledgement!.codes] };
  }
  return { attendanceByEmployeeId };
}

export type SettlementPreflightCheck = {
  code: string;
  severity: PreflightSeverity;
  message: string;
  count?: number;
  amountUsd?: string;
  details?: Record<string, unknown>;
};

export type SettlementPreflightResult = {
  settlementMonth: string;
  canGenerate: boolean;
  severity: PreflightSeverity;
  checks: SettlementPreflightCheck[];
  summary: {
    openUnmatchedEventCount: number;
    missingProviderFeeRateCount: number;
    missingExchangeRate: boolean;
    draftManualRecordCount: number;
    runningOrPendingSyncTaskCount: number;
    isLocked: boolean;
  };
};

export type GenerateGateInput = {
  hasGeneratePermission: boolean;
  isLocked: boolean;
  settlementMonth: string;
  preflight?: Pick<SettlementPreflightResult, 'settlementMonth' | 'canGenerate' | 'severity'> | null;
};

export type PreflightRequestToken = {
  requestId: number;
  settlementMonth: string;
};

export function createLatestPreflightRequestGuard(getCurrentMonth: () => string) {
  let latestRequestId = 0;

  return {
    begin(settlementMonth: string): PreflightRequestToken {
      latestRequestId += 1;
      return { requestId: latestRequestId, settlementMonth };
    },
    invalidate(): void {
      latestRequestId += 1;
    },
    isCurrent(token: PreflightRequestToken): boolean {
      return token.requestId === latestRequestId && token.settlementMonth === getCurrentMonth();
    },
  };
}

export function isPreflightForMonth(
  preflight: Pick<SettlementPreflightResult, 'settlementMonth'> | null | undefined,
  settlementMonth: string,
): boolean {
  const preflightMonth = preflight?.settlementMonth;
  return preflightMonth === settlementMonth || preflightMonth === `${settlementMonth}-01`;
}

export type PreflightSummaryItem = {
  key: keyof SettlementPreflightResult['summary'];
  label: string;
  value: string;
};

export function isGenerateDisabled(input: GenerateGateInput): boolean {
  return Boolean(getGenerateDisabledReason(input));
}

export function getGenerateDisabledReason(input: GenerateGateInput): string | null {
  if (!input.hasGeneratePermission) return '当前用户没有生成工资权限。';
  if (input.isLocked) return '该结算月份已锁账，不能生成工资。';
  if (!input.preflight) return 'preflight 检查尚未完成。';
  if (!isPreflightForMonth(input.preflight, input.settlementMonth)) return '当前月份的 preflight 检查尚未完成。';
  if (!input.preflight.canGenerate) return 'preflight 检查未通过，不能生成工资。';
  if (input.preflight.severity === 'blocking') return 'preflight 存在 blocking 项，不能生成工资。';
  return null;
}

export function shouldConfirmWarningGenerate(
  preflight?: Pick<SettlementPreflightResult, 'canGenerate' | 'severity'> | null,
): boolean {
  return Boolean(preflight?.canGenerate && preflight.severity === 'warning');
}

export function formatPreflightSeverity(severity: PreflightSeverity | undefined): string {
  if (severity === 'ok') return 'ok';
  if (severity === 'warning') return 'warning';
  if (severity === 'blocking') return 'blocking';
  return '-';
}

export function preflightSeverityColor(severity: PreflightSeverity | undefined): string {
  if (severity === 'ok') return 'green';
  if (severity === 'warning') return 'orange';
  if (severity === 'blocking') return 'red';
  return 'default';
}

export function preflightAlertType(severity: PreflightSeverity | undefined): 'success' | 'warning' | 'error' | 'info' {
  if (severity === 'ok') return 'success';
  if (severity === 'warning') return 'warning';
  if (severity === 'blocking') return 'error';
  return 'info';
}

export function formatBoolean(value: boolean): string {
  return value ? '是' : '否';
}

export function formatPreflightSummary(summary: SettlementPreflightResult['summary']): PreflightSummaryItem[] {
  return [
    { key: 'openUnmatchedEventCount', label: '未匹配事件', value: String(summary.openUnmatchedEventCount) },
    { key: 'missingProviderFeeRateCount', label: '缺失服务商费率', value: String(summary.missingProviderFeeRateCount) },
    { key: 'missingExchangeRate', label: '缺失汇率', value: formatBoolean(summary.missingExchangeRate) },
    { key: 'draftManualRecordCount', label: '草稿手工数据', value: String(summary.draftManualRecordCount) },
    { key: 'runningOrPendingSyncTaskCount', label: '执行中/待执行同步', value: String(summary.runningOrPendingSyncTaskCount) },
    { key: 'isLocked', label: '已锁账', value: formatBoolean(summary.isLocked) },
  ];
}

export function formatPreflightDetails(details: unknown): string {
  if (details === null || details === undefined || details === '') return '-';
  return safeJsonText(details);
}
