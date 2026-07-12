# Production Approval Record

This record controls admission of the frozen release candidate into a production release window. CI green proves that the RC code and release-gate chain are executable; it is not production evidence. No local evidence or CI fixture may substitute for evidence collected from the real production environment.

Task 72 preserves `rc-20260712-1` unchanged but marks it superseded / not approved because its artifact violated the hard audit-export contract. The corrective target is a fresh CI-green commit and annotated `rc-20260712-2`. The corrected CI-only fixture must produce a real, non-empty export with `exportedCount > 0`, `fixtureOnly=true`, and `productionEvidence=false`; it remains synthetic test evidence and does not replace the required real production audit-export smoke.

## 1. Release Candidate Identity

| Field | Recorded value | Verification status |
| --- | --- | --- |
| Repository | `xmiemiex/salary-backend` | Verified from `origin` |
| RC tag | `rc-20260712-1` | Verified after `git fetch --tags origin` |
| Tag type | Annotated tag | Verified |
| Tag target commit | `1a51632f719d53c15c1d7e56f5184ffb7689c9fa` | Verified with tag dereference |
| Current `main` commit | `2ea81f420024e50a301432823669bdb1391960af` | Verified; documentation-only commit and not part of the RC |
| RC mutation required | No | The existing tag must not be moved, deleted, or recreated |
| Verification date | `2026-07-12` (Asia/Shanghai) | Verified in the release workstation environment |
| Worktree at initial verification | Clean, `main...origin/main` | Verified before this record was added |

RC identity verification result: **Pass**. This result does not imply production approval.

## 2. CI Run and Artifact Source

| Field | Recorded value | Evidence status |
| --- | --- | --- |
| Workflow | GitHub Actions `release-preflight` |
| Run | `release-preflight #9` |
| Expected commit binding | `1a51632f719d53c15c1d7e56f5184ffb7689c9fa` |
| CI result | `success` | Independently retrieved from GitHub Actions run ID `29175783807` |
| Release gate | `37 pass / 0 warning / 0 fail` | Independently inspected in the downloaded artifact |
| Artifact name/source | `release-evidence`, artifact ID `8254922557`, uploaded by `.github/workflows/release-preflight.yml` in run `#9` |
| Artifact metadata | 8297 bytes; GitHub digest `sha256:68428ba03e417554422fb32ab9c20cd690d147595b39d10d8dd683c1b185a5cc`; not expired when inspected |
| Automatic artifact inspection | **Completed** | Downloaded through the GitHub connector and inspected locally |
| Required disposition | **Rejected pending corrected CI evidence** | `audit-export-smoke.json` reports `exportedCount=0`, which violates the mandatory `exportedCount > 0` criterion |

### CI Artifact Verification

The artifact was downloaded from GitHub Actions run `release-preflight #9`. The run and artifact metadata were retrieved from GitHub, and the ZIP contents were inspected without accepting local evidence as a substitute.

Required files:

- `release-evidence.json`
- `release-evidence.md`
- `release-gate.json`
- `migration-status.json`
- `env-check.json`
- `e2e-permissions.json`
- `audit-export-smoke.json`

Required copied fields or screenshots:

| Check | Required value | Verification result |
| --- | --- | --- |
| Run commit SHA, from the GitHub run page and artifact metadata | `1a51632f719d53c15c1d7e56f5184ffb7689c9fa` in both places | **Pass** |
| Run conclusion | `success` | **Pass** |
| `release-evidence.json` run identity | Non-local CI run ID and the exact RC commit | **Pass** — run ID `29175783807` |
| `release-gate.json` | `pass=37`, `warning=0`, `fail=0` | **Pass** |
| `migration-status.json` | Status pass, `pendingMigrations=false`, `drift=false` | **Pass** |
| `e2e-permissions.json` | Status pass, `17/17`, cleanup remaining test records `0` | **Pass** |
| `env-check.json` | Status pass; no secret values included | **Pass** — missing `0`, invalid `0`; artifact environment is `development`, not production |
| `audit-export-smoke.json` | Status pass and `exportedCount > 0` | **Fail** — status is pass but `exportedCount=0` |
| Fixture marker | `fixtureOnly=true` | **Pass** |
| Production-evidence marker | `productionEvidence=false` | **Pass** |
| Artifact file inventory | All seven mandatory files above are present | **Pass** — all seven plus fixture marker/report files are present |
| Secret scan | No token, password, database URL, private key, cookie, authorization header, or credential value | **Pass** — full textual artifact scan found no matching secret pattern or populated sensitive JSON field |

Artifact verifier: **Automated inspection by Codex; the failed acceptance criterion is recorded for human release review**

Verification time and timezone: **2026-07-12 11:09:34 +08:00**

GitHub run URL: `https://github.com/xmiemiex/salary-backend/actions/runs/29175783807`
Artifact digest: `sha256:68428ba03e417554422fb32ab9c20cd690d147595b39d10d8dd683c1b185a5cc`

CI artifact acceptance status: **Fail / rejected** because `audit-export-smoke.json` has `exportedCount=0`.

## 3. CI Evidence Summary and Boundary

The CI run is green, the artifact is tied to the exact RC commit, and the release gate is `37/0/0`. However, the artifact does not meet the complete acceptance contract because the audit export smoke exported zero records. CI green therefore does not override the failed evidence criterion.

The workflow creates synthetic test data in an ephemeral CI database. Its artifact must explicitly state:

- `fixtureOnly=true`
- `productionEvidence=false`

Consequently, the CI artifact is test-only evidence. It does not prove production database state, production configuration, a usable production backup, a successful restore drill, current production alert state, or production administrator/audit behavior. Local `tmp/release-evidence` files are also not accepted as production evidence.

## 4. Human Approvals

An approval is valid only when the approver identity, timestamp with timezone, decision, scope, and evidence reference are recorded. Blank or verbal-only approvals are not approvals.

| Approval role | Approver | Time and timezone | Decision | Evidence/reference | Status |
| --- | --- | --- | --- | --- | --- |
| Technical approval | Pending | Pending | Pending | RC and CI artifact review | **Pending** |
| Product/business approval | Pending | Pending | Pending | Release scope and business window | **Pending** |
| Operations approval | Pending | Pending | Pending | Production checks, monitoring, deployment and rollback readiness | **Pending** |
| Data/finance approval, if applicable | Applicability not yet decided | Pending | Pending or N/A with rationale | Data/financial impact assessment | **Pending** |
| Rollback owner acknowledgement | Pending | Pending | Pending | Online status and rollback access confirmed | **Pending** |
| Release window owner | Pending | Pending | Pending | Approved start/end time and coordination channel | **Pending** |

## 5. Required Production Evidence

Every item below must come from the real production environment or its authoritative production control plane. Record the running environment, executor, timestamp with timezone, result, evidence reference, and rollback point. Never paste tokens, passwords, database URLs, private keys, or other secret values into this document.

| Production evidence | Pass criteria | Environment | Executor | Time | Result/reference | Rollback point | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Production release gate | Required checks pass; `warning=0`, `fail=0` | Pending | Pending | Pending | Pending | Pending | **Missing** |
| Production env check | Pass; required values present and valid without printing values | Pending | Pending | Pending | Pending | Pending | **Missing** |
| Production migration status | Pass; `pendingMigrations=false`, `drift=false` | Pending | Pending | Pending | Pending | Pending | **Missing** |
| Full production backup | Real full backup succeeded within the last 72 hours; integrity/checksum and recoverability reference retained | Pending | Pending | Pending | Pending | Backup identifier is the release rollback data point | **Missing** |
| Production restore drill | Real successful restore drill within the last 90 days, using an approved isolated restore environment | Pending | Pending | Pending | Pending | Restored snapshot/drill record | **Missing** |
| Active critical alerts | Count equals `0` immediately before the window | Pending | Pending | Pending | Pending | Current deployed version | **Missing** |
| Backup health | Not critical | Pending | Pending | Pending | Pending | Latest verified full backup | **Missing** |
| System health | Not critical | Pending | Pending | Pending | Pending | Current deployed version | **Missing** |
| Production administrator permission smoke | Approved admin login and protected-operation checks pass; expected audit events exist | Pending | Pending | Pending | Pending | Current deployed version; revoke/stop smoke account activity if needed | **Missing** |
| Production audit export smoke | Pass; real production export contains at least one authorized record and no unintended data disclosure | Pending | Pending | Pending | Pending | Current deployed version; retain authorized export reference only | **Missing** |
| Production logs/error-rate observation | Baseline recorded before release and agreed observation window available; no unresolved critical/high-severity regression | Pending | Pending | Pending | Pending | Current deployed version | **Missing** |

Evidence references should point to access-controlled monitoring, backup, ticket, change-management, or audit systems. Do not copy sensitive payloads into Git.

## 6. Go / No-Go Rules

### Go Conditions

All conditions are mandatory:

1. The frozen RC tag exists and resolves to the verified commit without retagging.
2. The CI artifact is complete, manually or automatically inspected, secret-safe, and bound to the exact RC commit.
3. Required technical, product/business, operations, and applicable data/finance approvals are complete.
4. Every production-evidence row in section 5 passes.
5. A named rollback owner is online and has confirmed access.
6. The latest full backup and restore drill are real, current, successful, and independently referenced.
7. The production release window and coordination channel are confirmed.

### No-Go Conditions

Any one condition forces No-Go:

- Production release gate fails.
- Production backup or restore-drill evidence is absent, stale, failed, or not tied to a real production system.
- Active critical alerts are not zero.
- Migration pending/drift status is unknown or not false.
- Production env check fails.
- No named online rollback owner is available.
- Required approval records are absent.
- The CI artifact commit cannot be confirmed as the RC commit.
- The CI artifact is incomplete, contains secrets, or is incorrectly represented as production evidence.
- Backup health or system health is critical.

## 7. Current Decision

| Decision | Status | Reason |
| --- | --- | --- |
| RC identity verification | **Pass** | Tag exists and resolves to the expected immutable commit |
| CI artifact acceptance | **Fail / rejected** | Artifact is complete and commit-bound, but `audit-export-smoke.json` reports `exportedCount=0` instead of a value greater than zero |
| Human approval | **Not complete** | All approval signatures and the rollback-owner acknowledgement are pending |
| Production evidence | **Not complete** | All real production evidence remains missing |
| Production release | **No-Go** | CI artifact acceptance failed; approvals, backup/restore evidence, health/alert checks, and production smoke evidence are also incomplete |
| Enter production release window | **Not permitted** | Go conditions have not been satisfied |

This decision may change to Go only after every pending item is completed and the release owner records a final time-stamped decision.

## 8. Production Command Authorization

No production command was executed as part of this task. This task is limited to approval and evidence collection.

Before any production command is run, create a separate execution entry with all fields below and obtain explicit second authorization from the user/change owner:

| Required field | Value |
| --- | --- |
| Exact running environment/host or control plane | Pending |
| Exact command or operation, with secret values omitted | Pending |
| Named executor | Pending |
| Planned execution time and timezone | Pending |
| Expected impact and affected services/data | Pending |
| Preconditions and evidence references | Pending |
| Rollback method and exact rollback point | Pending |
| User/change-owner second authorization | **Required** |
| Execution result and completion time | Pending |
