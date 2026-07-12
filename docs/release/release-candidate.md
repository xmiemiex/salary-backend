# Release Candidate

## Candidate Identity

| Field | Value |
| --- | --- |
| Planned RC tag | `rc-20260712-1` |
| CI-green code commit | `ee06c4f48bd6f3af1d28359759ecfc508b55a9b7` |
| Branch | `main` |
| Remote | `origin` (`https://github.com/xmiemiex/salary-backend.git`) |
| CI workflow | `.github/workflows/release-preflight.yml` |
| CI status | `release-preflight` green / user-confirmed |
| Release gate | `37 pass / 0 warning / 0 fail` / user-confirmed |
| CI artifact inspection | Not automatically downloaded or locally inspected; the GitHub connector has no repository access and GitHub CLI is unavailable |
| Tag status | Not created; strict freeze procedure requires CI to pass again on the documentation commit |

The repository was clean before this document update. At that point, local `HEAD`, `origin/main`, and the user-confirmed CI-green commit were identical:

```text
ee06c4f48bd6f3af1d28359759ecfc508b55a9b7
```

No local release artifact is accepted as CI evidence.

## CI Evidence Boundary

The successful `release-preflight` run and `37/0/0` release-gate result for commit `ee06c4f48bd6f3af1d28359759ecfc508b55a9b7` are recorded as user-confirmed. The private Actions artifact could not be automatically downloaded or inspected from this workspace. Artifact contents and upload completion therefore remain subject to human verification in GitHub Actions before production approval.

The CI workflow uses an explicit synthetic fixture in an ephemeral CI database:

- `fixtureOnly: true`
- `productionEvidence: false`
- CI fixture only; it exercises the code and release-gate chain.
- It is not evidence that a production backup exists.
- It is not evidence that a production restore drill was completed.
- It is not evidence of production database state or production readiness.

Production backup, restore-drill, environment, and operational evidence must be collected separately from the intended production environment.

## Included Scope

1. Task 65 release gate and production security baseline.
2. Task 66 gate remediation and data-state handling documentation.
3. Task 67 release evidence and CI preflight integration.
4. Task 68 approval package, production runbook, rollback plan, and post-release checklist.
5. Task 69 release-candidate metadata and artifact acceptance criteria.
6. Task 70 Git, GitHub, CI baseline, and explicit CI-only fixture safeguards.

## Excluded Scope

- Production deployment execution.
- Production database changes.
- Production backup creation or validation.
- Production restore drill.
- Human production approval.
- Local `tmp/release-evidence/`, `dist/`, `node_modules/`, `.env`, dump, or log files.

## Freeze Strategy and Decision

The strict strategy is selected:

1. Commit and push this release-candidate metadata update to `main`.
2. Run `release-preflight` against the resulting new `HEAD`.
3. Confirm the new run is green and its artifact is bound to that exact new commit.
4. Create annotated tag `rc-20260712-1` only on that new CI-green commit.
5. Push the tag without force.

The existing green commit remains the verified code baseline. This document-only commit changes release metadata, not business code, workflow logic, schema, or migrations.

| Decision | Status |
| --- | --- |
| RC freeze readiness | **Go** |
| Create `rc-20260712-1` now | **No-Go: wait for CI on the documentation commit** |
| Production release | **No-Go until human approval and production evidence are complete** |

## CI Artifact Acceptance Criteria

All criteria are mandatory for the final tagged commit:

1. GitHub Actions job `release-preflight` finishes with `success` for the exact tag target commit.
2. `pnpm release:preflight` exits with code `0`.
3. `pnpm release:check` reports `pass=37 warning=0 fail=0`.
4. `migration-status.json` reports `status=pass`, `pendingMigrations=false`, and `drift=false`.
5. `e2e-permissions.json` reports `status=pass`, `17/17` checks passed, and zero remaining test records.
6. `env-check.json` reports `status=pass`, no missing required variables, and no secret values.
7. `audit-export-smoke.json` reports `status=pass` and `exportedCount > 0`.
8. The artifact contains `release-evidence.json`, `release-evidence.md`, `release-gate.json`, `migration-status.json`, `env-check.json`, `e2e-permissions.json`, and `audit-export-smoke.json`.
9. The CI fixture marker files are present where configured and state `fixtureOnly: true` and `productionEvidence: false`.
10. The artifact contains no token, password, database URL, key, cookie, authorization header, or other secret value.
11. `release-evidence.json` records the exact tag target commit, branch or tag, and a non-local CI runId.

## Next Steps

1. Trigger or observe `release-preflight` on the new documentation commit.
2. Verify the run commit and artifact contents against the acceptance criteria above.
3. After explicit confirmation of tag name `rc-20260712-1` and the new CI-green target commit, create and push the annotated tag.
4. Proceed to human release approval.
5. Collect production release evidence and production backup/restore evidence.
6. Execute deployment according to `production-runbook.md` only after approval.
