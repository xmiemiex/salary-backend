# Production Runbook

This runbook turns approved release evidence into production actions. It does not replace human approval and does not permit release gate bypasses.

## Release Inputs

| Input | Current local evidence |
| --- | --- |
| Evidence report | `tmp/release-evidence/release-evidence.md` |
| Release evidence JSON | `tmp/release-evidence/release-evidence.json` |
| Release gate JSON | `tmp/release-evidence/release-gate.json` |
| Migration status | `tmp/release-evidence/migration-status.json` |
| Env check | `tmp/release-evidence/env-check.json` |
| E2E permissions | `tmp/release-evidence/e2e-permissions.json` |
| Audit export smoke | `tmp/release-evidence/audit-export-smoke.json` |
| Current local result | `pnpm release:preflight` pass; `pnpm release:check` pass with `pass=37 warning=0 fail=0` |

For production, replace local evidence with CI artifact evidence from the exact release commit before executing deployment.

## T-24 Hours Checks

| Check | Running environment | Method | Success standard | Failure handling |
| --- | --- | --- | --- | --- |
| CI status | CI | Inspect `release-preflight` job for the release commit. | Job passed and artifact uploaded. | Stop release planning until CI passes on the intended commit. |
| Release evidence | CI or local release workstation | Review `tmp/release-evidence/release-evidence.md` and JSON artifacts. | Preflight, migration, env, E2E, audit export, and release gate are all pass. | Regenerate evidence from the release commit; do not approve stale or incomplete evidence. |
| Active alerts | Production monitoring | Check active critical alerts. | Critical alert count is `0`. | Resolve alerts or defer release. |
| Backup | Production backup system | Confirm latest full backup. | Latest full backup is successful and within policy window. | Run and verify a full backup before release. |
| Restore drill | Restore environment | Confirm latest restore drill record. | Latest restore drill is successful and within policy window. | Complete restore drill or defer release. |
| Database connection | Production server or database host | Run a non-secret connectivity check through approved tooling. | Database accepts connections from the production runtime. | Fix network, service, or access issue before release. |
| Production env completeness | Production server | Run `pnpm env:check` or equivalent deployment image check without printing secret values. | Required variables exist and parse correctly. | Fix environment configuration and rerun check. |
| Dependency services | Production monitoring | Check database, auth/session, scheduler, storage/export path, and observability dependencies. | All required services are healthy or within approved operating limits. | Defer release or open an incident if dependencies are unstable. |

## T-1 Hour Checks

| Check | Running environment | Method | Success standard | Failure handling |
| --- | --- | --- | --- | --- |
| Freeze window | Release coordination channel | Confirm no conflicting deploy or schema change. | Freeze is acknowledged by owners. | Delay release until conflict is removed. |
| Stakeholder notification | Release coordination channel | Notify technical, product/business, operations, and data owners. | Required owners acknowledge. | Delay release if required approver or rollback owner is absent. |
| Backup confirmation | Production backup system | Reconfirm latest full backup and checksum record. | Backup remains successful and available. | Run fresh backup or defer release. |
| Migration status | Production server | Run `pnpm release:migration-status` against production configuration. | Status is pass, pending migrations false, drift false. | Stop release and investigate drift or pending migration mismatch. |
| Release gate | Production server or CI artifact for release commit | Run `pnpm release:check` or inspect the exact CI artifact. | Required checks pass and warning/fail are zero. | Stop release unless an approved override record exists for non-required warnings. |
| Rollback owner | Release coordination channel | Confirm named rollback owner is online. | Rollback owner acknowledges and has access. | Delay release. |

## Deployment Steps

Replace placeholders such as `<release-ref>`, `<previous-release-ref>`, `<api-service>`, `<web-service>`, and `<image-tag>` with approved release identifiers. Do not paste token, password, database URL, or secret values into the runbook or release record.

| Step | Running environment | Preconditions | Command or operation | Success standard | Failure handling |
| --- | --- | --- | --- | --- | --- |
| Confirm release version | CI and release workstation | Human approval is recorded; CI artifact exists for exact commit. | `git fetch --tags` then `git checkout <release-ref>` on the release workstation, or select the approved image tag in the deployment system. | The checked-out commit or image digest matches the approved CI artifact. | Stop release if the artifact cannot be tied to the version. |
| Install dependencies or confirm image | Production build host or CI | Lockfile or image digest is approved. | Source deploy: `pnpm install --frozen-lockfile`. Image deploy: verify `<image-tag>` digest in registry. | Dependencies install cleanly, or image digest matches approval. | Stop release; do not use floating or unverified image tags. |
| Prisma validate | Production server or production build host | Production config is loaded without exposing secrets. | `pnpm prisma:validate` | Prisma schema validates. | Stop release and fix schema/config mismatch. |
| Prisma generate | Production server or production build host | `prisma validate` passed. | `pnpm prisma:generate` | Prisma client generation completes. | Stop release; do not deploy an API with stale generated client. |
| Migration deploy | Production server with database access | Backup verified; migration status checked; data owner available if applicable. | `pnpm db:migrate` | Command exits `0`; no failed migration is reported. | Stop deployment. If partial migration or data risk exists, enter rollback decision flow. |
| Migration status | Production server with database access | Migration deploy completed or no migration was needed. | `pnpm release:migration-status` | `pendingMigrations=false`, `drift=false`, status pass. | Stop release and assess rollback or hotfix. |
| Env check | Production server | Production environment is configured; no secret values are printed. | `pnpm env:check` | Status pass, missing and invalid checks are empty. | Restore previous config or fix missing variables, then rerun. |
| Build or image verification | Production build host or CI | Dependencies/image are confirmed. | Source deploy: `pnpm build`. Image deploy: run approved image verification command in deployment system. | Build succeeds or image verification passes. | Stop release and keep current production version. |
| Deploy API | Production deployment platform | Migration and env checks passed; previous API version is known. | Deploy approved API artifact or image `<image-tag>` to `<api-service>`. | API service reaches running state with expected version. | Roll back API to `<previous-release-ref>` if service fails to start. |
| Deploy Web | Production deployment platform | API deployment is healthy or compatibility is confirmed. | Deploy approved Web artifact or image `<image-tag>` to `<web-service>`. | Web service reaches running state with expected version. | Roll back Web to `<previous-release-ref>` if service fails to serve assets. |
| Start or restart services | Production server or deployment platform | API and Web artifacts are deployed. | Restart `<api-service>`, `<web-service>`, and scheduler service if applicable. | Services are running and stable. | Revert to previous version and collect service logs. |
| Health check | Production server and monitoring | Services are running. | Check API health endpoint, Web URL, database health, backup health, and system health page. | Health checks pass; no critical alert is created. | Enter rollback decision flow if health fails or critical alert appears. |
| Release gate check | Production server or CI against release environment | Services and database are healthy. | `pnpm release:check` | Exit code `0`; required checks pass; warning/fail remain `0`. | Roll back if required check fails. Investigate warnings before continuing. |
| Smoke test | Production Web and API | Release gate passed. | Admin login, permission-protected route checks, audit export smoke, and one critical business read flow. | Smoke checks pass and audit log records expected actions. | Roll back if admin, permission, sync, or audit paths fail. |

## T+30 Minutes Observation

| Area | Running environment | Method | Success standard | Failure handling |
| --- | --- | --- | --- | --- |
| API health | Production monitoring | Watch health endpoint and service metrics. | Stable success responses and no restart loop. | Roll back if unavailable or unstable. |
| Web reachability | Production browser and monitoring | Open production Web URL and key admin route. | Web loads expected version. | Roll back Web or API/Web together depending on failure. |
| Admin login | Production Web | Approved admin smoke login. | Login succeeds and audit event is written. | Roll back if authentication or authorization is broken. |
| Permission 401/403 behavior | Production logs and audit | Inspect protected route failures. | No abnormal spike or incorrect denial/allow. | Roll back if permission enforcement regresses. |
| Sync tasks | Production scheduler console | Inspect running, retry, failed, and leased jobs. | No unexpected failure spike or stuck leases. | Pause scheduler and enter rollback decision flow. |
| Active critical alerts | Production monitoring | Check active alerts. | Critical alert count remains `0`. | Roll back immediately if release-related critical alerts persist. |
| Error logs | Production logging | Review API, Web, scheduler, and database errors. | No new high-severity recurring errors. | Roll back or hotfix based on severity and data risk. |
| Audit logs | Production admin audit page | Confirm release and smoke actions were logged. | Expected audit entries exist. | Roll back if audit write path is broken. |
| Backup health | Production backup system | Check backup health indicator. | Backup health is not critical. | Stop further changes and resolve backup risk. |
| System health | Production admin system health | Inspect system health page. | No critical health item. | Roll back if release introduced critical state. |

## T+24 Hours Observation

| Area | Running environment | Method | Success standard | Failure handling |
| --- | --- | --- | --- | --- |
| Key business flows | Production Web/API | Review agreed workflow smoke evidence and support tickets. | No release-related blocker. | Open incident and decide hotfix or rollback. |
| Sync success rate | Production scheduler console | Compare success/failure trend before and after release. | Failure rate remains within normal range. | Pause scheduler if data integrity is at risk. |
| Retry/fail queues | Production database or scheduler UI | Inspect retry and failed queues. | No abnormal growth. | Investigate failed jobs and consider rollback if release-caused. |
| Admin operation audit | Production audit page | Review admin actions and permission denials. | Expected actions are logged; no suspicious spike. | Escalate and roll back if permission model is compromised. |
| Data growth anomalies | Production database metrics | Compare table growth and key counters. | No unexpected growth or deletion pattern. | Stop automation and enter data rollback assessment. |
| Alert trend | Production monitoring | Compare warning and critical trend. | No upward release-related trend. | Open incident and assign owner. |
| Backup schedule | Production backup system | Confirm scheduled backup after release. | Backup continues to succeed. | Fix backup before further deployments. |
