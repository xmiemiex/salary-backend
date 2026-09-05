import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProviderRequestError } from '../provider-request-error';
import { SyncAdapterContext } from '../sync-adapter';

export type PhotonPayPageState = {
  version: 1;
  windowIndex: number;
  nextPage: number;
  coverageStartedAt: string;
  successCount: number;
  failedCount: number;
  stats: Record<string, unknown>;
  seen: string[];
};

/** Separate from task resultPayload so large deduplication state stays out of status polling. */
export class PhotonPayPageScan {
  readonly fingerprint: string;
  constructor(private readonly db: PrismaService, private readonly context: SyncAdapterContext, scope: unknown) {
    this.fingerprint = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  }
  async load(): Promise<PhotonPayPageState | null> {
    const rows = await this.db.$queryRaw<Array<{ state: PhotonPayPageState }>>`
      SELECT state FROM provider_transaction_scans
      WHERE provider = 'photonpay' AND settlement_month = ${this.context.settlementMonth}
        AND scope_fingerprint = ${this.fingerprint}`;
    const state = rows[0]?.state;
    if (!state) return null;
    if (state.version !== 1 || !Number.isInteger(state.windowIndex) || state.windowIndex < 0
      || !Number.isInteger(state.nextPage) || state.nextPage < 1 || !Array.isArray(state.seen)
      || !state.stats || !Number.isFinite(new Date(state.coverageStartedAt).getTime())) {
      throw new ProviderRequestError('BUSINESS_REJECTED', 'PhotonPay saved page progress is invalid.');
    }
    return state;
  }
  async save(state: PhotonPayPageState) {
    await this.withLease(async tx => {
      await tx.$executeRaw`
        INSERT INTO provider_transaction_scans (provider, settlement_month, scope_fingerprint, state)
        VALUES ('photonpay', ${this.context.settlementMonth}, ${this.fingerprint}, ${JSON.stringify(state)}::jsonb)
        ON CONFLICT (provider, settlement_month) DO UPDATE
        SET scope_fingerprint = EXCLUDED.scope_fingerprint, state = EXCLUDED.state`;
    });
  }
  async clear() {
    await this.withLease(async tx => {
      await tx.$executeRaw`DELETE FROM provider_transaction_scans
        WHERE provider = 'photonpay' AND settlement_month = ${this.context.settlementMonth}
          AND scope_fingerprint = ${this.fingerprint}`;
    });
  }
  private async withLease(work: (tx: Prisma.TransactionClient) => Promise<void>) {
    await this.db.$transaction(async tx => {
      const owned = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM sync_tasks WHERE id = ${this.context.taskId}::uuid
          AND status = 'running' AND lease_owner = ${this.context.durablePageScan!.leaseOwner}
          AND attempt_count = ${this.context.durablePageScan!.attemptCount}
          AND lease_expires_at > clock_timestamp() FOR UPDATE`;
      if (!owned.length) throw new ProviderRequestError('TIMEOUT', 'PhotonPay page progress lease expired.');
      await work(tx);
    });
  }
}
