# Release Candidate

## Current Decision

**No-Go: waiting for a CI artifact bound to an exact candidate commit.**

This workspace cannot currently be frozen as a release candidate because its `.git` directory does not contain valid repository metadata (`HEAD` and `config` are absent). Consequently, the candidate commit, branch, tag, recent history, remote repository, and clean working-tree state cannot be verified. No commit, branch, tag, push, or CI run was created for this candidate.

## Candidate Identity

| Field | Value |
| --- | --- |
| Commit | `unverified` |
| Branch | `unverified` |
| Tag | not created; proposed name `rc-20260710-1`, subject to confirmation |
| CI runId | not available |
| CI artifact | not available |
| Local evidence identity | `commit=null`, `branch=local`, `runId=local` |

The local evidence is diagnostic input only. It is not formal release evidence and cannot support final approval.

## Included Scope

The candidate must include the reviewed and committed implementation for:

1. Task 65: production security baseline and release gate.
2. Task 66: green release gates and the associated data-state handling documentation.
3. Task 67: release evidence generation and the CI `release-preflight` integration.
4. Task 68: release approval pack, production runbook, rollback plan, and post-release checklist.
5. This candidate record and local-artifact ignore rules.

Because Git metadata is unavailable, the exact file-level delta for Tasks 65–68 cannot be proven in this workspace. Before freezing the candidate, restore or re-clone the repository and review `git diff` and the commit history. At minimum, review the release-gate API and UI, release scripts, permission data/migrations, `.github/workflows/release-preflight.yml`, `package.json`, and all files under `docs/release/`.

## Excluded Scope

- Actual production deployment.
- Execution of production database changes.
- Completion of human approval.
- Production rollback drill.
- Local files under `tmp/release-evidence/` and `tmp/e2e-permissions-*/`.

## Risks

- Local artifacts cannot be used as final production evidence.
- The CI artifact must be generated from and identify the exact candidate commit.
- A missing, skipped, cancelled, or failed CI run is an unconditional No-Go.
- A candidate must not be created until the working tree, untracked files, change scope, remote, and target tag name have been reviewed.

## CI Artifact Acceptance Criteria

All criteria are mandatory:

1. GitHub Actions job `release-preflight` in `.github/workflows/release-preflight.yml` finishes with `success`.
2. `pnpm release:preflight` exits with code `0`.
3. `pnpm release:check` reports `pass=37 warning=0 fail=0`.
4. `migration-status.json` has `status=pass`, `pendingMigrations=false`, and `drift=false`.
5. `e2e-permissions.json` has `status=pass`, `17/17` checks passed, and `cleanup: remaining test records = 0`.
6. `env-check.json` has `status=pass`, no missing required environment variables, and no secret values.
7. `audit-export-smoke.json` has `status=pass` and `exportedCount > 0`.
8. The artifact contains `release-evidence.json`, `release-evidence.md`, `release-gate.json`, `migration-status.json`, `env-check.json`, `e2e-permissions.json`, and `audit-export-smoke.json`.
9. The artifact contains no token, password, database URL, key, cookie, authorization header, or other secret value.
10. `release-evidence.json` records the exact candidate commit, branch or tag, and non-local CI runId; its commit must exactly equal the frozen candidate commit.

## Recovery and Manual Freeze Procedure

Run these steps only after restoring a valid clone containing `.git/HEAD` and `.git/config`:

```powershell
git status --short --branch
git branch --show-current
git rev-parse HEAD
git log -8 --oneline --decorate
git remote -v
git status --porcelain=v1 --untracked-files=all
git diff --stat
git diff -- . ':!tmp/release-evidence' ':!tmp/e2e-permissions-*'
```

Review every changed and untracked file. Do not continue if unrelated, unreviewed, or generated artifacts are present. Confirm the target name before creating anything. Suggested values:

- Commit message: `chore(release): freeze release candidate for tasks 65-69`
- Tag: `rc-20260710-1`

After approval of the exact file list and tag name:

```powershell
git add <explicit-reviewed-file-list>
git commit -m "chore(release): freeze release candidate for tasks 65-69"
git tag -a rc-20260710-1 -m "Release candidate rc-20260710-1"
git push origin <candidate-branch>
git push origin rc-20260710-1
gh workflow run release-preflight.yml --ref rc-20260710-1
```

Record the resulting workflow run URL and runId. Download the `release-evidence` artifact, verify all acceptance criteria above, and then replace the unverified fields in this document with the exact commit, branch/tag, runId, and artifact location. Only then may the candidate proceed to human release approval.
