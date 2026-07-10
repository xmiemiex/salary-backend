import { Controller, Get } from '@nestjs/common';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { SystemHealthService } from './system-health.service';

@Controller('system-health')
@RequirePermissions('system_health.read')
export class SystemHealthController {
  constructor(private readonly systemHealth: SystemHealthService) {}

  @Get()
  getSystemHealth() {
    return this.systemHealth.getSystemHealth();
  }

  @Get('summary')
  getSummary() {
    return this.systemHealth.getSystemHealth();
  }

  @Get('checks')
  async getChecks() {
    const result = await this.systemHealth.getSystemHealth();
    return { status: result.status, generatedAt: result.generatedAt, checks: result.checks };
  }
}
