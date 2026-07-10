import { Injectable } from '@nestjs/common';
import { notImplementedResult, SyncAdapter, SyncAdapterContext, SyncAdapterResult } from './sync-adapter';

@Injectable()
export class AirwallexCardSyncAdapterStub implements SyncAdapter {
  readonly adapterKey = 'card_spend.airwallex.stub';

  async execute(_context: SyncAdapterContext): Promise<SyncAdapterResult> {
    return notImplementedResult(this.adapterKey);
  }
}
