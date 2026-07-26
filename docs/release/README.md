# Release Documentation

This directory contains the human approval and production operations documents for gated releases.

## Current Production Archive Status

- Production status: **Full Go stable with accepted backup risk**
- Final release gate: **`37 pass / 0 warning / 0 fail`**, exit=`0`
- Known accepted risk: **off-host backup is not configured**; this risk is accepted for the current stage but is not resolved
- Authorized RC: `rc-20260712-2` at `9f8f8f576dde54355983b96525335e94c55c8b32`

Earlier No-Go, Conditional Go, Full Go, and Full Go Regression statements in the approval and monitoring records are chronological history. The Task 86 stable closeout is authoritative.

## GitHub Actions Fixture Boundary

The `release-preflight` GitHub Actions workflow uses synthetic, explicitly marked fixtures in an ephemeral CI database so that the code path and release-gate chain can be exercised from a clean checkout. Every such artifact includes `ci-fixture-context.json` and `CI-FIXTURE-NOTICE.md` with `fixtureOnly: true` and `productionEvidence: false`.

CI fixture artifacts are not evidence of a production backup, production restore drill, production database state, or production readiness. Release approval still requires separate environment-specific evidence from the intended deployment environment.

## Recommended Reading Order

1. `production-approval-record.md` - read the chronological approval history and Task 86 authoritative final decision.
2. `post-go-monitoring-report.md` - read the T+24 warning history and stable closeout.
3. `../operations/production-handoff.md` - use for the current operating state, ownership, and technical debt.
4. `../operations/production-runbook.md` - use for read-only production monitoring rules.
5. `release-candidate.md` - verify the frozen commit/tag and the commit-bound CI artifact.
6. `release-approval-pack.md` - review the original approval package and Go / No-Go criteria.

## Documents

| Document | Use case |
| --- | --- |
| [Production Approval Record](production-approval-record.md) | Chronological Tasks 74–86 approval evidence and authoritative stable closeout. |
| [Post-Go Monitoring Report](post-go-monitoring-report.md) | T+24 observations, historical regression, and Task 86 stable closeout. |
| [Production Handoff](../operations/production-handoff.md) | Current production state, ownership, evidence references, and technical debt. |
| [Read-Only Production Runbook](../operations/production-runbook.md) | Monitoring boundaries, acceptance checks, incident handling, and recurring controls. |
| [Release Candidate](release-candidate.md) | Frozen commit/tag identity, CI run and artifact binding, and artifact acceptance criteria. |
| [Release Approval Pack](release-approval-pack.md) | Human approval package built from release evidence and release gate outputs. |
| [Production Runbook](production-runbook.md) | Production execution procedure with environment, commands, success standards, and failure handling. |
| [Rollback Plan](rollback-plan.md) | Application rollback, database rollback, backup restore, and post-rollback review procedure. |
| [Post-Release Checklist](post-release-checklist.md) | T+0, T+30 minutes, T+2 hours, and T+24 hours observation checklist. |

## Follow-up Technical Debt

1. Configure and verify off-host backups.
2. Run regular isolated restore drills and retain current evidence.
3. Run and archive the release gate on a recurring cadence.
4. Establish the long-term operations alerting and escalation SOP.
5. Perform periodic, minimum-scope production audit sampling with redacted evidence only.

## Required Pre-Release Commands

Run these commands before release approval. For production approval, prefer CI artifacts from the exact release commit.

| Command | Running environment | Purpose | Required result |
| --- | --- | --- | --- |
| `pnpm release:preflight` | Local release workstation or CI | Runs install, migration status, env check, tests, build, E2E permissions, audit export smoke, and release check. | Exit code `0`; evidence artifacts generated in `tmp/release-evidence`. |
| `pnpm release:check` | Local release workstation, CI, or production release-check environment | Evaluates release gate checks. | Exit code `0`; no warning or fail for approval unless separately documented. |
| `pnpm release:report` | Local release workstation or CI | Regenerates the human-readable release evidence report and refreshes release gate JSON. | Exit code `0`; `tmp/release-evidence/release-evidence.md` is current. |

## Evidence Files

The current evidence bundle is expected under `tmp/release-evidence`:

| Evidence | Purpose |
| --- | --- |
| `release-evidence.md` | Human-readable release report. |
| `release-evidence.json` | Structured preflight result. |
| `release-gate.json` | Structured release gate checks and summary. |
| `migration-status.json` | Prisma validate, generate, and migrate status evidence. |
| `env-check.json` | Runtime and environment validation evidence. |
| `e2e-permissions.json` | Permission regression evidence. |
| `audit-export-smoke.json` | Audit export smoke evidence. |

Local evidence with `branch=local` or `runId=local` is not enough to prove a production release. The final Go decision must use the CI artifact or another auditable artifact tied to the exact production release version.
