import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { HealthService } from './health.service';

type StatusResponse = { status(code: number): unknown };

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  live() {
    return { status: 'ok' } as const;
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: StatusResponse) {
    const ready = await this.health.isDatabaseReady();
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ready' : 'not_ready' } as const;
  }
}
