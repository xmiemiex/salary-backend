import { Provider, SyncExecutionErrorCategory, SyncTaskPlatform, SyncTaskSourceType, SyncTaskType } from '@prisma/client';

export const SYNC_ADAPTER_NOT_IMPLEMENTED_ERROR = '真实同步适配器未实现，未拉取任何第三方数据。';

export type SyncAdapterContext = {
  taskId: string;
  sourceType: SyncTaskSourceType;
  taskType: SyncTaskType;
  platform?: SyncTaskPlatform;
  provider?: Provider;
  settlementMonth: Date;
  affiliateAccountId?: string;
  affiliateAccountCode?: string;
  requestedBy?: string | null;
  requestPayload?: unknown;
  credential: {
    credentialId: string;
    hasCredential: true;
    maskedPayload: unknown;
    payload?: unknown;
  };
};

export type SyncAdapterResult = {
  status: 'completed' | 'failed';
  successCount: number;
  failedCount: number;
  message: string | null;
  errorMessage: string | null;
  resultPayload: Record<string, unknown>;
  errorCategory?: SyncExecutionErrorCategory;
};

export interface SyncAdapter {
  readonly adapterKey: string;
  execute(context: SyncAdapterContext): Promise<SyncAdapterResult>;
}

export function notImplementedResult(adapterKey: string): SyncAdapterResult {
  return {
    status: 'failed',
    successCount: 0,
    failedCount: 1,
    message: null,
    errorMessage: SYNC_ADAPTER_NOT_IMPLEMENTED_ERROR,
    resultPayload: {
      adapterKey,
      implemented: false,
      pulledThirdPartyData: false,
    },
  };
}
