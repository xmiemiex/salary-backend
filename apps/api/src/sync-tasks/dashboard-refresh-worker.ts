import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { SyncAutoExecutionService } from './sync-auto-execution.service';

/** Only consumes explicitly requested persisted dashboard tasks. Never plans monthly jobs. */
@Injectable()
export class DashboardRefreshWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private work?: Promise<unknown>;
  private readonly logger = new Logger(DashboardRefreshWorker.name);
  constructor(private readonly executor: SyncAutoExecutionService) {}
  onApplicationBootstrap() {
    const run = () => {
      if (this.work) return;
      this.work = this.executor.pollDashboard().catch(() => this.logger.error('月度刷新执行器暂时不可用，持久化任务会在下次轮询恢复。')).finally(() => { this.work = undefined; });
    };
    run(); this.timer = setInterval(run, 2000); this.timer.unref();
  }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.work; await this.executor.drainDashboard(); }
}
