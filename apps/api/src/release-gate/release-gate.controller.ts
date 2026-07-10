import { Controller, Get, Post } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { ReleaseGateService } from './release-gate.service';

@Controller('release-gate')
export class ReleaseGateController {
  constructor(private readonly releaseGate: ReleaseGateService) {}

  @Get()
  @RequirePermissions('release_gate.read')
  getReleaseGate() {
    return this.releaseGate.getReleaseGate();
  }

  @Post('run')
  @RequirePermissions('release_gate.run')
  runReleaseGate(@CurrentActor() actor: Actor) {
    return this.releaseGate.runReleaseGate(actor);
  }
}
