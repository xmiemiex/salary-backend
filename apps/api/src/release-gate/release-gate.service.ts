import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../auth/auth.types';
import { BackupHealthService } from '../backup-recovery/backup-health.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemHealthService } from '../system-health/system-health.service';
import { ReleaseGateChecker } from './release-gate.checker';
import { containsSensitiveReleaseGateField } from './release-gate-sanitizer';
import { ReleaseGateResponse } from './release-gate.types';

@Injectable()
export class ReleaseGateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly systemHealth: SystemHealthService,
    private readonly backupHealth: BackupHealthService,
  ) {}

  getReleaseGate(): Promise<ReleaseGateResponse> {
    return this.checker().run();
  }

  async runReleaseGate(actor: Actor): Promise<ReleaseGateResponse> {
    try {
      const result = await this.checker().run();
      await this.audit.success({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: 'release_gate.run',
        objectType: 'release_gate',
        requestPayload: auditPayload(result),
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });
      return result;
    } catch (error) {
      await this.audit.failure({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: 'release_gate.run_failed',
        objectType: 'release_gate',
        requestPayload: { reason: 'release_gate_failed', timestamp: new Date().toISOString() },
        failureReason: 'RELEASE_GATE_FAILED',
        errorMessage: error instanceof Error ? error.message : 'Release gate failed.',
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      }).catch(() => undefined);
      throw error;
    }
  }

  private checker() {
    return new ReleaseGateChecker({
      prisma: this.prisma,
      getSystemHealth: (now) => this.systemHealth.getSystemHealth(now),
      getBackupHealth: (now) => this.backupHealth.getHealth(now),
    });
  }
}

function auditPayload(result: ReleaseGateResponse) {
  const payload = {
    status: result.status,
    summary: result.summary,
    failedCheckCodes: result.checks.filter((item) => item.status === 'fail').map((item) => item.code),
    warningCheckCodes: result.checks.filter((item) => item.status === 'warning').map((item) => item.code),
    timestamp: result.generatedAt,
  };
  if (containsSensitiveReleaseGateField(payload)) return { status: result.status, summary: result.summary, redacted: true };
  return payload;
}
