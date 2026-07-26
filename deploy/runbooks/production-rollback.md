# Production Rollback Runbook — Archived Source, Execution Requires Authorization

Current production status: **Full Go stable with accepted backup risk**. Final release gate: **`37 pass / 0 warning / 0 fail`**, exit=`0`. Off-host backup remains unconfigured; that risk is accepted for this stage but is not resolved.

This is the archived rollback source used during Tasks 77–86. It does not authorize container, Nginx, environment, migration, database, or traffic changes. Every future execution requires separate approval.

## Trigger and authority

Rollback candidates include sustained API/Web unavailability or 5xx, readiness failure, critical security/permission regression, data-integrity risk, failed/partial migration, repeated container restarts, critical alerts, or an error/latency increase beyond the approved threshold. The named rollback owner must confirm scope and choose application rollback, traffic fallback, forward fix, or separately approved database recovery.

## Application and traffic rollback

1. Freeze further deployment actions and record release identity, trigger, first-observed time, health, alerts, logs, and migration state.
2. Restore the preserved Nginx placeholder configuration or previous known-good site symlink, run `nginx -t`, then gracefully reload. This returns traffic to the prior release or explicit 503 placeholder without touching Certbot files.
3. Select the previous immutable API/Web image digests from the release inventory. Restore the previous Compose release definition and start it; never rebuild a mutable tag during an incident.
4. Restore the previous permission-restricted environment-file version only if the rollback owner confirms its compatibility. Never copy values into tickets, chat, Git, or evidence.
5. Confirm container health and host loopback endpoints before routing traffic back. If unhealthy, retain the 503 placeholder and escalate.

## Database boundary

Application rollback does not reverse Prisma migrations. Inspect the exact migration state and compatibility before starting an older API. Do not run ad hoc down SQL, `migrate resolve`, destructive DDL/DML, or assume automatic rollback.

A database restore or data repair is a distinct destructive operation. It requires separate data-owner approval, a named restore point and checksum, impact/downtime analysis, an isolated verification where possible, and an exact reviewed command plan. Prefer a reviewed forward fix when schema/data compatibility permits.

## Post-rollback verification and record

Verify API live/ready, Web health/root, both public hostnames, TLS, administrator allow/deny behavior, bounded audit export, release gate, migration status, active alerts, and database connectivity. Observe Nginx/API/Web/PostgreSQL logs, restart counts, latency, 5xx, and resource metrics for the approved period.

Record decision makers, timestamps/timezone, trigger, before/after artifact and image digests, Nginx/environment versions, migration state, redacted commands and results, smoke results, customer/data impact, residual risks, incident link, and follow-up owner. Rollback completion does not itself make the release Go.
