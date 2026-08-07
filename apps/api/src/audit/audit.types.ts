import { AuditResult } from '@prisma/client';

export type AuditContext = {
  actorUserId?: string;
  actorRole?: string;
  ipAddress?: string;
  userAgent?: string;
};

export type AuditWriteInput = AuditContext & {
  action: string;
  objectType: string;
  objectId?: string;
  settlementMonth?: Date;
  beforeData?: unknown;
  afterData?: unknown;
  changedFields?: string[];
  requestPayload?: unknown;
  result: AuditResult;
  failureReason?: string;
  errorMessage?: string;
};

export type SettlementPreflightAuditSnapshot = {
  settlementMonth: string;
  severity: 'ok' | 'warning';
  canGenerate: boolean;
  checks: Array<{
    code: string;
    severity: string;
    message: string;
    count?: number;
    amountUsd?: string;
  }>;
  summary: {
    openUnmatchedEventCount: number;
    missingProviderFeeRateCount: number;
    missingExchangeRate: boolean;
    draftManualRecordCount: number;
    runningOrPendingSyncTaskCount: number;
    staleCakeAdjustmentCount: number;
    isLocked: boolean;
  };
  acknowledgedWarningCodes: string[];
};
