# Rollback Plan

Rollback protects service availability and data integrity after an approved production release. Use this plan when the release gate, smoke tests, monitoring, or business checks show release-caused failure.

## Rollback Triggers

| Trigger | Immediate action |
| --- | --- |
| Service unavailable | Start rollback decision flow immediately. |
| `pnpm release:check` fails in production | Roll back unless the failure is proven unrelated and approved by the release owner and technical lead. |
| Migration failure or drift | Stop deployment and involve the data owner before any further database action. |
| Permission system abnormality | Roll back API/Web if admin login, role enforcement, or protected routes are broken. |
| Data sync abnormality | Pause scheduler and assess data impact before continuing. |
| Critical alerts persist | Roll back if critical alerts remain active after first-line restart/config correction. |
| Data integrity risk | Stop automation and decide database restore or targeted repair with data owner approval. |

## Rollback Decision Flow

| Decision point | Rule |
| --- | --- |
| Decision owner | Operations or release owner decides rollback with technical lead input. Data owner approval is required for database restore or data repair. |
| Decision time limit | For service unavailability, decide within `10` minutes. For permission, sync, or audit failures, decide within `15` minutes. For confirmed data integrity risk, decide immediately. |
| Must roll back immediately | Production API/Web unavailable, release gate required check fails, admin access is broadly broken, migration leaves service unable to start, critical alerts persist, or data integrity is actively at risk. |
| Hotfix may be considered | Narrow non-critical UI issue, documentation-only mismatch, known external dependency incident, or isolated warning with no required gate failure and no data risk. |

## Application Rollback Steps

| Step | Running environment | Preconditions | Command or operation | Success standard | Failure handling |
| --- | --- | --- | --- | --- | --- |
| Freeze new changes | Release coordination channel | Rollback trigger is declared. | Announce rollback and block unrelated deploys. | All owners acknowledge freeze. | Escalate to incident owner if changes continue. |
| Pause scheduler | Production server or scheduler platform | Sync or data risk is possible. | Disable or pause sync planner and auto execution through approved operations control. | No new sync jobs start; in-flight jobs are known. | Stop workers if pause control fails. |
| API rollback | Production deployment platform | Previous approved API version is known. | Redeploy previous API artifact or image `<previous-release-ref>` to `<api-service>`. | API starts and health endpoint passes. | Escalate to infrastructure owner and keep scheduler paused. |
| Web rollback | Production deployment platform | Previous approved Web version is known. | Redeploy previous Web artifact or image `<previous-release-ref>` to `<web-service>`. | Web loads previous version and key routes are reachable. | Serve maintenance page if Web cannot recover quickly. |
| Configuration rollback | Production configuration system | Previous approved config snapshot exists. | Restore previous non-secret config values through approved configuration management. | `pnpm env:check` passes and services restart cleanly. | Escalate if config drift cannot be determined. |
| Restart services | Production server or deployment platform | API/Web/config rollback is complete. | Restart `<api-service>`, `<web-service>`, scheduler if appropriate. | Services are stable with previous version. | Keep scheduler paused and continue incident handling. |
| Post-rollback health check | Production server and monitoring | Services are restarted. | Run health checks, `pnpm release:check`, admin login smoke, permission route smoke, and audit log check. | Required checks pass and critical alerts are zero. | Move to database restore or incident mitigation if app rollback is insufficient. |
| Resume scheduler | Production scheduler platform | Data owner and technical lead confirm no data risk. | Resume scheduler controls. | Queue processing returns to normal. | Keep paused and create repair plan. |

## Database Rollback Strategy

| Case | Strategy |
| --- | --- |
| Reversible migration | Use the documented reverse operation only if it has been reviewed, tested on a restored copy, and approved by the data owner. Prisma migrate deploy does not provide automatic down migrations; do not improvise destructive SQL in production. |
| Irreversible migration | Do not attempt ad hoc reversal. Decide between forward hotfix, targeted repair, or backup restore based on data impact. |
| Migration already executed | Inspect migration name, execution time, changed tables, application compatibility, and whether data was transformed or deleted. Verify on a temporary restored database before touching production data. |
| Backup restore required | Use backup restore when data loss, destructive transformation, or unknown corruption cannot be corrected safely in place. |
| Before restoring production | Confirm business approval, data owner approval, recovery point objective impact, affected writes since backup, downtime window, checksum, and temporary restore validation. |
| After restore | Run migration status, release gate, smoke tests, audit log checks, sync queue checks, and data consistency verification before reopening traffic. |

## Backup Restore Steps

| Step | Running environment | Preconditions | Command or operation | Success standard | Failure handling |
| --- | --- | --- | --- | --- | --- |
| Select full backup | Production backup system | Restore decision approved. | Select the latest successful full backup that matches approved recovery point. | Backup metadata and timestamp are recorded. | Escalate if no valid backup exists. |
| Verify checksum | Backup host | Backup file is available. | Run approved checksum verification for the backup artifact. | Checksum matches recorded value. | Do not restore; select another backup or escalate. |
| Restore to temporary database | Database host or restore environment | Temporary target is isolated from production traffic. | Restore backup into a temporary database using approved restore tooling. | Restore completes and database opens for validation. | Stop and escalate to backup owner. |
| Validate temporary restore | Temporary database and application test host | Temporary database is restored. | Run schema checks, key table counts, release gate where applicable, and data-owner validation queries. | Data appears consistent and expected recovery point is confirmed. | Select another backup or create repair plan. |
| Restore production if required | Database host | Production restore approved; traffic is stopped or maintenance mode is enabled. | Restore validated backup to production using approved operations procedure. | Production database starts and passes consistency checks. | Keep production closed and escalate incident. |
| Verify after restore | Production server | Production database is restored. | Run `pnpm release:migration-status`, `pnpm release:check`, admin smoke, permission smoke, audit smoke, and sync queue check. | Checks pass and critical alerts are zero. | Continue incident response; do not resume release. |

## Post-Rollback Review Materials

The rollback record must include:

1. Timeline from deployment start through rollback completion.
2. Impacted users, services, data domains, and time window.
3. Root cause or current best-known cause.
4. Actions taken, owners, command records, and decision timestamps.
5. Data consistency proof, including backup or validation evidence.
6. Follow-up fixes, release gate improvements, test additions, and owner deadlines.
