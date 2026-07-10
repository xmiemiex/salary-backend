# Release Approval Pack

## Current Approval Status

**No-Go: waiting for a CI artifact bound to an exact candidate commit.** The current workspace has no verifiable Git identity, and the available evidence records `commit=null`, `branch=local`, and `runId=local`. See `release-candidate.md` for the recovery, freeze, CI trigger, and artifact acceptance procedure.

## Evidence Summary

This approval pack is based on the local release evidence currently stored under `tmp/release-evidence`.

| Item | Current evidence |
| --- | --- |
| Evidence generated at | `2026-07-10T06:18:21.609Z` in `tmp/release-evidence/release-evidence.md` |
| Preflight command | `pnpm release:preflight` |
| Preflight status | `pass`, exit code `0` |
| Commit / branch / runId | `commit=null`, `branch=local`, `runId=local` in `release-evidence.json`; no CI commit binding is present in this local artifact |
| Release gate | `pass` in `release-gate.json` |
| Required checks | `37` checks passed, `warning=0`, `fail=0` |
| E2E permissions | `pass`, `17/17` checks passed, cleanup reports `remaining test records = 0` |
| Env check | `pass`, `16` total checks, missing `0`, invalid `0` |
| Migration status | `pass`, pending migrations `false`, drift `false`, schema parse error `false` |
| Audit export smoke | `pass`, exported count `1` |

The local evidence is approval input only. Production release is not complete until the approved version is deployed, production checks pass, and the post-release observation windows are complete.

## Release Summary

| Field | Value |
| --- | --- |
| Release goal | Promote the current gated build through human approval into a controlled production release. |
| Release scope | Release-gate evidence review, production deployment execution, rollback readiness, and post-release observation for the salary settlement admin system. |
| Out of scope | Business feature changes, release gate weakening, schema or migration additions, credential changes, and declaring production complete from local-only evidence. |
| Current evidence time | `2026-07-10T06:18:21.609Z` from `tmp/release-evidence/release-evidence.md`. |
| Current release gate result | `pass=37 warning=0 fail=0` from `tmp/release-evidence/release-gate.json`. |

## Approval Preconditions

All preconditions must be true before the release can be approved.

| Preconditions | Required evidence | Pass rule |
| --- | --- | --- |
| CI `release-preflight` must pass | GitHub Actions job `release-preflight` from `.github/workflows/release-preflight.yml` | Job status is successful for the exact release commit. |
| Release preflight artifact must exist | CI `release-evidence` artifact generated for the exact frozen candidate commit | `status=pass`, `exitCode=0`, the artifact set is complete, and its commit exactly equals the candidate commit. Local artifacts are not acceptable for final approval. |
| Latest full backup must succeed | `release-gate.json` check `RECENT_FULL_BACKUP_WITHIN_72H` and backup operations record | Check passes and backup is restorable by policy. |
| Latest restore drill must succeed | `release-gate.json` check `RECENT_RESTORE_DRILL_WITHIN_90D` and restore-drill record | Check passes and drill has no unresolved blocker. |
| Active critical alerts must be zero | `release-gate.json` check `ACTIVE_CRITICAL_ALERTS_ZERO` | `activeCriticalAlertCount=0`. |
| Migration pending/drift must be false | `migration-status.json` and release gate check `MIGRATIONS_UP_TO_DATE` | `pendingMigrations=false`, `drift=false`, and migrate status passes. |
| E2E permissions regression must pass | `e2e-permissions.json` | `status=pass`, `failed=0`, cleanup residue is zero. |
| Env check must pass | `env-check.json` | `status=pass`, missing and invalid arrays are empty. |
| Audit export smoke must pass | `audit-export-smoke.json` | `status=pass` and exported CSV is non-empty. |

If the approval is based on CI, use the CI artifact generated from the exact commit to be released. The current local artifact has `branch=local` and `runId=local`, so it is insufficient by itself for a production Go decision.

## Approver Checklist

| Approver | Must review | Approval focus |
| --- | --- | --- |
| Technical lead | `release-evidence.md`, `release-gate.json`, `.github/workflows/release-preflight.yml`, `package.json` release scripts | Required gate checks are intact, CI uses `pnpm release:preflight`, no required check is bypassed, release commit is identifiable. |
| Product or business owner | Release summary, out-of-scope list, post-release checklist | Business impact is acceptable, release window is approved, smoke scope covers critical workflows. |
| Operations or release owner | `production-runbook.md`, `rollback-plan.md`, backup and restore drill records | Execution steps are staffed, rollback owner is online, production commands and success criteria are understood. |
| Data owner, if applicable | `migration-status.json`, backup health, restore drill, database rollback section | Pending migration and drift are false, backup/restore evidence is current, irreversible data operations are understood. |

## Release Risks

| Risk | Impact | Mitigation | Rollback strategy |
| --- | --- | --- | --- |
| Database migration risk | Schema drift, failed migration, or incompatible generated client can block API startup. | Require `prisma validate`, `prisma generate`, `prisma migrate status`, `prisma migrate deploy`, then another `migrate status` in production. | If migration has not changed data, redeploy previous API/Web and verify status. If data changed or migration is irreversible, follow backup restore decision in `rollback-plan.md`. |
| Permissions and admin functionality risk | Admin login, role routing, or protected actions may fail. | Require E2E permissions regression, admin smoke login, 401/403 monitoring, and audit log verification. | Roll back API/Web together to the previous approved version and restore previous permission config if a config-only change caused the issue. |
| Sync planner and auto execution risk | Unexpected sync jobs can modify external or internal state. | Confirm production values for sync flags before deployment and observe retry/fail queue after release. | Pause scheduler, roll back application version, then resume only after queue and lease state are verified. |
| Backup and restore risk | Rollback may be impossible or data loss may be larger than accepted. | Require recent full backup, successful restore drill, checksum verification, and restore owner online. | Restore to a temporary database first. Restore production only after approval by release owner and data owner. |
| Audit export risk | Compliance or operational audit evidence can be unavailable. | Require audit export smoke and post-release audit export verification. | Roll back application version if export endpoint or audit write path regresses; preserve failed export logs for investigation. |
| CI and environment variable risk | CI may pass with different settings from production, or production may miss required runtime config. | Compare CI artifact to production environment checklist; run `pnpm env:check` in production without printing secret values. | Revert config to previous approved values, restart services, and rerun env check and health checks. |

## Go / No-Go Decision

### Go Conditions

Approve the release only when all items are true:

1. CI `release-preflight` passed for the exact commit selected for release.
2. `pnpm release:preflight` evidence artifact exists and contains `status=pass`.
3. `pnpm release:check` reports `pass=37 warning=0 fail=0` or a newer approved gate with no required failures and no warnings.
4. Active critical alerts are `0`.
5. Full backup and restore drill requirements are satisfied.
6. Migration pending and drift are both `false`.
7. E2E permissions, env check, and audit export smoke are all `pass`.
8. Release owner, rollback owner, and required approvers are available for the release window.

### No-Go Conditions

Do not approve if any item is true:

1. CI `release-preflight` is missing, skipped, cancelled, or failed.
2. The release evidence cannot be tied to the intended release commit.
3. Any release gate required check fails.
4. Any warning remains without explicit written approval and owner assignment.
5. Active critical alerts are greater than `0`.
6. Backup, restore drill, migration status, E2E permissions, env check, or audit export smoke is missing or failed.
7. The rollback owner is unavailable.
8. The requested release requires bypassing or weakening the release gate.

### Manual Override Policy

Manual override is not allowed by default. If an exceptional override is requested, it must include the approving technical lead, product or business owner, operations or release owner, reason, exact failed or warning checks, compensating controls, rollback decision time limit, and a permanent record in the release ticket. Required release gate failures must not be bypassed without a separate incident-level approval record.
