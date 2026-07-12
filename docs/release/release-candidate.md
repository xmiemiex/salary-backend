# Release Candidate

## Candidate Identity

`rc-20260712-1` remains immutable but is superseded and not approved: its successful CI artifact reported `audit-export-smoke.json` with `status=pass` and `exportedCount=0`, violating the mandatory non-empty export contract. Task 72 corrected the CI-only fixture and smoke contract, verified a fresh artifact for the exact new commit, and froze `rc-20260712-2`.

| Field | Value |
| --- | --- |
| RC tag | `rc-20260712-2` |
| CI-green tagged commit | `9f8f8f576dde54355983b96525335e94c55c8b32` |
| Branch | `main` |
| Remote | `origin` (`https://github.com/xmiemiex/salary-backend.git`) |
| CI workflow | `.github/workflows/release-preflight.yml` |
| CI status | `release-preflight #10` success; run ID `29185992419` |
| Release gate | `37 pass / 0 warning / 0 fail` / automatically inspected |
| CI artifact inspection | Automatically downloaded and inspected; artifact ID `8258047308`, ZIP SHA-256 `fda07abc0c6d9ad174b58b570e388849ad6786d2dfcab846aae586571c5e15e5` |
| Previous tag status | `rc-20260712-1` retained unchanged; superseded / not approved |
| New tag status | Annotated `rc-20260712-2` created and pushed; resolves to `9f8f8f576dde54355983b96525335e94c55c8b32` |

Before the tag was created, the repository was clean and local `HEAD`, `origin/main`, the user-confirmed CI-green commit, and the annotated tag target were identical:

```text
1a51632f719d53c15c1d7e56f5184ffb7689c9fa
```

No local release artifact is accepted as CI evidence.

## CI Evidence Boundary

`release-preflight #10` completed successfully for exact commit `9f8f8f576dde54355983b96525335e94c55c8b32`. Its newly uploaded artifact was automatically downloaded and inspected: audit export smoke is `status=pass`, `exportedCount=1`, `csvBytes=528`, `fixtureOnly=true`, and `productionEvidence=false`; the release gate remains `37/0/0`. This proves the CI contract only and is not production evidence.

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
| RC `rc-20260712-1` frozen | **Go** |
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

1. Do not approve `rc-20260712-1`; retain it unchanged as the rejected historical candidate.
2. Use `rc-20260712-2` as the current frozen candidate and return to Task 71 for human approval.
3. Collect real production audit-export and all other production release evidence; CI fixture evidence is never production evidence.
4. Execute deployment according to `production-runbook.md` only after human approval.

This post-freeze status record is maintained on `main`; it does not move, replace, or retag the immutable RC target.
