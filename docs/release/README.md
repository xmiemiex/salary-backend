# Release Documentation

This directory contains the human approval and production operations documents for gated releases.

## Recommended Reading Order

1. `release-candidate.md` - verify the frozen commit/tag and the commit-bound CI artifact before approval.
2. `release-approval-pack.md` - review evidence summary, preconditions, approver checklist, risks, and Go / No-Go criteria.
3. `production-runbook.md` - use after approval to execute the production release step by step.
4. `rollback-plan.md` - review before deployment and keep open during the release window.
5. `post-release-checklist.md` - use immediately after deployment through T+24 hours.

## Documents

| Document | Use case |
| --- | --- |
| [Release Candidate](release-candidate.md) | Frozen commit/tag identity, CI run and artifact binding, and artifact acceptance criteria. |
| [Release Approval Pack](release-approval-pack.md) | Human approval package built from release evidence and release gate outputs. |
| [Production Runbook](production-runbook.md) | Production execution procedure with environment, commands, success standards, and failure handling. |
| [Rollback Plan](rollback-plan.md) | Application rollback, database rollback, backup restore, and post-rollback review procedure. |
| [Post-Release Checklist](post-release-checklist.md) | T+0, T+30 minutes, T+2 hours, and T+24 hours observation checklist. |

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
