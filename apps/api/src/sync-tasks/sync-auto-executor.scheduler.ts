import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { readSyncAutoExecutionConfig } from './sync-auto-execution-config';
import { SyncAutoExecutionService } from './sync-auto-execution.service';

@Injectable()
export class SyncAutoExecutorScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SyncAutoExecutorScheduler.name);
  private readonly config = readSyncAutoExecutionConfig();
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private inFlight: Promise<unknown> | null = null;

  constructor(private readonly execution: SyncAutoExecutionService) {}

  onApplicationBootstrap() {
    if (!this.config.enabled) return;
    this.run();
    this.timer = setInterval(() => this.run(), this.config.pollSeconds * 1000);
    this.timer.unref();
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.inFlight?.catch(() => undefined);
  }

  private run() {
    if (this.stopping || this.inFlight) return;
    this.inFlight = this.execution.poll().catch(() => this.logger.error('Automatic sync execution poll failed.')).finally(() => { this.inFlight = null; });
  }
}
