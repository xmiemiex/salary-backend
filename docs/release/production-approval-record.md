# Production Approval Record — Tasks 74–86

This record preserves the chronological approval and production evidence history for the frozen release candidate. The approval object and deployed release are **only** `rc-20260712-2`. `rc-20260712-1` remains immutable but has been superseded and **must not be used for approval or release**.

Current production status: **Full Go stable with accepted backup risk**.

Final production release gate: **`37 pass / 0 warning / 0 fail`**, exit=`0`.

Known accepted risk: **off-host backup is not configured**. The risk is accepted for this stage but remains unresolved. Sections 1–22 retain earlier No-Go, Conditional Go, Full Go, and Full Go Regression decisions as explicitly historical stages; the authoritative final decision is the Task 86 record in section 23.

## 1. Release Candidate Identity

| Field | Verified result |
| --- | --- |
| Repository | `xmiemiex/salary-backend` |
| Current approval object | Annotated tag `rc-20260712-2` |
| Tag target / CI commit | `9f8f8f576dde54355983b96525335e94c55c8b32` |
| Previous RC | `rc-20260712-1` remains at `1a51632f719d53c15c1d7e56f5184ffb7689c9fa`; superseded and ineligible for approval |
| Tag mutation | None; neither RC was moved, deleted, or recreated |
| Verification environment | Release workstation, repository `D:\Xcode\后台` |
| Verification executor | Codex automated verification for Task 74 |
| Verification time | `2026-07-12 16:48:55 +08:00` (Asia/Shanghai) |
| Worktree at verification | `main...origin/main`; only this approval document was already modified |
| RC identity result | **Pass** |

RC identity verification does not constitute production approval.

## 2. CI Run and Artifact Verification

| Field | Verified result |
| --- | --- |
| Workflow run | `release-preflight #10` |
| Run ID | `29185992419` |
| Run commit | `9f8f8f576dde54355983b96525335e94c55c8b32` |
| Artifact | `release-evidence`, artifact ID `8258047308` |
| Artifact ZIP SHA-256 | `fda07abc0c6d9ad174b58b570e388849ad6786d2dfcab846aae586571c5e15e5` |
| Release gate | **Pass:** `37 pass / 0 warning / 0 fail` |
| Migration status | **Pass:** `pendingMigrations=false`, `drift=false` |
| Permissions E2E | **Pass:** `17/17`; cleanup remaining test records `0` |
| Environment check | **Pass**; artifact environment is `development`, not production |
| Audit export smoke | **Pass:** `exportedCount=1`, `csvBytes=528` |
| Fixture boundary | `fixtureOnly=true`, `productionEvidence=false` |
| Sensitive-value scan | **Pass:** no token, password, database URL, private key, authorization bearer value, or populated sensitive field detected |
| CI artifact result | **Pass for CI-only evidence** |

The artifact inventory was inspected and contains all mandatory files:

- `release-evidence.json`
- `release-evidence.md`
- `release-gate.json`
- `migration-status.json`
- `env-check.json`
- `e2e-permissions.json`
- `audit-export-smoke.json`

The inspected ZIP at `tmp/release-evidence-run-29185992419.zip` is accepted as the specified CI artifact only because its SHA-256 exactly matches the recorded artifact SHA-256 and its internal run ID and commit bind it to run `29185992419` and `rc-20260712-2`. It is not accepted as production evidence.

## 3. CI Fixture Boundary

The CI run used synthetic records in an ephemeral CI database. Its evidence proves only that the RC code and release-gate chain executed against CI fixtures.

It does **not** represent or prove:

- a production release gate or production environment check;
- production migration state;
- a production backup;
- a production restore drill;
- current production alerts, backup health, or system health;
- a production administrator permission smoke test;
- a production audit export smoke test.

Local evidence must not substitute for production evidence. No local or CI backup/restore/audit result may be copied into the production-evidence table as a pass.

## 4. Human Approval Signatures

An approval is valid only when approver identity, timestamp with timezone, decision, scope, and evidence reference are recorded. No signature has been supplied as part of Task 74.

| Approval role | Approver | Time and timezone | Decision | Evidence/reference | Status |
| --- | --- | --- | --- | --- | --- |
| Technical lead | Pending | Pending | Pending | RC and CI artifact review | **Pending** |
| Product/business lead | Pending | Pending | Pending | Release scope and business window | **Pending** |
| Operations/release lead | Pending | Pending | Pending | Production checks, monitoring, deployment, and rollback readiness | **Pending** |
| Data/finance lead, if applicable | Pending | Pending | Pending or N/A with rationale | Data/financial impact assessment | **Pending** |
| Rollback owner acknowledgement | Pending | Pending | Pending | Online status, access, and rollback point confirmed | **Pending** |
| Release window owner | Pending | Pending | Pending | Approved start/end time and coordination channel | **Pending** |

Human approval status: **Pending**, not approved.

## 5. Required Real Production Evidence

Every item must come from the real production environment or its authoritative control plane. Each execution record must state the exact environment, named executor, timestamp with timezone, result/evidence reference, and rollback point. Evidence references must remain access-controlled; never paste tokens, passwords, database URLs, private keys, or other secret values into Git.

| Required production evidence | Pass criteria | Environment | Executor | Time | Result/reference | Rollback point | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Production release gate | Required checks all pass; warning explained; `fail=0` | Not available | Pending | Pending | Production access and authoritative gate entry not provided; next: operations supplies access and approved read-only check | Pending | **Not available** |
| Production env check | Required env pass; no missing required names; no secret values printed | Not available | Pending | Pending | Production access not provided; next: run approved redacted env check | Pending | **Not available** |
| Production migration status | Schema parse OK; `pendingMigrations=false`, `drift=false`; RC/tag consistent | Not available | Pending | Pending | Production DB access not provided; next: use approved read-only account/check | Pending | **Not available** |
| Full production backup | Real successful full backup within 72 hours; type full; integrity/recoverability reference retained | Not available | Pending | Pending | Backup-system entry not provided; next: supply authoritative backup metadata; triggering a new backup requires second authorization | Backup identifier | **Not available** |
| Production restore drill | Real successful drill within 90 days; `destructiveToPrimary=false`; validation passes | Not available | Pending | Pending | Restore-drill record/method not provided; next: supply existing authoritative drill record; running a drill requires second authorization | Restored snapshot/drill record | **Not available** |
| Active critical alerts | No release-blocking critical alert; count and exceptions recorded | Not available | Pending | Pending | Alert-system entry not provided; next: collect current critical count and summaries read-only | Current deployed version | **Not available** |
| Backup health | Not critical | Not available | Pending | Pending | Backup health source not provided; next: collect authoritative health status | Latest verified full backup | **Not available** |
| System health | Not critical; key warnings explained | Not available | Pending | Pending | Monitoring entry not provided; next: collect authoritative system health | Current deployed version | **Not available** |
| Production administrator permission smoke | Admin login and `/me` pass; expected unauthorized `401` and insufficient-role `403`; no destructive action | Not available | Pending | Pending | Production API/Web access and approved accounts not provided; next: authorize minimal smoke plan | Current deployed version | **Not available** |
| Production audit export smoke | `status=pass`, `exportedCount > 0`, `csvBytes > 0`; minimal scope; no sensitive disclosure | Not available | Pending | Pending | Production access not provided; CI fixture is explicitly excluded; next: authorize minimal real-production export smoke | Current deployed version; retain only access-controlled export reference | **Not available** |
| Production logs/error-rate observation | Last 30 minutes recorded: error rate, API 5xx, Web errors, sync failures, DB errors, abnormal 401/403 peaks; no blocking anomaly | Not available | Pending | Pending | Log/monitoring entry not provided; next: collect read-only 30-minute baseline and explain trends | Current deployed version | **Not available** |
| Rollback owner online confirmation | Named owner online with access, decision deadline, and exact rollback point confirmed | Not available | Pending | Pending | Owner and rollback point not provided; next: owner supplies time-stamped confirmation | Exact rollback point | **Not available** |
| Release window confirmation | Release, rollback, and data owners recorded; approved start/end, decision deadline, channel, and online status confirmed | Not available | Pending | Pending | Window and responsible persons not provided; next: record approved schedule and confirmations | Current deployed version | **Not available** |

## 5.1 Production Access Intake

No production connection or command has been attempted in Task 74. Before any production evidence collection, the user or operations owner must provide or confirm the following without pasting credentials or secret values into chat or Git:

| Required intake item | Current status | Next step |
| --- | --- | --- |
| Access method: SSH, cloud console, Docker host, Kubernetes, PaaS, or other | **Not available** | Identify the authoritative access path and target environment alias |
| Production API and Web addresses | **Not available** | Provide non-secret addresses or approved aliases |
| Production database access and read-only account availability | **Not available** | Confirm method and whether a least-privilege read-only identity exists; do not provide credentials here |
| Backup-system entry and restore-drill method | **Not available** | Provide authoritative system names/aliases and existing evidence references |
| Logs/monitoring and alert-system entries | **Not available** | Provide authoritative system names/aliases and approved access path |
| Release, rollback, approval, and applicable data/finance owners | **Pending** | Record names/roles and time-stamped decisions; omit private contact details |
| Window start/end, rollback decision deadline, notification channel, online status | **Pending** | Record the approved window and owner confirmations |

If production access remains unavailable, no production action will be executed, this checklist remains the manual handoff, and the decision remains **No-Go: production evidence unavailable**.

## 6. Production Go / No-Go Rules

### Go conditions

All conditions are mandatory:

1. `rc-20260712-2` exists and resolves to `9f8f8f576dde54355983b96525335e94c55c8b32` without retagging.
2. The CI artifact is complete, contract-compliant, secret-safe, SHA-256 verified, and bound to the exact RC commit.
3. Technical, product/business, operations/release, and applicable data/finance approvals are complete.
4. Every production-evidence row in section 5 passes.
5. A named rollback owner is online and has confirmed access and the exact rollback point.
6. The recent full backup and restore drill are real, current, successful, and independently referenced.
7. The production release window is confirmed.

### No-Go conditions

Any one condition forces No-Go:

- `rc-20260712-1` is still being used for approval or release.
- Production release gate fails.
- Production backup or restore-drill evidence is missing, stale, failed, or not tied to a real production system.
- Active critical alerts are not zero.
- Migration pending/drift status is unknown or not false.
- Production env check fails.
- No named online rollback owner is available.
- Required approval records are absent.
- Artifact commit cannot be confirmed as the RC commit.
- Artifact SHA-256 cannot be confirmed.
- The artifact is incomplete, contains secrets, or is represented as production evidence.
- Backup health or system health is critical.

## 7. Current Decision

| Decision area | Status | Reason |
| --- | --- | --- |
| `rc-20260712-2` identity | **Pass** | Tag exists and resolves to the expected immutable commit |
| CI artifact | **Pass for CI-only evidence** | Inventory, commit binding, SHA-256, gate, migration, E2E, env check, audit smoke, fixture markers, and sensitive scan pass |
| Audit export contract | **Pass in CI fixture** | `status=pass`, `exportedCount=1`, `csvBytes=528` |
| Human approval | **Pending** | Required signatures have not been supplied |
| Production evidence | **Not available** | Production access and authoritative evidence sources have not been provided; every real-production item remains unverified |
| Production release | **No-Go** | Human approvals and real production evidence are incomplete |
| Enter production release window | **Not permitted** | Go conditions are not satisfied |

`rc-20260712-2` may proceed into human approval. It may not enter the production release window until the real backup, restore drill, alert/health state, production audit export smoke, remaining production checks, rollback confirmation, release-window confirmation, and human approvals are all recorded as passed.

## 8. Production Operation Authorization

No production command was executed in Task 74. This task is limited to approval and evidence verification and does not perform a production release.

Before any production operation, record and authorize all fields below:

| Required field | Value |
| --- | --- |
| Exact production environment/host or control plane | Pending |
| Exact operation, with secret values omitted | Pending |
| Named executor | Pending |
| Planned execution time and timezone | Pending |
| Expected impact and affected services/data | Pending |
| Preconditions and evidence references | Pending |
| Rollback method and exact rollback point | Pending |
| Change-owner authorization | **Required** |
| Execution result and completion time | Pending |

Every proposed production command must be listed before execution with: running environment, exact redacted command/operation, named executor, impact scope, read-only status, success criteria, and failure handling. Any production database write, backup trigger, restore drill, alert disabling, or migration action requires explicit second authorization. Production deployment is outside Task 74 and must not be executed here.

## 9. Task 75 Production Access Information Gaps

Task 75 performs planning and documentation only. No production connection, production command, release, database write, migration deployment, backup/restore operation, alert change, or service restart was attempted. Because no real production access information has been supplied, every production evidence item remains **Not available** and the decision remains **No-Go: production evidence unavailable**.

| Information item | Current status | Sensitive | Recommended provision method | Blocks Go | Notes |
| --- | --- | --- | --- | --- | --- |
| Production Web address | Not provided | No, unless private topology is exposed | Environment alias plus non-secret URL, or redacted operations result | Yes | Needed for Web and administrator smoke checks |
| Production API address | Not provided | No, unless private topology is exposed | Environment alias plus non-secret URL, or redacted operations result | Yes | Needed for health and API smoke checks |
| SSH access | Not provided | Yes | Confirm availability, bastion/environment alias, account role, and permission scope only; configure credentials in the operator's secure environment | Conditional | Mark N/A if another authoritative path is used |
| Cloud console access | Not provided | Yes | Name the provider/control-plane alias and role; use SSO or secret manager locally | Conditional | Mark N/A if unused |
| Docker host access | Not provided | Yes | Provide host alias and read-only role/scope only | Conditional | Mark N/A if unused |
| Kubernetes access | Not provided | Yes | Provide cluster/context/namespace aliases and read-only RBAC role only | Conditional | Mark N/A if unused |
| PaaS access | Not provided | Yes | Provide platform/app/environment aliases and viewer role only | Conditional | Mark N/A if unused |
| Other production access | Not provided | Depends | Describe the authoritative access path, alias, and permission scope without credentials | Conditional | At least one authoritative production path is required |
| Production database access method | Not provided | Yes | Provide database platform/cluster alias and access procedure; configure credentials outside chat and Git | Yes | Direct connection string must never be recorded here |
| Read-only database account exists | Not provided | Yes | Confirm yes/no, role name, and permission scope only | Yes | Prefer metadata/catalog-only least privilege |
| Backup-system entry | Not provided | Yes | Provide console/system alias, viewer role, or redacted screenshot/result | Yes | Authoritative backup source required |
| Full-backup query method for last 72 hours | Not provided | Yes | Provide read-only page/API/command pattern with placeholders, or an operator-produced redacted result | Yes | Query existing metadata only; do not trigger a backup |
| Restore-drill query method for last 90 days | Not provided | Yes | Provide read-only page/API/command pattern with placeholders, or drill ID and redacted summary | Yes | Query an existing drill only; do not execute a drill |
| Log-system entry | Not provided | Yes | Provide system/index/service aliases, viewer role, and approved query scope | Yes | Needed for the latest 30-minute observation |
| Monitoring-system entry | Not provided | Yes | Provide dashboard/system alias, viewer role, and relevant dashboard names | Yes | Needed for system and error-rate health |
| Alert-system entry | Not provided | Yes | Provide system/service aliases and viewer role | Yes | Read-only active-alert query only |
| Release owner | Not provided | No | Name or role name, without private contact details | Yes | Must be online and explicitly confirm |
| Rollback owner | Not provided | No | Name or role name, without private contact details | Yes | Must confirm access and exact rollback point |
| Data owner | Not provided | No | Name or role name; state N/A with rationale if genuinely inapplicable | Yes | Applicability must be decided |
| Technical approver | Not provided | No | Name or role plus timestamped decision and evidence reference | Yes | Approval remains Pending |
| Product/business approver | Not provided | No | Name or role plus timestamped decision and evidence reference | Yes | Approval remains Pending |
| Operations/release approver | Not provided | No | Name or role plus timestamped decision and evidence reference | Yes | Approval remains Pending |
| Release-window start time | Not provided | No | ISO 8601 timestamp with timezone | Yes | Must be explicitly approved |
| Release-window end time | Not provided | No | ISO 8601 timestamp with timezone | Yes | Must be explicitly approved |
| Rollback decision deadline | Not provided | No | Timestamp with timezone or duration from window start | Yes | Must be accepted by release and rollback owners |
| Notification channel | Not provided | Potentially | Channel alias/name only; no invite token or private webhook | Yes | Must support release coordination |
| Owner online-confirmation method | Not provided | Potentially | Approved channel/ticket alias and timestamped acknowledgement | Yes | Do not record private contact data |

An item marked Conditional blocks Go when it is the selected production access path. It may be recorded as Not applicable only when an alternative authoritative access path is identified and documented.

## 10. Prohibited Sensitive Credential Provision

Do **not** paste or record any token, password, secret, private key, database connection string, cookie, session value, authorization header, or complete credential in chat, this repository, release documentation, or a Git commit.

Safe inputs are limited to environment aliases, non-secret URLs, account role names, permission scopes, non-sensitive summaries from control-plane screenshots, redacted results executed by operations, backup/drill/alert identifiers, pass/fail summaries, timestamps, and responsible-person names or role names.

When credentials are required, the user or operations owner must configure them directly on the local workstation, cloud console, bastion, secret manager, or other approved secure operations environment. Credentials must not be written into the repository, this release record, chat history, generated evidence files, or Git history.

## 11. Read-only Production Evidence Collection Plan

Commands below are illustrative redacted patterns, not authorization to execute. The authoritative platform and exact safe command must be confirmed before Task 76. All outputs must identify production by an environment alias, executor, timestamp with timezone, and access-controlled evidence reference without exposing credentials or sensitive payloads.

| Evidence item | Objective | Suggested environment | Suggested executor | Read-only | Possible command/API/page | Success standard | Failure handling | Second authorization | Blocks Go |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Production release gate | Obtain authoritative production gate result for this RC | Approved release workstation/control plane | Release owner | Yes | Approved gate page or project-provided gate command in query/check mode | Exact RC recorded; required checks pass; `fail=0`; warnings explained | Stop; retain redacted failure summary; do not deploy or remediate without separate scope | Yes, before any production access/execution | Yes |
| Production env check | Verify required names/configuration without printing values | Production runtime control plane | Operations owner | Yes | Redacted env-check command or configuration validation page | Pass; no missing required names; no value or secret printed | Stop and record missing-name summary only; do not modify variables | Yes, before any production access/execution | Yes |
| Production migration status | Verify deployed migration metadata, pending state, and drift | Secure operations environment using read-only DB identity | Data/operations owner | Yes | Platform migration-status page or approved status-only command | Schema parse OK; `pendingMigrations=false`; `drift=false`; RC association understood | Stop; record metadata-only failure; no migration deployment or DB write | Yes, before DB access | Yes |
| Full backup within 72 hours | Verify an existing authoritative full backup | Backup console/API | Backup/operations owner | Yes | Backup inventory filtered to production, full, and last 72 hours | Successful full backup within 72 hours; backup ID, time, type, integrity/recoverability reference retained | Record stale/missing/failed; do not trigger a backup | Yes, before production access; triggering is separately prohibited without new authorization | Yes |
| Restore drill within 90 days | Verify an existing isolated restore-drill record | Backup/DR console or change system | Data/operations owner | Yes | Drill-history page/API filtered to last 90 days | Successful drill within 90 days; drill ID; isolated target; validation passed; primary untouched | Record stale/missing/failed; do not run a drill | Yes, before production access; executing a drill needs separate authorization | Yes |
| Active critical alerts | Determine current release-blocking alerts | Alert console/API | On-call/operations owner | Yes | Active-alert view filtered to production and critical severity | Zero release-blocking critical alerts; exceptions documented and approved | Stop release planning; preserve alert IDs and redacted summaries; do not silence/close/change alerts | Yes, before production access | Yes |
| Backup health | Confirm authoritative backup subsystem health | Backup/monitoring console | Backup/operations owner | Yes | Backup health dashboard/API | Status not critical; latest job and integrity signals acceptable | Record failure; do not restart or reconfigure anything | Yes, before production access | Yes |
| System health | Confirm current service/dependency health | Monitoring/control plane | On-call/operations owner | Yes | Production health dashboard and non-mutating health endpoints | No critical state; key warnings explained; dependencies healthy | Record evidence and stop; no restart, scaling, or config change | Yes, before production access | Yes |
| Production administrator permission smoke | Validate minimum administrator authentication/authorization path | Production Web/API from approved operator host | Technical and operations owners | Yes, only with pre-approved non-mutating endpoints | Login and identity endpoint; expected unauthenticated `401`; expected insufficient-role `403`; no mutation endpoint | Stop immediately on unexpected authorization or side effect; revoke only through separately approved procedure | Yes; exact accounts/endpoints and data scope must be approved | Yes |
| Production audit export smoke | Validate a minimum authorized export without broad disclosure | Production Web/API from approved operator host | Data/technical owner | Yes, if export is side-effect-free | Narrow time/filter export page or endpoint; retain only controlled metadata/reference | `status=pass`, record count and byte count greater than zero; minimum scope; no unintended disclosure | Stop; securely discard output per policy; record only redacted metadata; do not broaden scope | Yes; exact filter, recipient, retention, and endpoint must be approved | Yes |
| Last 30 minutes logs and error rate | Establish immediate production baseline | Log and monitoring consoles | On-call/operations owner | Yes | 30-minute queries for API 5xx, Web errors, sync failures, DB errors, and abnormal 401/403 peaks | Window/timezone recorded; no blocking anomaly; error rates and trends summarized | Stop; retain query/dashboard references and redacted summary; do not change logging or service state | Yes, before production access | Yes |
| Release owner online confirmation | Confirm named executor/decision owner is online | Approved coordination channel/change ticket | Release owner | Yes | Timestamped acknowledgement | Named owner, time, channel reference, scope, and access confirmation recorded | Keep Pending; do not enter release window | No production-system authorization, but formal approval record is required | Yes |
| Rollback owner online confirmation | Confirm rollback authority, access, point, and deadline | Approved coordination channel/change ticket | Rollback owner | Yes | Timestamped acknowledgement | Named owner online; exact rollback point and decision deadline confirmed | Keep Pending; do not enter release window | No production-system authorization, but formal approval record is required | Yes |
| Release-window confirmation | Confirm authorized time boundaries and coordination | Change-management system | Release owner and approvers | Yes | Approved change/window record | Start/end with timezone, rollback deadline, owners, and channel recorded | Keep Pending; do not enter release window | No production-system authorization, but formal approval record is required | Yes |
| Human approval confirmation | Verify all required decisions against evidence | Approval/change-management system | Technical, product/business, operations, and applicable data owners | Yes | Approval record/page | Identity, timestamp/timezone, decision, scope, and evidence reference complete for every required role | Keep Pending/No-Go; do not infer approval from silence or chat presence | No production-system authorization, but each approval must be explicit | Yes |

## 12. Authorization Boundary for Task 76

The following may be proposed as Task 76 candidates, but only after the user approves the exact redacted plan and the named operator executes it in an approved environment: query the production release gate; query the production environment-check result; query migration status; query backup metadata; query an existing restore-drill record; query active alerts; query backup and system health; query logs and error rates; run a non-destructive minimum administrator permission smoke; and run a minimum-scope audit export smoke. These candidates are read-only in intended effect, but the two smoke checks require explicit endpoint, identity, filter, data-handling, and retention approval before execution.

The following are outside Task 75 and require explicit second authorization in a later task: production deployment; migration deployment; any database write; manually triggering a full backup; executing a restore drill; closing, silencing, or modifying alerts; restarting services; changing environment variables; modifying permissions or accounts; modifying production data; and moving, deleting, or recreating any RC tag.

Task 75 is not a production release and cannot place the system into a production release window. Entry into a release window is permitted only after every item of real production evidence is collected from an authoritative production source and passes, and every required human approval is complete.

## 13. Task 76: Read-only Production Evidence Collection Package

Task 76 baseline verification confirms that annotated tag `rc-20260712-2` still dereferences to `9f8f8f576dde54355983b96525335e94c55c8b32`. The approval object remains `rc-20260712-2`; `rc-20260712-1` is superseded and is not eligible for approval. At verification, the worktree was `main...origin/main` with only this approval document modified.

No production access information or authoritative production evidence source is available. No production connection, API call, page query, database query, smoke test, or other production operation was executed in Task 76. This section is therefore an **operations execution template**, not collected evidence. Every evidence result remains **Not available** or **Pending**, and the decision remains **No-Go: production evidence unavailable**.

### 13.1 Missing Inputs

The following required inputs remain missing: production Web address; production API address; authoritative production access method; production database read-only access method; backup-system query entry; restore-drill query entry; log-system entry; monitoring-system entry; alert-system entry; release owner; rollback owner; data owner; technical, product/business, and operations approvers; approved release-window start and end; rollback decision deadline; notification channel; and owner online-confirmation method.

Do not provide credentials to fill these gaps. Provide only aliases, non-secret URLs, role/scope descriptions, approved query locations, named roles, timestamps, and access-controlled evidence references. Configure credentials only in the operator's approved secure environment.

### 13.2 Operations Execution Templates

No generic CLI command is asserted because the production architecture and tools are unknown. Operators must use the authoritative read-only page, API, or query mechanism named by their organization. API requests must use credentials already configured in the approved operator environment and must never print request headers, environment-variable values, cookies, sessions, bearer values, or response payloads containing business or personal data.

#### Evidence T76-01 — Production release gate

- Execution environment / executor: approved release control plane or workstation / release owner.
- Read-only / method: yes / authoritative gate page, API, or check-only CLI.
- Input prerequisites: production environment alias, exact RC `rc-20260712-2`, commit, authoritative gate entry, viewer access.
- Sensitive content prohibited: credentials, headers, configuration values, raw logs, business records.
- Collection steps: select production; bind/filter to the exact RC and commit; run or view check-only gate evaluation; record check totals, warning names, failure names, time, and evidence reference. Do not deploy or remediate.
- Expected redacted output: RC, commit, timestamp/timezone, pass/warning/fail counts, redacted warning/failure summaries, reference.
- Pass / Warning / Fail: Pass when RC and commit match, all required checks pass, and `fail=0`; Warning when `fail=0` but a non-blocking warning has an owner and written approval; Fail for mismatch, missing required check, or any failure.
- Failure handling / blocks Go: stop and retain the redacted summary; yes.

#### Evidence T76-02 — Production env check

- Execution environment / executor: production runtime control plane / operations owner.
- Read-only / method: yes / redacted validation page, API, or check-only CLI.
- Input prerequisites: authoritative required-name policy and viewer/check-only access.
- Sensitive content prohibited: all environment values, secrets, connection strings, credentials, private topology not approved for disclosure.
- Collection steps: validate presence, format, and policy without displaying values; record only counts and missing/invalid variable **names** that are approved for disclosure. Do not edit variables.
- Expected redacted output: required count, passed count, missing count, invalid count, approved redacted names, timestamp, reference.
- Pass / Warning / Fail: Pass when every required check passes; Warning only for explicitly optional checks with owner/rationale; Fail when a required name is missing/invalid or any value is exposed.
- Failure handling / blocks Go: stop; redact exposed output and request a clean rerun; yes.

#### Evidence T76-03 — Production migration status

- Execution environment / executor: approved database/control-plane viewer / data or operations owner.
- Read-only / method: yes / platform status page, metadata API, or organization-approved catalog/status-only query.
- Input prerequisites: production database alias, least-privilege metadata-only identity, expected migration baseline for the RC.
- Sensitive content prohibited: database URL, credentials, row data, SQL containing embedded secrets, full schema dumps.
- Collection steps: inspect applied/pending migration identifiers and drift status using the approved read-only mechanism; record counts and identifiers only. Do not run migrate, resolve, repair, DDL, DML, or advisory writes.
- Expected redacted output: database alias, applied count, pending count/IDs, drift yes/no, expected baseline, timestamp, reference.
- Pass / Warning / Fail: Pass when `pendingMigrations=false`, `drift=false`, and baseline matches; Warning is not accepted for pending/drift and is limited to a documented non-blocking metadata caveat; Fail for pending migration, drift, mismatch, query uncertainty, or write-capable-only access.
- Failure handling / blocks Go: stop and escalate the metadata discrepancy; yes.

#### Evidence T76-04 — Full backup within the last 72 hours

- Execution environment / executor: backup inventory console/API / backup or operations owner.
- Read-only / method: yes / existing-backup inventory page or metadata API.
- Input prerequisites: production backup source alias, viewer role, current time/timezone, policy definition of full backup.
- Sensitive content prohibited: encryption keys, storage credentials/URLs, filenames exposing customer data, backup contents.
- Collection steps: filter existing records to production, full backup, and last 72 hours; record backup ID, completion time, status, type, integrity/checksum verification status, and recoverability reference. **Do not trigger a backup.**
- Expected redacted output: backup ID, type, start/end time, age, status, integrity status, recoverability reference.
- Pass / Warning / Fail: Pass when a successful full backup completed within 72 hours and integrity/recoverability evidence exists; Warning for a still-valid backup with a documented non-critical health advisory; Fail when missing, stale, incomplete, failed, wrong type, or unverifiable.
- Failure handling / blocks Go: record the gap; a new backup requires separate authorization outside Task 76; yes.

#### Evidence T76-05 — Restore drill within the last 90 days

- Execution environment / executor: backup/DR or change-management system / data or operations owner.
- Read-only / method: yes / existing drill-history page or metadata API.
- Input prerequisites: authoritative drill history, viewer access, current time/timezone.
- Sensitive content prohibited: restored data, credentials, private endpoints, customer samples, restore commands with secrets.
- Collection steps: locate the latest completed production-representative isolated drill; record drill ID, completion time, isolated target classification, validations, outcome, and confirmation that the primary was untouched. **Do not execute a restore drill.**
- Expected redacted output: drill ID, date/age, isolated target yes/no, primary touched no, validation counts/summary, result, reference.
- Pass / Warning / Fail: Pass when successful within 90 days, isolated, primary untouched, and validations passed; Warning only for a documented non-blocking observation with approval; Fail when missing, stale, failed, destructive/uncertain, or validations incomplete.
- Failure handling / blocks Go: record the gap; running a drill requires separate authorization outside Task 76; yes.

#### Evidence T76-06 — Active critical alerts

- Execution environment / executor: alert console/API / on-call or operations owner.
- Read-only / method: yes / active-alert view or query API.
- Input prerequisites: production scope, critical-severity definition, viewer access, query timestamp.
- Sensitive content prohibited: credentials, notification webhooks, sensitive payload excerpts, unredacted user/host identifiers.
- Collection steps: filter active production alerts to critical severity; record total, release-blocking count, redacted IDs/summaries, owners, and approved exception references. Do not close, acknowledge, silence, or modify alerts.
- Expected redacted output: query time, active critical count, release-blocking count, redacted IDs, exception/approval references.
- Pass / Warning / Fail: Pass when active critical count is zero, or release-blocking count is zero and every remaining critical alert has written release approval; Warning for approved non-blocking critical alerts; Fail for any unapproved/release-blocking alert or uncertain scope.
- Failure handling / blocks Go: stop release planning and preserve references; yes.

#### Evidence T76-07 — Backup health

- Execution environment / executor: backup/monitoring console / backup or operations owner.
- Read-only / method: yes / health dashboard or metadata API.
- Input prerequisites: authoritative production backup service and viewer access.
- Sensitive content prohibited: credentials, storage paths/tokens, backup contents.
- Collection steps: view current subsystem health, recent job failures, integrity signals, retention-policy status, and capacity warnings; record summaries only. Do not restart, reconfigure, retry, or trigger jobs.
- Expected redacted output: overall status, failed-job count/time range, integrity status, retention status, warning IDs, reference.
- Pass / Warning / Fail: Pass when not critical with no unresolved release-blocking failure; Warning for non-critical owned advisories; Fail for critical/unavailable health, integrity failure, or unresolved blocking job failure.
- Failure handling / blocks Go: record and escalate without changing the system; yes.

#### Evidence T76-08 — System health

- Execution environment / executor: monitoring/control plane / on-call or operations owner.
- Read-only / method: yes / health dashboards and non-mutating health endpoints.
- Input prerequisites: production service/dependency inventory, viewer access, agreed health interval.
- Sensitive content prohibited: credentials, environment values, request bodies, customer identifiers, raw traces containing sensitive data.
- Collection steps: review service and dependency availability, saturation, latency, error signals, and current deployed version; record aggregate values and redacted incident references. Do not restart, scale, or reconfigure.
- Expected redacted output: time range, deployed version, component status counts, aggregate latency/error/availability, warnings, reference.
- Pass / Warning / Fail: Pass when no component is critical and required dependencies are healthy; Warning for explained non-blocking degradation with owner; Fail for critical/unavailable dependency, blocking degradation, or unknown production scope.
- Failure handling / blocks Go: stop and escalate the health state; yes.

#### Evidence T76-09 — Production administrator permission smoke

- Execution environment / executor: production Web/API from approved operator host / technical and operations owners.
- Read-only / method: conditionally yes / page or API using only pre-approved non-mutating identity and authorization endpoints.
- Input prerequisites: non-secret Web/API aliases, approved smoke account roles configured outside chat/Git, exact read-only endpoints, expected `200/401/403`, audit/data-retention approval.
- Sensitive content prohibited: login credentials, cookies, sessions, bearer/header values, profile payloads, user data, raw audit entries.
- Collection steps: authenticate through the approved UI/client without exposing credentials; verify identity endpoint succeeds; verify unauthenticated request returns `401`; verify insufficient role returns `403`; record only status codes and redacted event/reference IDs. Invoke no mutation endpoint.
- Expected redacted output: endpoint aliases, role aliases, expected/actual status-code matrix, redacted audit event IDs, timestamp, reference.
- Pass / Warning / Fail: Pass when the exact matrix matches and expected audit references exist with no side effect; Warning is not accepted for authorization mismatch and is limited to an approved evidence-reference delay; Fail for unexpected access, missing denial, missing required audit event, sensitive output, or any side effect.
- Failure handling / blocks Go: stop immediately; do not alter accounts or permissions; yes.

#### Evidence T76-10 — Production audit export smoke

- Execution environment / executor: production Web/API from approved operator host / data and technical owners.
- Read-only / method: conditionally yes / approved narrow-scope export page or side-effect-free API.
- Input prerequisites: exact endpoint/page, minimum authorized time/filter scope, approved operator identity configured securely, recipient/retention/disposal policy.
- Sensitive content prohibited: credentials, headers, raw exported rows, user-sensitive data, unrestricted export files, secret-bearing audit payloads.
- Collection steps: run the minimum authorized export; validate locally in the approved secure environment that it is non-empty and contains no unintended fields; retain only counts, byte count, redacted export/reference ID, filter description, and disclosure result. Do not attach the export to Git/chat.
- Expected redacted output: filter/time range, `exportedCount`, `csvBytes` or equivalent size, unintended-sensitive-disclosure yes/no, redacted ID/reference.
- Pass / Warning / Fail: Pass when status passes, count and size are greater than zero, scope is minimal, and unintended disclosure is no; Warning is not accepted for possible disclosure and is limited to an approved reference-retention caveat; Fail for empty export, broad scope, error, leakage, or unverifiable source.
- Failure handling / blocks Go: stop; handle/dispose of the export under policy and submit only a newly redacted summary; yes.

#### Evidence T76-11 — Last 30 minutes logs and error rate

- Execution environment / executor: log and monitoring consoles / on-call or operations owner.
- Read-only / method: yes / aggregate dashboards or queries.
- Input prerequisites: production service/index aliases, viewer role, exact 30-minute interval and timezone, approved baseline thresholds.
- Sensitive content prohibited: raw log lines, request/response bodies, credentials, headers, user/employee identifiers, stack traces with configuration values.
- Collection steps: query aggregates for API 5xx, Web errors, sync failures, database errors, and abnormal `401/403` peaks; record counts/rates/trends and redacted incident/query references only. Do not change logging or alerts.
- Expected redacted output: start/end/timezone, request count if available, 5xx count/rate, error-category counts, trend/baseline, redacted query references.
- Pass / Warning / Fail: Pass when no unresolved blocking anomaly or threshold breach exists; Warning for explained non-blocking deviation with owner; Fail for blocking regression, unexplained breach, missing categories, or sensitive raw output.
- Failure handling / blocks Go: stop and retain aggregate evidence; yes.

#### Evidence T76-12 — Release owner online confirmation

- Execution environment / executor: approved coordination/change system / release owner.
- Read-only / method: yes / explicit human confirmation.
- Input prerequisites: named owner/role, approved channel, RC scope, required access expectations.
- Sensitive content prohibited: private contact details, invite tokens, webhook URLs, credentials.
- Collection steps: record explicit timestamped confirmation of online status, RC, role, access readiness, and decision responsibility.
- Expected redacted output: owner name/role, timestamp/timezone, channel/ticket alias, confirmation scope, reference.
- Pass / Warning / Fail: Pass when explicit and current; Warning/Pending when confirmation is time-limited or incomplete; Fail when unavailable, refuses, or lacks required access.
- Failure handling / blocks Go: keep Pending/No-Go; yes.

#### Evidence T76-13 — Rollback owner online confirmation

- Execution environment / executor: approved coordination/change system / rollback owner.
- Read-only / method: yes / explicit human confirmation.
- Input prerequisites: named owner/role, exact rollback point, decision deadline, approved access expectations.
- Sensitive content prohibited: credentials, private contact details, secret recovery locations.
- Collection steps: record explicit timestamped confirmation of online status, rollback authority/access, exact rollback point, and decision deadline. Do not perform rollback.
- Expected redacted output: owner, time/timezone, rollback-point identifier, deadline, channel/ticket reference.
- Pass / Warning / Fail: Pass when all fields are explicit and current; Warning/Pending for incomplete confirmation; Fail when owner/access/point/deadline is absent or invalid.
- Failure handling / blocks Go: keep Pending/No-Go; yes.

#### Evidence T76-14 — Release window confirmation

- Execution environment / executor: change-management system / release owner and required approvers.
- Read-only / method: yes / approved change/window record.
- Input prerequisites: start/end timezone, rollback deadline, owners, coordination channel, approval policy.
- Sensitive content prohibited: channel secrets/webhooks, credentials, private contact data.
- Collection steps: inspect the approved record; capture start, end, timezone, rollback deadline, owners, channel alias, and approval reference. Do not enter or start the window from this task.
- Expected redacted output: window ID, start/end/timezone, rollback deadline, owner roles, channel alias, approval reference.
- Pass / Warning / Fail: Pass when current, approved, internally consistent, and staffed; Warning/Pending for a proposed but unapproved window; Fail for expired/conflicting/missing window or owners.
- Failure handling / blocks Go: remain outside the release window; yes.

#### Evidence T76-15 — Human approval confirmation

- Execution environment / executor: approval/change-management system / technical, product/business, operations, and applicable data approvers.
- Read-only / method: yes / approval record and explicit human decisions.
- Input prerequisites: required-role matrix, complete evidence set, exact RC/commit, approval policy.
- Sensitive content prohibited: credentials, private contact data, confidential discussion payloads not approved for the release record.
- Collection steps: verify each required identity/role, timestamp/timezone, decision, scope, and evidence reference; record N/A only with approver and rationale. Silence, chat presence, or verbal-only statements are not approval.
- Expected redacted output: role, approver name/role, time/timezone, decision, scope, evidence references, N/A rationale if applicable.
- Pass / Warning / Fail: Pass only when every required approval is explicit and complete; Warning/Pending for any incomplete or conditional approval; Fail for rejection, expired approval, RC mismatch, or unverifiable identity/reference.
- Failure handling / blocks Go: keep approval Pending and decision No-Go; yes.

### 13.3 Unified Redacted Evidence Return Template

Operations must return one block per evidence item. Do not combine environments or time ranges ambiguously.

```text
Evidence:
Environment:
Executed by:
Executed at:
Method:
Read-only: yes/no
Result: Pass/Warning/Fail/Not available
Summary:
Counts:
IDs:
Time range:
Warnings:
Sensitive values included: no
Raw credentials included: no
Attachment/reference:
Approver confirmation:
```

Raw credentials are not accepted. Do not submit a complete database URL, cookie, session, bearer value, authorization header, token, password, secret, private key, or unredacted user-sensitive data. If any returned material contains such a value, it must **not** be written into this document; reject it, remove it from the handoff channel according to organizational incident-handling policy, and request a newly generated redacted result.

### 13.4 Task 76 Evidence Status and Decision

| Item | Status | Reason / next step |
| --- | --- | --- |
| T76-01 through T76-11 production evidence | **Not available** | No production access or authoritative source was supplied; operations must execute the templates and return real, redacted production results |
| T76-12 release owner confirmation | **Pending** | Release owner and confirmation are not provided |
| T76-13 rollback owner confirmation | **Pending** | Rollback owner, access confirmation, rollback point, and deadline are not provided |
| T76-14 release window confirmation | **Pending** | No approved window or coordination channel is provided |
| T76-15 human approvals | **Pending** | Required approvers and explicit decisions are not provided |
| Production decision | **No-Go: production evidence unavailable** | Required real production evidence and approvals are incomplete |

Task 76 is not a production release. It can advance only as far as completion of real, read-only, redacted production evidence collection. Until every Go condition in this record is satisfied, the RC must not enter the production release window.

## 14. Task 77 — Production Server and Deployment Baseline

Task 77 established an infrastructure baseline only. It did not deploy `rc-20260712-2`, run a migration, create an application database or business administrator, import business data, or collect production application evidence. The environment remains an empty application shell and must not be treated as a production evidence pass.

### 14.1 Confirmed Server Plan

| Item | Confirmed state |
| --- | --- |
| Provider | DigitalOcean Droplet, Singapore region |
| Operating system | Ubuntu Server 24.04.4 LTS, x86_64 |
| Capacity | 4 vCPU, 8 GB RAM, 240 GB SSD-class Droplet storage |
| Database plan | Low-cost single-host PostgreSQL 16; managed database deferred |
| Staging plan | Not established; current host is the production-baseline target only |
| Operations access | Tailscale private network plus per-device ED25519 SSH key |
| Public SSH | Blocked by DigitalOcean Cloud Firewall; root and password SSH authentication disabled |
| Public ingress | TCP 80/443; UDP 41641 for Tailscale direct connectivity |
| Database ingress | PostgreSQL 5432 listens on loopback only and is not publicly exposed |

### 14.2 Installed Runtime and Service Baseline

| Component | Verified state |
| --- | --- |
| Docker Engine / Compose | Docker Engine 29.6.2 and Compose 5.3.1; service active/enabled; no containers |
| Git | 2.43.0 |
| Nginx | 1.24.0; active/enabled; placeholder sites return `503` because no application is deployed |
| Node.js / Corepack / pnpm | Node.js 22.23.1, Corepack 0.34.6, pnpm 10.32.1 |
| PostgreSQL | PostgreSQL 16.14; cluster online; loopback listeners only |
| TLS | One Let's Encrypt certificate covers both production hostnames; Certbot timer enabled; simulated renewal succeeded through Cloudflare |
| Host monitoring | DigitalOcean `do-agent` active/enabled |
| Brute-force protection | fail2ban active/enabled with the `sshd` jail |
| System state | No pending package update and no failed systemd unit at verification |

### 14.3 Domain, HTTPS, and Edge Status

| Item | Status |
| --- | --- |
| Web hostname | `admin-salary.lovemiemie.com` confirmed through Cloudflare |
| API hostname | `api-salary.lovemiemie.com` confirmed through Cloudflare |
| Origin TLS | Valid public certificate installed at the Nginx origin; certificate contents and private key are not recorded here |
| Cloudflare mode | Hostname-scoped strict origin validation configured for the two salary hostnames; other zone hostnames retain their existing mode |
| HTTP behavior | HTTP redirects to HTTPS |
| HTTPS behavior | Cloudflare reaches the origin successfully; both hostnames intentionally return `503` until an approved deployment occurs |

### 14.4 Deployment Directory and Credential Boundary

The following server-side layout exists:

```text
/opt/salary-settlement-admin
/opt/salary-settlement-admin/releases
/opt/salary-settlement-admin/shared
/opt/salary-settlement-admin/shared/.env
/opt/salary-settlement-admin/shared/logs
/opt/salary-settlement-admin/backups
```

- `salaryapp` is a non-login operating-system service identity; it is not a business administrator account.
- The shared `.env` file is empty and permission-restricted to `0640 root:salaryapp`.
- No credential value is recorded in Git or this approval record.
- `current` does not exist because no release has been deployed or approved for activation.
- Release artifacts, shared configuration, logs, and backups remain separated.

Required future environment-variable categories remain: `NODE_ENV`, `PORT`, `DATABASE_URL`, JWT/session secret names, CORS allowed origins, administrator bootstrap policy, audit-export settings, backup settings, release-gate settings, and log level. Values must be installed through an approved server-side secret process and must never be pasted into this record.

### 14.5 Logging, Backup, Monitoring, and Alert Status

| Control | Status | Boundary / next action |
| --- | --- | --- |
| Nginx log rotation | **Configured** | Ubuntu logrotate policy installed |
| PostgreSQL log rotation | **Configured** | Ubuntu PostgreSQL logrotate policy installed |
| Application file log rotation | **Configured** | Daily rotation, 14 files, compression, and 50 MB early-rotation threshold; no application log exists yet |
| Docker log cap | **Configured** | Default `json-file`, 10 MB per file, five files per future container |
| Daily PostgreSQL logical backup | **Configured locally** | Persistent systemd timer scheduled daily; 30-day local retention |
| Initial baseline backup | **Succeeded** | Gzip and SHA-256 verification passed; mode `0640 root:postgres`; it represents the empty baseline cluster and is not production evidence |
| Off-host backup copy | **Not configured / release-blocking** | The operations owner declined paid object storage for this baseline; no separate machine or other off-host destination is configured |
| Restore drill | **Succeeded for the empty baseline** | The latest local logical backup was restored into an isolated PostgreSQL 16 container with `network=none` and no host port bindings; the container exited and no restore process remained; the host cluster stayed active and was not modified |
| Host metrics | **Configured and visible** | DigitalOcean metrics agent active; CPU, memory, load, disk, and bandwidth charts were confirmed in the Droplet dashboard |
| CPU/RAM/disk/load alerts | **Configured** | Tag-scoped policies target only `salary-backend`: CPU above 80% for 5 minutes, memory above 85% for 5 minutes, disk above 80% for 5 minutes, and 5-minute load above 4 for 5 minutes; notifications use the already verified operations email |
| API, 5xx, DB-error, backup-failure alerts | **Pending / release-blocking** | Application is not deployed and alert routes are not configured |

The isolated drill completed at `2026-07-20T13:00:20Z` from `postgres-full-20260720T120133Z.sql.gz` (SHA-256 `55e54441dc79c431f7cfcbcf21151ec6bb5ecbc03f8e0eb11cca60532b49482c`). The target reported PostgreSQL version number `160014`, two non-template databases, and one non-system source role. Its server-side report is `/opt/salary-settlement-admin/backups/restore-drills/restore-drill-20260720T130020Z.log` with restricted backup-directory access.

The local backup and successful empty-baseline restore drill do not satisfy the release requirement for a successful full production backup within 72 hours. They also do not mitigate loss of the Droplet because no off-host copy exists. No backup ID, checksum, or restore report in this section may be copied into Task 76 as a production evidence pass.

### 14.6 Operations Initialization Runbook Summary

The executed and verified initialization sequence was:

1. Create the Ubuntu 24.04 LTS Droplet and confirm capacity, public networking, and region.
2. Install an ED25519 SSH public key, create the non-root `salaryops` sudo user, verify a second session, then disable root and password SSH authentication.
3. Install Tailscale on the server and operator workstation, verify private-network SSH, then remove public TCP 22 from the Cloud Firewall.
4. Permit public TCP 80/443 and Tailscale UDP 41641; keep PostgreSQL and application ports off public ingress.
5. Apply system updates, reboot once, and verify zero failed services.
6. Install Docker/Compose, Git, Nginx, Node.js 22, Corepack, pnpm 10.32.1, PostgreSQL 16, Certbot, fail2ban, and logrotate.
7. Create the permission-restricted deployment layout and empty shared environment file without inserting credentials.
8. Configure Nginx placeholder sites, issue the two-hostname certificate, verify renewal, restore Cloudflare proxying, and apply hostname-scoped strict origin validation.
9. Configure bounded Docker and application logs, enable DigitalOcean host metrics, establish the local daily PostgreSQL backup timer, and create tag-scoped CPU, memory, disk, and load alerts to the verified operations email.
10. Restore the latest empty-baseline logical backup into an ephemeral PostgreSQL 16 container with networking disabled and no host port binding; verify the checksum, restored database/role counts, host-cluster isolation, container exit, and removal of the temporary drill script.
11. Verify service states, listeners, timers, HTTPS behavior, pending updates, failed units, and removal of temporary initialization scripts.

Failure handling remains conservative: retain Tailscale and DigitalOcean Console recovery access; validate Nginx and SSH configuration before reload; keep public SSH closed; do not expose port 5432 or an application port; stop on any backup, checksum, service, certificate, or listener mismatch; never remediate by deploying the RC or running migration from this baseline task.

### 14.7 Task 77 Readiness Decision

| Area | Status |
| --- | --- |
| Server, OS, capacity | **Confirmed** |
| SSH and network security baseline | **Confirmed** |
| Docker/Nginx/Node/pnpm/Git runtime | **Confirmed** |
| Single-host PostgreSQL 16 baseline | **Confirmed** |
| Domains and HTTPS | **Confirmed** |
| Deployment directories and empty credential boundary | **Confirmed** |
| Local logs and local backup timer | **Confirmed as baseline only** |
| Off-host backup | **Not configured / release-blocking by owner decision** |
| Isolated restore drill | **Confirmed for the empty baseline only** |
| Host CPU, memory, disk, and load alerts | **Configured to the verified operations email** |
| Application, database-error, and backup-failure alerting | **Pending until the application and approved notification integration exist** |
| Application deployment and real production evidence | **Not performed / not available** |

Historical decision at Task 77 close: **No-Go: production environment not ready**.

Task 77 is not a production release and does not admit the RC into a release window. The environment baseline, empty-baseline restore mechanism, and host-level alerts are materially established. Off-host backup remains absent by owner decision, and application/database/backup-failure alerting, application deployment under separate authorization, real redacted production evidence, and all required human approvals remain incomplete. Only after those controls and Task 76 evidence pass may a release window be considered.

## 15. Task 78 — Production Application Deployment Plan and Release Package Preparation

Task 78 prepared repository-side deployment configuration and operational plans only. It did not connect to production, deploy `rc-20260712-2`, execute migrations, create the application database/role or any business/administrator account, import data, alter a tag, or collect production evidence.

| Area | Task 78 result |
| --- | --- |
| Recommended architecture | Cloudflare -> host Nginx -> loopback-only Web/API containers -> existing host PostgreSQL 16 |
| Deployment configuration | Created API/Web multi-stage Dockerfiles, production Compose model, Web static Nginx config, host Nginx template, Docker ignore rules, and credential-free environment template |
| Runbooks | Created separate production deployment and rollback plans under `deploy/runbooks/` |
| Database selection | Existing system PostgreSQL 16; Compose deliberately does not create another PostgreSQL service |
| Database initialization | Planned only: database `salary_settlement`, least-privilege role `salary_app`, server-only `DATABASE_URL` |
| Migration execution | **Not executed**; status must be collected and any deploy requires explicit second authorization in a future release task |
| Production deployment | **Not executed** |
| Production evidence | **Not collected**; plans/templates are not evidence passes |
| Off-host backup | **Not configured / risk remains** |
| Sensitive credentials | None added; populated environment values remain server-only |

Historical decision at Task 78 close: **No-Go: production deployment plan prepared only**.

Task 78 is not a production release and cannot enter a release window. Completion means only that the deployment plan and release package preparation are complete. A real production deployment requires a separate task, explicit second authorization, resolved release blockers, named owners, and real redacted production evidence.

## 16. 任务79：无异机备份风险接受与生产部署前门禁复核

任务79仅记录阶段性风险接受并复核进入任务80（生产部署二次授权任务）的前置条件。本任务未连接或修改生产服务器，未部署应用，未执行 migration，未创建生产数据库、数据库用户或管理员账号，未写入生产数据库或真实业务数据，也未采集真实应用生产 evidence。

### 16.1 用户风险接受声明（逐字记录）

> 当前接受无异机备份风险。
> 本阶段仅保留本机每日备份 + 隔离恢复演练。
> Droplet 整机故障时存在数据不可恢复风险。
> 后续进入正式长期运营前补异机备份。

该声明表示阶段性接受残余风险，不表示异机备份已经配置、验证或通过，也不表示风险已经消除。

| 风险记录项 | 任务79结论 |
| --- | --- |
| 风险类型 | 数据保全风险 |
| 风险范围 | Droplet 整机故障、磁盘损坏、账号误操作、区域性故障时可能不可恢复 |
| 当前缓解措施 | 本机每日 PostgreSQL 逻辑备份、已成功完成的空基线隔离恢复演练 |
| 当前未缓解项 | 异机备份缺失；Droplet 或同机存储整体丢失时，本机备份可能同时丢失 |
| 是否阻断任务80 | 不阻断进入“部署二次授权准备”，但阻断无条件生产 Go |
| 是否需要审批人确认 | 需要；本节已记录用户声明，任务80仍须取得可核验的明确审批人确认与二次操作授权 |
| 长期处置 | 正式长期运营前补充并验证异机备份 |

### 16.2 仓库与 RC 复核

| 检查项 | 结果 | 证据边界 |
| --- | --- | --- |
| 当前 RC | **Pass** | `rc-20260712-2^{commit}` 解析为 `9f8f8f576dde54355983b96525335e94c55c8b32`；未移动、删除或重打 tag |
| 工作区范围 | **Pass** | 变更仅为任务77/78/79相关部署文档、Docker/Nginx/Compose/env 模板与 ignore 配置；未发现业务代码、schema 或 migration 变更 |
| 差异格式 | **Pass** | `git diff --check` 通过 |
| 敏感信息 | **Pass（仅限本次仓库扫描）** | 未发现真实 token、password、secret、private key、带凭据的 database URL、cookie、session 或 bearer 值；`.env.production.example` 仅含占位符与非敏感配置 |

### 16.3 任务77基础设施基线复核

| 基线项 | 结果 |
| --- | --- |
| 服务器与系统 | **Confirmed**：Ubuntu Server；4 vCPU / 8 GB RAM / 240 GB SSD-class Droplet storage |
| 边缘与入口 | **Confirmed**：Cloudflare 代理、HTTPS 证书、Certbot 自动续期、Nginx `503` 占位站点；对外规划仅 80/443 |
| 运行时与数据库 | **Confirmed**：Docker/Compose、Node.js 22、pnpm 10.32.1、PostgreSQL 16 |
| 主机保护与监控 | **Confirmed**：fail2ban、do-agent、CPU/内存/磁盘/负载邮件告警 |
| 日志控制 | **Confirmed**：Docker 日志限制与应用日志 logrotate 已配置 |
| 本机备份 | **Confirmed as baseline only**：PostgreSQL 每日本机逻辑备份已配置，不是异机备份，也不是生产 evidence Pass |
| 隔离恢复演练 | **Confirmed for the empty baseline only**：恢复演练成功，未修改主机 PostgreSQL；不是生产 evidence Pass |
| 异机备份 | **Not configured / risk accepted for this stage**：风险被阶段性接受，但控制本身未通过、风险未消除 |

任务77基础设施基线在其既定范围内完整。应用级告警与真实生产证据仍需在应用部署后采集，不能由该基线推定为 Pass。

### 16.4 任务78部署准备复核

以下产物均存在且内容与当前部署架构一致：

- `docker-compose.prod.yml`
- `apps/api/Dockerfile`
- `apps/web/Dockerfile`
- `apps/web/nginx.conf`
- `.env.production.example`
- `deploy/production-architecture.md`
- `deploy/nginx/salary-production.conf.template`
- `deploy/runbooks/production-deploy.md`
- `deploy/runbooks/production-rollback.md`
- `docs/release/production-approval-record.md`

复核确认：Compose 仅管理 `api`/`web`，不启动第二套 PostgreSQL；API/Web 分别只绑定 `127.0.0.1:3000` 与 `127.0.0.1:8080`；主机 Nginx 模板对外监听 80/443；API 和 PostgreSQL 均不规划公网裸露；填充后的生产 `.env` 只允许位于服务器 `/opt/salary-settlement-admin/shared/.env`，仓库模板不含真实凭据；部署与回滚 Runbook 均明确了步骤、停止条件、证据和回滚边界。

本地 `docker compose -f docker-compose.prod.yml config --quiet` 静态解析通过。RC 的已有 CI 构建证据与任务78镜像定义/Compose 静态准备可作为“进入任务80准备”的依据，但生产镜像实际构建或拉取、digest/provenance 绑定和生产运行验证均未执行，不能作为 production evidence Pass。

当前 PostgreSQL 16 基线仅监听 loopback，而 Compose API 使用 Docker bridge host gateway。任务78架构已规划最小 Docker bridge listener 与收窄的 `pg_hba.conf` 规则；任务79未执行该服务器配置变更。任务80若要启动 API，必须把这项服务器配置变更纳入明确授权，并再次证明 5432 未公网开放。

Migration 仍未执行；production deploy 仍未执行；生产数据库仍未写入；真实应用生产 evidence 仍未采集。

### 16.5 生产部署前门禁复核

#### A. 允许进入任务80“生产部署二次授权准备”的条件

- [x] 服务器基线完成。
- [x] 部署配置完成。
- [x] 发布与回滚 Runbook 完成。
- [x] 本机每日备份完成。
- [x] 空基线隔离恢复演练完成。
- [x] 无异机备份风险已被用户阶段性接受；该项不是异机备份 Pass。
- [x] RC tag 核验通过。
- [x] RC 已有构建证据，镜像/Compose 定义准备与本地 Compose 静态解析通过；生产镜像 digest 验证仍属于任务80。
- [x] 本次复核未发现真实敏感值。
- [x] 部署、migration、生产启动和流量切换仍需任务80逐项二次授权。

结论：具备进入任务80进行二次授权和受控执行准备的条件；这不等于取得生产 Go，也不允许直接进入发布窗口。

#### B. 当前阻断生产 Go 的条件

- [ ] 应用尚未部署。
- [ ] 生产 `.env` 尚未由用户在服务器安全填写并验证。
- [ ] 生产应用数据库与最小权限数据库用户尚未创建。
- [ ] PostgreSQL 最小 Docker bridge listener / `pg_hba.conf` 尚未授权配置和验证。
- [ ] Migration 尚未执行。
- [ ] Release gate 尚未在生产执行。
- [ ] Env check 尚未在生产执行。
- [ ] Migration status 尚未在生产执行。
- [ ] Admin permission smoke 尚未在生产执行。
- [ ] Audit export smoke 尚未在生产执行。
- [ ] 应用健康、日志、错误率、重启与资源指标尚未观察。
- [ ] 生产镜像 digest/provenance 与 RC 的绑定尚未在生产发布上下文核验。
- [ ] 发布窗口、release/rollback owners 与完整人工审批尚未确认。
- [ ] 异机备份仍缺失；当前仅为阶段性风险接受，不是控制通过或风险消除。

### 16.6 任务80必须取得的明确二次授权

任务80建议标题：**任务80：生产部署二次授权、受控执行与真实生产证据采集**。

用户必须明确授权下列动作及其执行窗口；未授权项不得执行：

1. 允许连接生产服务器。
2. 允许创建生产应用数据库。
3. 允许创建最小权限生产数据库用户。
4. 允许为 API 容器配置最小 PostgreSQL Docker bridge listener 与收窄的 `pg_hba.conf` 规则，并验证 5432 不公网开放。
5. 允许由用户在服务器 SSH 会话内填写，或通过安全方式写入 `/opt/salary-settlement-admin/shared/.env`。
6. 允许上传或构建与 `rc-20260712-2` / `9f8f8f576dde54355983b96525335e94c55c8b32` 对应的生产镜像或发布包，并核验 immutable digest/provenance。
7. 允许执行 production env check。
8. 允许执行 migration status。
9. 允许在批准的发布窗口内执行 migration deploy。
10. 允许启动 API/Web 容器。
11. 允许切换 Nginx upstream。
12. 允许执行 health check。
13. 允许执行 admin permission smoke；不得据此默认授权创建生产管理员账号。
14. 允许执行 audit export smoke。
15. 允许观察日志、错误率、容器重启、数据库连接与主机资源指标。
16. 允许失败时按 `deploy/runbooks/production-rollback.md` 执行已审批范围内的回滚；数据库恢复或数据修复仍需单独的破坏性操作授权。

不得要求用户把真实密码、密钥或 `DATABASE_URL` 粘贴到聊天、Git、审批记录或 evidence。凭据应由用户在服务器 SSH 会话内填写，或通过批准的安全方式写入服务器 `.env`，检查过程不得打印值。Migration deploy 和生产 API/Web 启动必须在任务80再次明确授权后才能执行。

### 16.7 任务79决定

| 决策项 | 结果 |
| --- | --- |
| 风险接受是否已记录 | **Yes**：已逐字记录用户声明及残余风险 |
| 是否发现阻断进入任务80的问题 | **No**：可进入二次授权准备；PostgreSQL bridge 连接配置必须纳入任务80授权 |
| 是否允许直接生产发布 | **No** |
| 任务79收口时的历史决定 | **No-Go：仅允许进入生产部署二次授权任务，不能直接进入生产发布窗口** |

本任务不是生产发布。本任务最多允许进入“生产部署二次授权任务”。当前仍不能直接进入生产发布窗口；任务77/78的基线、计划、静态检查和风险接受均不得当作真实 production evidence Pass。

## 17. 任务80：受控生产部署执行记录（2026-07-21）

本节记录一次真实生产环境的受控执行尝试。执行环境为 DigitalOcean 生产 Droplet，执行人记录为 `salaryops / Codex-assisted`，执行时间跨 `2026-07-21–2026-07-23`。本节不记录生产 IP、SSH 密钥路径、密码、`DATABASE_URL`、token、cookie、session、bearer、private key 或任何真实 secret。

| 阶段 / 证据项 | 结果 | 脱敏证据摘要 |
| --- | --- | --- |
| 本地与 RC 核验 | **Pass** | `rc-20260712-2^{commit}` 精确解析为 `9f8f8f576dde54355983b96525335e94c55c8b32`；`git diff --check` 通过；工作区仅有任务77–80相关部署文档、Docker/Compose/Nginx/env 示例与 ignore 配置；未发现 schema、migration 或业务源码变更；真实 `.env` 未被跟踪 |
| 生产 SSH 连接 | **Pass** | 已使用 `salaryops` 连接真实生产主机；主机身份、Ubuntu 内核与 4 vCPU / 8 GB / 240 GB 基线一致 |
| Nginx / Docker / PostgreSQL | **Pass（服务状态）** | 三项服务均为 `active`；`systemctl --failed --no-legend` 无 failed unit |
| 容量 | **Pass** | 根文件系统约 232 GB，已用约 4.0 GB（2%），可用约 228 GB；内存约 7.8 GiB，可用约 7.1 GiB |
| 公网占位状态 | **Pass** | Admin/API 两个 HTTPS 域名均由 Cloudflare 返回 `503 Service Unavailable` 占位响应，未切换到应用 |
| Docker 容器清单 | **Pass** | 用户在自己控制的 SSH 会话内完成 sudo 认证并执行只读检查；`docker ps -a` 返回空清单，未发现未知或既有应用容器 |
| 备份 timer/service 只读复核 | **Pass** | timer 为 `enabled`、`active (waiting)`，计划每日 `02:15 UTC` 加最多 15 分钟随机延迟；service 调用受限的 root-owned 备份脚本，systemd 写入范围限制为专用备份目录 |
| 上线前 full backup | **Pass** | 初始门禁备份：`2026-07-21 11:57:40 UTC`，`postgres-full-20260721T115740Z.sql.gz`，SHA-256 `00c91a7c69f818de3d17f5044a3b98be4b51b451b352190e876cc9386e6fa2e2`。紧邻 migration 的第二份 full backup：`2026-07-21 13:16:29 UTC`，`postgres-full-20260721T131629Z.sql.gz`，1453 bytes，SHA-256 `7adf16b9e4a1539cf59f44ec17afe857e70a3ad75331564b84763c23bea697fe`。两者均 `Result=success`、`ExecMainStatus=0`、gzip 可读、`0640 root:postgres` |
| 数据库 / 最小权限 role / PostgreSQL bridge | **Pass** | 创建空数据库 `salary_settlement_prod`（owner=`postgres`）与登录 role `salary_app`；role 为非 superuser/createdb/createrole/inherit/replication/bypassrls，连接上限 20；仅授予数据库 CONNECT/TEMPORARY 与 `public` schema USAGE/CREATE。固定外部 Docker 网络 `172.30.80.0/24`，PostgreSQL 仅监听 loopback 和 `172.30.80.1`，HBA 仅允许该数据库/role/网段通过 hostssl + SCRAM。真实临时容器验证 client=`172.30.80.2`、server=`172.30.80.1`、SSL=true |
| 生产 `.env` | **Pass** | `/opt/salary-settlement-admin/shared/.env` 已由服务器端安全脚本原子写入；`0640 root:salaryapp`；必需变量名均为 configured，未输出任何值；原零字节占位保留为 root-only 时间戳回滚文件 |
| RC 发布包 / 镜像 | **Pass** | 从 `rc-20260712-2` 直接生成 408-entry source archive，SHA-256 `8685fbc6c23a34c689e612cc233be6cad1b499c22c4f381ba6bf6038ff525664`；服务器复算一致；仅叠加已审查部署 overlay，真实 `.env` 不在构建上下文。API image ID `sha256:6fe7b1df6668086ec468fe5ff0fbf9508456681cec35746f296ff275b860b340`；Web image ID `sha256:be03b333e8a0d87b847a282fb355d6cc86a576cf1958d275740c1dd8d4c46ee7`；migration tool image ID `sha256:42fe812e84a0a3b961f1438547270d640900008d2f9768c628a51aa5fef77afd` |
| Production env check | **Pass** | 在 RC API image 内执行生产专用等价检查；23/23 pass、failed=0、exit 0；仅输出变量名和状态，无值泄露 |
| Migration status | **Pass with pending migrations** | Prisma schema valid；真实生产 DB SSL 连接成功；17 个 RC migration 全部 pending。目标为新建空库：`_prisma_migrations` 不存在，public tables/views/sequences 均为 0，因此无既有 schema、迁移历史分叉或 drift；status exit 1 仅表示 pending |
| Migration deploy | **Pass** | 紧邻 migration 的 full backup 完成后，从 RC migration image 执行 `prisma migrate deploy`；17/17 migration 成功应用，exit 0。复核 status 为 database schema up to date、exit 0；`_prisma_migrations` rows=17、completed=17、incomplete=0；PostgreSQL services 均 active |
| API/Web 启动与 loopback health | **Pass** | API/Web 以指定 RC image 启动并在 6 秒内 healthy；restart policy=`unless-stopped`、restart count=0；仅发布 `127.0.0.1:3000/8080`。API live/ready、Web health/root 均 HTTP 200；启动日志 error/exception 与疑似凭据 URL 计数均为 0 |
| Nginx 切换 / public health | **Pass after one successful automatic rollback** | `2026-07-23` 候选独立 `nginx -t` 通过，原占位配置与 symlink 已备份。Attempt 1 的即时 TLS/SNI health 命中旧 503 worker，脚本自动恢复 baseline 并 reload；日志无 upstream/TLS 错误。修订脚本加入每 endpoint 最多 15 秒有限重试后 Attempt 2 成功：Admin root 在 attempt 2 HTTP 200，API live/ready 在 attempt 1 HTTP 200；active target 为 `salary-production-rc-20260712-2`，最终 `nginx -t` 通过。发布工作站经 Cloudflare 验证 Admin root、API live/ready 均 HTTP 200、TLS verify=0、无 525/526 |
| Admin permission / audit export / release gate smoke | **Fail / Pending** | 脱敏基线查询确认 admin users、active admins、active super admins、audit logs、audit export events 均为 0；未创建生产管理员，也未用自生成事件冒充既有审计记录，因此 admin permission 与 audit export smoke 无法执行。真实 production release gate：pass=24、warning=5、fail=8、exit 1；required fails 为 `BACKUP_HEALTH_NOT_CRITICAL`、`ENABLED_SUPER_ADMIN_PRESENT`、`NO_DISABLED_ONLY_SUPER_ADMIN`、`PERMISSIONS_TABLE_COMPLETE`、`RECENT_FULL_BACKUP_WITHIN_72H`、`RECENT_RESTORE_DRILL_WITHIN_90D`、`SUPER_ADMIN_HAS_RELEASE_GATE_PERMISSIONS`、`SYSTEM_HEALTH_NOT_CRITICAL` |
| 日志、错误率与告警观察 | **Partial Pass / Pending** | API/Web 启动后十分钟日志抽查：两容器 error/exception/fatal/connection-refused 匹配均为 0，疑似数据库 URL/Authorization/Bearer 泄露匹配均为 0。由于 release gate 已出现 required failures 并触发停止，未完成完整观察窗与独立 active-alert 采集 |
| 回滚 | **Pass** | 因 release gate `fail=8` 执行 No-Go 回滚。首次回滚已恢复 baseline symlink，但即时检查命中 Nginx 平滑重载旧 worker 的 200，脚本安全停止并未继续移除容器；修订为最多 15 秒有限重试后重跑成功。`ROLLBACK_ID=20260723T143525Z`；Admin/API 本机 TLS 均 HTTP 503（attempt 1）；API/Web 容器 `compose down` 2/2 removed；日志保存在受限目录 `/opt/salary-settlement-admin/logs/task80-rollback-20260723T143525Z`。发布工作站随后确认 Admin root、API live/ready 均为外部 HTTPS 503、TLS verify=0；Nginx/PostgreSQL 均 active，active target 为 `salary-baseline` |
| 敏感信息 | **Not found / Not collected** | 未读取或记录任何真实凭据值 |

### 17.1 停止原因与任务80历史决定

阶段二最初因 sudo 交互认证边界暂停；用户随后在自己控制的 SSH 会话内完成认证并提供脱敏输出。后续 backup、数据库最小权限配置、生产 `.env`、RC 镜像、production env check、migration deploy、loopback health 与 Nginx 流量切换均按受控顺序执行并取得真实证据。部署技术路径成功，但最终 release gate 明确返回 `fail=8`；生产库又不存在可用于管理员权限和审计导出 smoke 的既有管理员或审计记录。按“部署成功不等于 Go”的门禁规则停止发布，并完成流量与容器回滚。

任务80收口时的历史决定：**No-Go（最终）**。生产公网入口已恢复 baseline 503，API/Web 容器已停止并移除；Nginx 与 PostgreSQL 保持 active。为保留调查和后续受控发布条件，本次不执行数据库恢复或数据修复：已应用的 17 个 migration、空业务库、最小权限 role、生产 `.env`、RC images、备份与回滚日志均保留。任何重新发布必须作为新的明确授权窗口，先处理并重新验证全部 required gate failures，补齐可审计的管理员/权限/健康/备份与 restore-drill 证据，再重新执行 preflight、smoke、观察和 Go/No-Go。

## 18. 任务81：生产 Release Gate 根因修复与基础数据初始化（2026-07-23）

本节记录在生产公网入口维持 baseline 503、API/Web 长期容器保持停止的前提下，对任务80 release gate 的 8 个 required fail 根因进行受控修复和只读复核。执行环境为 DigitalOcean 生产 Droplet，经 Tailscale 私网入口连接；执行人为 `salaryops / Codex-assisted`。执行时间约为 `2026-07-23T14:45Z–15:34Z`。使用的唯一 RC 为 `rc-20260712-2`，commit 为 `9f8f8f576dde54355983b96525335e94c55c8b32`。

本任务没有执行 production deploy、migration deploy、Nginx 切流或公网业务恢复，没有移动、删除或重打 RC tag，也没有读取或记录生产 `.env`、`DATABASE_URL` 或任何真实凭据值。

| 阶段 / 证据项 | 结果 | 脱敏证据摘要 |
| --- | --- | --- |
| 本地与 RC 核验 | **Pass** | tag 精确指向指定 commit；`git diff --check` 通过；未发现业务代码、schema 或 migration 非授权变更 |
| 生产只读预检 | **Pass** | Nginx、Docker、PostgreSQL 均 active；failed units=0；长期容器清单为空；Nginx target 为 `salary-baseline`；Admin/API 公网均为 HTTPS 503 |
| Migration 状态 | **Pass** | migrations total=17、completed=17、incomplete=0；本任务未执行新 migration |
| 角色与权限初始化 | **Pass** | 使用 RC 自带幂等 seed；roles=6、permissions=37、role_permissions=70；`super_admin` 拥有全部 37 项 RC 权限，其中 `release_gate.read` / `release_gate.run` 共 2 项 |
| 生产管理员 | **Pass** | 新建 1 个 active 管理员，未覆盖既有账号；账号标识已脱敏且未在本文记录原值；绑定 active `super_admin`；密码仅由用户在服务器终端隐藏输入，未进入聊天、文档或命令历史 |
| 加密 full backup | **Pass** | `postgres-full-20260723T151718Z.sql.gz.enc`；completedAt=`2026-07-23T15:19:11Z`；12,448 bytes；SHA-256=`a373111b6185d6351d60c21da8161a84b242266d427c30f48d240bcb319c10c2`；AES-256-CBC/PBKDF2；流式解密后 gzip 校验通过；`0640 root:postgres`；加密口令未记录 |
| Restore drill evidence | **Pass with classification retained** | 登记任务77真实隔离演练：completedAt=`2026-07-20T13:00:20Z`、status=succeeded、network=none、destructiveToPrimary=false；源备份 SHA-256=`55e54441dc79c431f7cfcbcf21151ec6bb5ecbc03f8e0eb11cca60532b49482c`；明确保留“production-host empty-baseline isolated drill”分类，不冒充包含业务数据的恢复演练 |
| Evidence 与初始化审计 | **Pass** | `backup_records`=1、`restore_drill_records`=1；写入 3 条真实初始化/evidence 登记审计；全部写入幂等并在事务后只读核验 |
| Backup health | **Pass** | status=ok、critical count=0；72 小时内存在成功、加密、checksum/解密校验通过的 full backup；最新 backup 非 failed |
| System health | **Pass with warning** | status=warning、critical count=0；满足 `SYSTEM_HEALTH_NOT_CRITICAL`；active/silenced critical alerts=0 |
| Admin permission smoke | **Pass / Partial** | 登录 HTTP 200；未登录 `/me` HTTP 401；super_admin active chain pass；permission count=37；release gate read/run 均 pass；因不存在低权账号，按任务规则未为 403 smoke 创建额外账号，该子项为 Pending/Not available |
| Audit export smoke | **Pass** | 最小过滤导出 HTTP 200；exportedCount=1；csvBytes=497；sensitiveLeak=false；CSV 未输出到聊天并在服务器临时目录中删除；应用写入真实 `audit_logs.exported` success 审计 |
| Production release gate | **Warning / required fail cleared** | generatedAt=`2026-07-23T15:34:29.351Z`；pass=34、warning=3、fail=0；required fail codes=none；inner/outer/shell exit 均为 0 |
| 剩余 warning | **Pending** | required warnings：`E2E_PERMISSIONS_RECENT_RUN`、`ENV_CHECK_AVAILABLE`、`MIGRATIONS_UP_TO_DATE`；recommended warnings=none |
| 清理与公网状态 | **Pass** | 短生命周期 API 已停止并因 `--rm` 自动移除；最终容器清单为空；Nginx target 仍为 `salary-baseline`；Admin/API 仍为 HTTPS 503；Nginx、Docker、PostgreSQL 均 active |
| 敏感信息 | **Not found / Not recorded** | 未在本文或聊天记录密码、备份口令、完整邮箱、`DATABASE_URL`、token、secret、private key、cookie、session、bearer 或未脱敏业务数据 |

### 18.1 Gate 结果与任务81历史决定

任务80的 8 个 required fail 已全部清零：

- `BACKUP_HEALTH_NOT_CRITICAL`
- `ENABLED_SUPER_ADMIN_PRESENT`
- `NO_DISABLED_ONLY_SUPER_ADMIN`
- `PERMISSIONS_TABLE_COMPLETE`
- `RECENT_FULL_BACKUP_WITHIN_72H`
- `RECENT_RESTORE_DRILL_WITHIN_90D`
- `SUPER_ADMIN_HAS_RELEASE_GATE_PERMISSIONS`
- `SYSTEM_HEALTH_NOT_CRITICAL`

任务81收口时，真实 production release gate 为 **Warning（34/3/0）**，不是 Fail，但仍存在 3 个 required warning。任务81没有重新发布，没有恢复公网流量，也没有执行完整切流后 smoke、日志观察和人工审批，因此该历史阶段决定为 **No-Go / Conditional Pending**，不得自动宣布生产 Go。

后续必须另开任务82，在新的明确授权窗口内处理或解释剩余 warning，并执行受控重新部署、Nginx 切流、完整 smoke、日志与资源观察及最终人工审批。

## 19. 任务82：受控生产重新部署与切流（2026-07-24）

本节记录唯一授权 RC 的真实生产重新部署。执行环境为生产 Droplet，执行人为 `salaryops / Codex-assisted`。最终成功执行从 `2026-07-24T10:22:37Z` 开始，最终 release gate 于 `2026-07-24T10:52:10Z` 完成。

| 证据项 | 结果 | 脱敏生产证据 |
| --- | --- | --- |
| RC 身份 | **Pass** | `rc-20260712-2`；commit=`9f8f8f576dde54355983b96525335e94c55c8b32`；未移动或重打 tag，未部署其他 RC |
| 自动 SSH | **Pass** | 以 `salaryops` 完成无凭据 SSH 自动化；sudo、备份口令及管理员凭据仅由用户在受控 SSH 终端输入 |
| Full backup | **Pass** | `postgres-full-20260724T101322Z.sql.gz.enc`；13,088 bytes；SHA-256=`784ab1b9ffcde5ff8cb4162cbd2ea01954480e9a889c9d15af41748cd59d72cf`；流式解密及 gzip 校验通过；`0640 root:postgres` |
| API/Web 启动 | **Pass** | 两个授权 RC 容器 healthy；仅绑定 `127.0.0.1:3000/8080`；restart policy=`unless-stopped`；PostgreSQL 未公网开放 |
| Production env check | **Pass** | 23/23 脱敏检查通过，未输出变量值 |
| Migration status | **Pass** | expected=17、applied=17、pending=0、checksum drift=false；仅只读验证，未执行 migration deploy 或 schema 变更 |
| Nginx 切流 | **Pass** | candidate `nginx -t` 通过；active target=`salary-production-rc-20260712-2`；Admin root 与 API live/ready 本机 TLS/SNI 检查通过 |
| 公网 health | **Pass** | 发布工作站独立复核 Admin root、API live、API ready 均为 HTTP 200，TLS verify=0，无 525/526 |
| Admin permission smoke | **Pass / Partial** | 现有 `super_admin` 登录 HTTP 201；权限数=37；未登录 `/me` HTTP 401；任务临时 session 已撤销且最终 smoke session 已 logout。因禁止创建新管理员，低权 403 子项保持 Pending |
| Audit export smoke | **Pass** | HTTP 200；exportedCount=5；csvBytes=1687；sensitiveLeak=false；临时 CSV 已删除 |
| Health / alerts | **Pass with non-critical warning** | system health=`warning`、critical checks=0；backup health=`ok`；active critical alerts=0 |
| 首次 production release gate | **Warning / exit 0** | generatedAt=`2026-07-24T10:22:56.665Z`；pass=36、warning=1、fail=0；required fail=none；唯一 warning=`E2E_PERMISSIONS_RECENT_RUN` |
| 日志与错误率观察 | **Pass** | 30 分钟；API/Web/PostgreSQL/Nginx error 均为 0；HTTP 5xx=0；container restart=0；critical alerts=0；release-blocking=false |
| 最终 production release gate | **Warning / exit 0** | generatedAt=`2026-07-24T10:52:10.148Z`；pass=36、warning=1、fail=0；required fail=none；唯一 warning=`E2E_PERMISSIONS_RECENT_RUN`；recommended warning=none |
| 回滚行为 | **Pass** | 最终成功前四次自动化验证失败均自动恢复 baseline 503 并移除 API/Web 容器：`20260724T063940Z`、`20260724T101340Z`、`20260724T101703Z`、`20260724T101955Z`；均未恢复或修改数据库。最终成功执行未触发回滚 |
| 最终运行状态 | **Pass** | Nginx、Docker、PostgreSQL active；Nginx 指向授权 RC candidate；API/Web healthy；公网生产入口 HTTP 200 |
| 敏感信息 | **Not found / Not recorded** | 未记录密码、备份口令、token、完整 `DATABASE_URL`、private key、cookie、bearer、session 值、CSV 原文或未脱敏业务数据 |

服务端受限 evidence 引用：`/opt/salary-settlement-admin/evidence/task82-20260724T102237Z`。无异机备份风险仍未消除，继续沿用用户已接受的阶段性单机风险。

### 19.1 任务82决定

任务82收口时的历史决定：**Conditional Go Pending Approval**，不是 Full Go。

required fail 已全部清零，最终 gate exit=0，health、smoke 与 30 分钟观察均无阻断项，授权 RC 正在承载生产流量。唯一 required warning 为 `E2E_PERMISSIONS_RECENT_RUN`：生产等价检查已验证现有 `super_admin` 权限链与 401，但因没有获批的低权账号且任务82禁止创建新管理员，403 子项保持 Pending。Full Go 仍需用户明确接受该 warning，并完成适用的人工审批状态；部署成功本身不等于 Full Go。

## 20. 任务83：Conditional Go 审批转正与剩余 Warning 处理（2026-07-24）

本任务不是重新部署任务。生产已由任务82完成切流并持续由 `rc-20260712-2` 承载；本任务只执行只读生产复核、剩余 warning 处理、短观察和审批状态更新。未重新部署，未重启 API/Web，未切换 Nginx，未执行 migration deploy，未修改 schema/migration、生产权限或业务数据，未创建管理员账号，也未移动、删除或重打 RC tag。

| 证据项 | 结果 | 脱敏生产证据 |
| --- | --- | --- |
| 本地与 RC 复核 | **Pass** | `rc-20260712-2` 精确指向 `9f8f8f576dde54355983b96525335e94c55c8b32`；`git diff --check` exit=0；未发现 schema/migration 非授权变更或真实凭据文件被跟踪 |
| 自动 SSH 与主机服务 | **Pass** | 经 Tailscale 私网以 `salaryops` 自动连接；Nginx、Docker、PostgreSQL 均 active；failed units=0；需要 sudo 的只读步骤由用户仅在受控 SSH 窗口输入密码，凭据未进入聊天、命令参数或文档 |
| 公网与 Nginx | **Pass** | Nginx target=`salary-production-rc-20260712-2`；Admin、API live、API ready 均为 HTTPS 200 |
| 容器 | **Pass** | API/Web 均 running、healthy，镜像均为授权 RC；restart count=0 |
| 既有 production evidence | **Pass / retained** | 加密 full backup evidence 为 Pass，解密/gzip 校验 Pass；env check=23/23；migration expected/applied=17/17、pending=0、drift=false；backup/restore-drill records 各 1；最近 audit export success 存在，导出 smoke 为 5 条、1687 bytes、sensitive leak=false |
| 健康与告警 | **Pass with retained non-critical status** | backup health=`ok`；system health=`warning` 但 critical checks=0；active critical alerts=0 |
| 生产管理员与权限边界 | **Pending / coverage gap retained** | active admin users=1；active `super_admin` users=1；active 非 `super_admin` 管理员=0；roles=6、permissions=37、role_permissions=70。未输出账号标识、邮箱、密码 hash、token 或 session |
| 低权 403 smoke | **Not executed** | 生产不存在 active 低权管理员，且任务禁止自动创建账号；因此无法以真实低权身份验证 release gate run 与敏感管理员接口的 403。既有 `super_admin` 37 项权限链和未登录 401 结果继续有效，但不得替代真实低权 403 |
| 中间 gate 诊断 | **Non-authoritative / excluded from decision** | 旧独立 gate 脚本未挂载任务82的 env/migration evidence，短暂得到 34 pass / 3 warning / 0 fail，并额外报告 `ENV_CHECK_AVAILABLE`、`MIGRATIONS_UP_TO_DATE`。该结果反映 evidence 挂载缺失，不代表生产状态退化，不用于最终审批 |
| 最终权威 production release gate | **Warning / exit 0** | 使用任务82相同的只读 evidence 挂载；generatedAt=`2026-07-24T11:23:21.431Z`；pass=36、warning=1、fail=0；required fail=none；唯一 required warning=`E2E_PERMISSIONS_RECENT_RUN`；recommended warning=none；inner/outer exit=0 |
| 10 分钟短观察 | **Pass** | `2026-07-24T11:11:46Z–11:21:48Z`；Admin/API 30 次 HTTP 检查全部为 200；Nginx 新增 error=0、HTTP 5xx=0、API/Web/DB error matches=0；API/Web healthy、restart=0；active critical alerts=0 |
| 敏感信息 | **Not found / Not recorded** | 未读取或记录生产 `.env` 内容、`DATABASE_URL`、密码、token、session、cookie、bearer、私钥、CSV 原文或完整敏感用户信息 |

### 20.1 Warning 处理与风险状态

`E2E_PERMISSIONS_RECENT_RUN` 未清除，原因是生产不存在可复用的 active 低权管理员，且本任务未获授权创建新账号。该 warning 表示真实低权 403 权限边界覆盖不足，不是已通过项，也未被伪装为 Pass。

当前有两个后续路径：

1. 用户明确接受 `E2E_PERMISSIONS_RECENT_RUN` 残余风险并完成适用的人工审批后，可将状态更新为 **Full Go with accepted risk**；风险接受不等于低权 403 已验证或 warning 已消除。
2. 另开任务，在明确生产写入授权下创建受控临时低权管理员，执行登录、release gate 403、敏感管理员接口 403 和 logout-all smoke，清理账号与 session 后重跑 production release gate。

用户此前对无异机备份风险的阶段性接受继续有效，但风险仍未消除：当前只有本机每日备份与隔离恢复演练，Droplet 整机或同机存储丢失时仍可能无法恢复。正式长期运营前仍须补充并验证异机备份。

### 20.2 任务83决定

任务83收口时的历史决定：**Conditional Go Pending Approval**。

理由：生产健康、容器、日志、错误率、告警、既有 evidence 与最终权威 release gate 均无 fail 或其他阻断项；但唯一 required warning `E2E_PERMISSIONS_RECENT_RUN` 仍存在，真实低权 403 未验证，且用户尚未明确接受该 warning、尚未完成最终人工审批。因此不得擅自写为 Full Go 或 Full Go with accepted risk。

## 21. 任务84：受控临时低权账号、真实 403 Smoke 与 Full Go 转正（2026-07-24）

本任务只补齐 `E2E_PERMISSIONS_RECENT_RUN` 权限 warning，不是重新部署。执行时间为 `2026-07-24T11:49:15Z–11:57:09Z`，经 Tailscale 私网以 `salaryops / Codex-assisted` 连接生产。未重新部署，未重启 API/Web，未切换 Nginx，未执行 migration，未修改 schema/migration，未导入或删除生产业务数据，也未移动、删除或重打 RC tag。

| 证据项 | 结果 | 脱敏生产证据 |
| --- | --- | --- |
| 本地与 RC 复核 | **Pass** | `rc-20260712-2^{commit}` 精确解析为 `9f8f8f576dde54355983b96525335e94c55c8b32`；`git diff --check` exit=0；工作区仍仅含任务77–84生产配置、运行手册、审批记录与 staging 产物；未发现 schema/migration 非授权变更或真实凭据文件被跟踪 |
| 生产只读预检 | **Pass** | Nginx、Docker、PostgreSQL 均 active；failed units=0；Admin、API live、API ready 均为 HTTPS 200；API/Web 均 running、healthy、restart=0；管理员基线为 active=1、active super_admin=1、active non-super-admin=0 |
| 初始权威 release gate | **Pass with expected warning** | generatedAt=`2026-07-24T11:49:17.386Z`；pass=36、warning=1、fail=0；唯一 required warning=`E2E_PERMISSIONS_RECENT_RUN`；required fail=none；recommended warning=none；inner/outer exit=0 |
| 临时账号方案 | **Pass** | 仅创建一个脱敏标识为 `task84_***_smoke` 的临时管理员；服务器本地安全生成密码；复用既有 active 最小权限角色，权限仅 `salary.view_self`；未授予 `release_gate.run`、super_admin 或管理/破坏性权限 |
| 未登录 401 | **Pass** | 未携带认证访问 `/me` 返回真实 HTTP 401 |
| super_admin 权限链 | **Pass** | 现有 super_admin 登录成功；role chain 为 `super_admin`；权限数=37；`release_gate.read` 与 `release_gate.run` 均存在 |
| 真实低权身份 | **Pass** | 临时账号登录成功；`/me` 返回同一低权身份；权限数=1；不含 super_admin、`release_gate.run` 或 `admin_users.read` |
| 真实低权 403 | **Pass** | 低权账号调用 `POST /release-gate/run` 返回 HTTP 403；访问 `GET /admin-users` 返回 HTTP 403；未执行 release gate run |
| logout 与清理 | **Pass** | 低权 `logout-all` 成功；随后临时账号已设为 `disabled`，所有活动 session 已撤销；清理后 active=1、active super_admin=1、active non-super-admin=0；账号不得长期保持 active |
| 审计 | **Pass** | 账号创建、登录、低权拒绝、logout-all 与禁用均通过真实 API 流程产生必要审计；未写入或输出密码、password hash、token、session、cookie、bearer 或完整个人敏感信息 |
| 权限 evidence | **Pass** | 使用真实生产 smoke 生成 `production-real-low-privilege` evidence；checks=6、passed=6、failed=0、cleanup=`temporary_low_privilege_account_disabled_sessions_revoked`、CI fixture=false |
| 最终权威 release gate | **Pass / exit 0** | generatedAt=`2026-07-24T11:49:50.935Z`；pass=37、warning=0、fail=0；required fail/warning=none；recommended warning=none；inner/outer exit=0 |
| 5 分钟短观察 | **Pass** | `2026-07-24T11:52:06Z–11:57:09Z`；18 次 Admin/API HTTP 检查全部为 200；API/Web healthy、restart=0；Nginx error=0、HTTP 5xx=0、API/Web/PostgreSQL error matches=0、active critical alerts=0 |
| 敏感信息 | **Not found / Not recorded** | 未读取或记录生产 `.env` 内容、`DATABASE_URL`、密码、token、session、cookie、bearer、private key、CSV 原文、password hash 或完整敏感个人信息 |

服务端受限 evidence 引用：`/opt/salary-settlement-admin/evidence/task84-20260724T114915Z`。首次自动预检因区分任务82操作日志目录与 RC `tmp/release-evidence` 挂载目录而在账号创建前安全停止；修正只读 evidence 路径后重新执行，首次尝试未读取管理员凭据、未创建账号、未产生生产数据写入。

### 21.1 任务84决定

任务84收口时的历史决定：**Full Go with accepted backup risk**。

转正依据：未登录 401、super_admin 权限链、真实低权登录、release gate run 403、管理员接口 403、logout-all、账号禁用与 session 清理全部通过；最终权威 production release gate 为 `37/0/0` 且 exit=0；五分钟短观察无健康、重启、错误、5xx 或 critical alert 异常。`E2E_PERMISSIONS_RECENT_RUN` 已由真实生产 smoke 清除，没有把 warning 伪装成 Pass。

无异机备份阶段性风险仍然存在并继续沿用此前用户接受：当前只有本机每日备份与隔离恢复演练；Droplet 整机、同机存储或区域性故障时仍可能无法恢复。该风险不改变本次权限 warning 已清零的事实，但正式长期运营前仍须补充并验证异机备份。

本任务只补权限 warning，不是重新部署；临时低权账号已禁用，不得长期保持 active。只有本次已经满足的 release gate warning/fail 全清、全部权限 smoke 通过且观察无异常，才构成上述 Full Go 转正依据。

## 22. 任务85：上线后 24 小时生产监控与交接收尾（2026-07-24 起）

本任务不是重新发布。生产已由任务82完成部署和切流、由任务84完成真实低权 403 smoke 与 Full Go 转正；任务85只执行上线后只读监控、证据固化和运维交接。未重新部署，未重启 API/Web/Nginx/PostgreSQL，未切换 Nginx，未执行 migration deploy，未修改 schema/migration、业务数据、账号、角色、权限、告警或 RC tag。

即时检查执行时间为 `2026-07-24T12:19:12Z–12:19:26Z`，数据库脱敏计数补充复核完成于 `2026-07-24T12:30:26Z`。执行环境为生产 Droplet，经 Tailscale 私网以 `salaryops / Codex-assisted` 连接；需要 sudo 与管理员身份的步骤仅由用户在可见 SSH 窗口交互输入，凭据没有进入聊天、命令参数、证据或文档。

| 证据项 | 即时结果 | 脱敏证据 |
| --- | --- | --- |
| 本地与 RC | **Pass** | `rc-20260712-2^{commit}`=`9f8f8f576dde54355983b96525335e94c55c8b32`；`git diff --check` exit=0；未发现 schema/migration 非授权变更或真实凭据文件被跟踪 |
| 自动生产连接 | **Pass** | 经 `100.103.6.23` 自动 SSH，远端身份 `salaryops`；主机时间与证据时间均使用 UTC |
| 服务、容器与入口 | **Pass** | Nginx/Docker/PostgreSQL active；failed units=0；API/Web running、healthy、restart=0；Nginx target 仍为 `salary-production-rc-20260712-2`；PostgreSQL public listeners=0 |
| 公网 health 与 TLS | **Pass** | Admin root、API live、API ready 均 HTTP 200，TLS verify=0；生产机与发布工作站复核一致 |
| 资源 | **Pass** | 根分区使用率 4%，内存使用率 11%，未发现 OOM 或 disk-full 事件 |
| 日志与错误率 | **Pass** | 最近 15 分钟及 1 小时：Nginx 5xx=0、Nginx error=0、API error=0、Web error=0、PostgreSQL error=0、OOM/disk-full=0；1 小时 401=1、403=0，未形成异常峰值 |
| env / migration evidence | **Pass** | production env check 23/23；migration expected/applied=17/17、pending=0、drift=false；未读取或输出 `.env` 原文 |
| 权限与任务84账号收尾 | **Pass** | active admin=1、active super_admin=1、active low-privilege admin=0；任务84临时账号 matches=1、disabled=1、active=0、active sessions=0；权限数=37 |
| release gate | **Pass / exit 0** | generatedAt=`2026-07-24T12:19:16.480Z`；`37 pass / 0 warning / 0 fail`；required/recommended warning=none |
| 告警与系统/备份健康 | **Pass with non-critical system warning retained** | active critical alerts=0；system health=`warning` 但 gate=`pass`；backup health=`ok` |
| backup timer / latest backup | **Pass with accepted off-host risk** | `salary-postgres-backup.timer` active/enabled；last trigger=`2026-07-24T02:23:46Z`，next trigger=`2026-07-25T02:24:36Z`；最新成功加密 full backup 完成于 `2026-07-23T15:19:11Z`，检查时 21 小时；最新成功 restore drill 为 3 天内 |
| 最小 audit export smoke | **Pass** | 15 分钟最小窗口；HTTP 200；`exportedCount=3`、`csvBytes=1036`、`sensitiveLeak=false`；CSV 和 token 临时文件已删除，smoke session 已 logout |
| 敏感信息 | **Not found / Not recorded** | evidence 扫描匹配数=0；未记录生产 `.env`、数据库 URL、密码、token、session、cookie、bearer、private key、CSV 原文、password hash 或完整个人信息 |

即时主 evidence 路径为 `/opt/salary-settlement-admin/evidence/task85-post-go/immediate-20260724T121912Z`。初版数据库汇总 helper 因挂载在 `/tmp`、无法解析镜像内 Prisma 模块而在建立数据库查询前退出，导致主 summary 仅将 `DATABASE_SUMMARY` 标为 fail；这属于监控脚本缺陷，不是生产异常。helper 改为挂载到 `/app` 后只读补充复核 exit=0，脱敏证据为 `/home/salaryops/task85-db-summary-rerun.log`，SHA-256=`800c43e02ec41a3df628160e2a467020d86bb8e0942472f70e25ac57ee541759`。后续脚本已包含该修正。

远端脚本：

- `/home/salaryops/task85-post-go-check.sh`，SHA-256=`bf730a56bce1a83df025c995429e5d933214d9cdf77fbc26993972f5f0c70d4e`
- `/home/salaryops/task85-helper.js`，SHA-256=`6dacd4a51415034286950fc2aa09974726a7692ca82e6a41636cc002040352ef`

脚本只读取生产状态并写入脱敏 evidence；不含凭据，不修改生产服务配置，不执行常驻任务。没有启用 systemd timer。后续每次执行如需 sudo，用户只在可见 SSH 窗口输入。

### 22.1 T+24 最终复核计划（策略调整）

`2026-07-25` 经用户确认，任务85不再执行 T+1/T+6/T+12 定点复核，只保留 T+24 最终复核。原因是生产已完成 Full Go，短期即时检查已通过；本阶段接受减少人工 sudo 交互和 token 消耗。该调整不降低 T+24 的复核范围和判定标准。

| 检查点 | Asia/Shanghai | 执行参数 | 状态 |
| --- | --- | --- | --- |
| 即时 | `2026-07-24 20:19` | `immediate audit` | **完成** |
| T+1h | `2026-07-24 21:20` | 不执行 | **已取消**；不补跑 |
| T+6h | `2026-07-25 02:20` | 不执行 | **已取消**；不补跑 |
| T+12h | `2026-07-25 08:20` | 不执行 | **已取消**；不补跑 |
| T+24h | `2026-07-25 20:20` | `t24h no-audit` | **完成 / Warning**；24小时窗口完整，release gate regression |

T+24 必须覆盖：Admin/API live/API ready HTTP 200 与 TLS；Nginx/Docker/PostgreSQL active；failed units=0；API/Web running、healthy、restart=0；最近 24 小时 Nginx/API/Web/PostgreSQL error 统计及 HTTP 5xx；active critical alerts=0；release gate；backup timer active/enabled；latest full backup；restore drill evidence 仍有效；任务84临时低权账号仍 disabled 且无活动 session；active admin/super_admin/low-priv 计数；audit export smoke；敏感信息检查。audit export smoke 如需要管理员凭据，可标记 Pending，或由用户仅在可见 SSH 窗口交互输入；凭据不得进入聊天、命令参数、evidence 或文档。

任务84真实 403 evidence 的最大有效期为 24 小时。T+24 检查如果因 `E2E_PERMISSIONS_RECENT_RUN` 超龄而出现 warning，必须记录为 Full Go Regression，不得通过修改时间戳或仅凭数据库计数伪造新的 403 Pass。若 T+24 全部通过，状态更新为 **Full Go stable with accepted backup risk**；若出现任何 warning/fail，必须如实记录，并明确给出是否需要返修或人工回滚的建议，但不得自动回滚。

### 22.2 T+24 Attempt 1 结果（2026-07-25）

用户在生产 SSH 窗口执行了 `sudo bash /home/salaryops/task85-post-go-check.sh`，但未传入计划要求的 `t24h no-audit`。脚本于 `2026-07-25T13:31:18Z–13:31:23Z`（Asia/Shanghai `21:31:18–21:31:23`）运行，实际采用 `TASK85_LABEL=immediate` 和 60 分钟日志窗口，因此本次输出只能作为 T+24 尝试证据，不能替代完整的 24 小时日志复核。

| 复核项 | 结果 | 脱敏证据摘要 |
| --- | --- | --- |
| 禁止操作边界 | **Pass** | redeployment、service restart、Nginx switch、migration deploy、business data write 均为 `not_performed` |
| 公网与 TLS | **Pass** | Admin、API live、API ready 均 HTTP 200；TLS verify 均为 0 |
| 服务与 failed units | **Pass** | Nginx/Docker/PostgreSQL active；failed units=0 |
| 容器 | **Pass** | API/Web running、healthy、restart=0；镜像仍为授权 RC |
| Nginx 与 PostgreSQL 暴露 | **Pass** | Nginx target 为授权 RC；PostgreSQL public listeners=0 |
| 日志与 5xx | **Incomplete** | 15 分钟及 60 分钟窗口内 Nginx 5xx/error、API/Web/PostgreSQL error、OOM/disk-full 均为 0；未采集要求的最近 24 小时窗口 |
| critical alerts | **Pass** | active critical alerts=0 |
| release gate | **Warning / Full Go Regression** | `35 pass / 2 warning / 0 fail`，exit=0；required warning=`E2E_PERMISSIONS_RECENT_RUN`；recommended warning=`AUDIT_LOG_RECENT_ACTIVITY` |
| backup timer | **Pass** | active/enabled；last trigger=`2026-07-25T02:24:43Z`，next trigger=`2026-07-26T02:23:11Z` |
| latest full backup | **Pass** | succeeded/full/encrypted；完成于 `2026-07-23T15:19:11Z`，age=46h，仍在72小时内 |
| restore drill | **Pass** | succeeded；完成于 `2026-07-20T13:00:20Z`，age=5d，仍在90天内 |
| 账号与权限 | **Pass** | active admin/super_admin/low-priv=`1/1/0`；任务84临时账号 disabled=1、active=0、active sessions=0；permissions=37 |
| audit export smoke | **Pending** | 本次 `not_requested`；最近既有成功记录为 `2026-07-24T12:19:26.373Z` |
| 敏感信息 | **Pass** | sensitive leak matches=0 |
| 脚本总判定 | **Fail / release-blocking** | `TASK85_FAILURE_CODES=RELEASE_GATE_REGRESSION`；evidence=`/opt/salary-settlement-admin/evidence/task85-post-go/immediate-20260725T133118Z` |

本次没有发现公网、TLS、服务、容器、重启、5xx、错误、critical alert、备份或恢复证据方面的运行故障，因此不建议立即回滚。正确参数的 T+24 复核已于三分钟后完成，最终结果见下节。

### 22.3 T+24 最终复核结果（2026-07-25）

用户在生产 SSH 窗口执行 `sudo bash /home/salaryops/task85-post-go-check.sh t24h no-audit`。脚本于 `2026-07-25T13:34:17Z–13:34:22Z`（Asia/Shanghai `21:34:17–21:34:22`）运行，标签为 `t24h`，日志窗口为 1440 分钟，满足 T+24 观察窗口要求。

| 复核项 | 结果 | 脱敏证据摘要 |
| --- | --- | --- |
| 禁止操作边界 | **Pass** | redeployment、service restart、Nginx switch、migration deploy、business data write 均为 `not_performed`；未创建或修改账号 |
| Admin/API live/API ready 与 TLS | **Pass** | 三个入口均 HTTP 200；TLS verify=0 |
| Nginx/Docker/PostgreSQL | **Pass** | 三项 active；failed units=0；PostgreSQL public listeners=0 |
| API/Web | **Pass** | running、healthy、restart=0；使用授权 RC 镜像 |
| 最近24小时错误与 5xx | **Pass** | 1440 分钟窗口内 Nginx 5xx/error、API/Web/PostgreSQL error、OOM/disk-full 均为 0；401/403 无异常 |
| active critical alerts | **Pass** | 0 |
| release gate | **Warning / Full Go Regression** | generatedAt=`2026-07-25T13:34:21.861Z`；`35 pass / 2 warning / 0 fail`；exit=0；required fail=none |
| warning codes | **Warning** | required=`E2E_PERMISSIONS_RECENT_RUN`；recommended=`AUDIT_LOG_RECENT_ACTIVITY` |
| backup timer | **Pass** | active/enabled；last trigger=`2026-07-25T02:24:43Z`；next trigger=`2026-07-26T02:23:11Z` |
| latest full backup | **Pass** | succeeded/full/encrypted；`2026-07-23T15:19:11Z`；age=46h；72小时门禁 Pass |
| restore drill evidence | **Pass** | succeeded；`2026-07-20T13:00:20Z`；age=5d；90天门禁 Pass |
| 账号与权限 | **Pass** | active admin/super_admin/low-priv=`1/1/0`；任务84临时账号 disabled=1、active=0、active sessions=0；permissions=37 |
| audit export smoke | **Pending（允许）** | 本次 `not_requested`；最近既有成功记录=`2026-07-24T12:19:26.373Z` |
| 敏感信息 | **Pass** | sensitive leak matches=0 |
| 脚本总判定 | **Fail / release-blocking** | `TASK85_FAILURE_CODES=RELEASE_GATE_REGRESSION`；evidence=`/opt/salary-settlement-admin/evidence/task85-post-go/t24h-20260725T133417Z` |

### 22.4 任务85历史决定与未解决风险

T+24 复核已完成，但并非全部通过。任务85收口时的历史决定为 **Full Go Regression（T+24 release gate warning）**，当时不能更新为 **Full Go stable with accepted backup risk**。

回滚建议：**不建议立即回滚**。公网、TLS、服务、容器、24小时错误/5xx、critical alerts、备份、恢复证据和敏感信息检查均正常，release gate 没有 fail 且 exit=0。返修建议：另开明确授权任务执行新的真实低权 403 smoke，以处理 required warning `E2E_PERMISSIONS_RECENT_RUN`；如需处理 `AUDIT_LOG_RECENT_ACTIVITY`，在管理员凭据仅于可见 SSH 窗口交互输入的前提下执行最小 audit export smoke。不得修改 evidence 时间戳、用数据库计数替代真实 403 smoke、重新启用任务84账号，或在任务85内创建账号。

无异机备份风险仍然存在，且没有在任务85中解决：当前备份与恢复证据仍依赖同一 Droplet/同机存储；Droplet 整机、同机存储或区域性故障时仍可能无法恢复。任务85没有手动触发备份；T+24 已确认 timer active/enabled，并已按计划自然触发。

## 23. 任务86：T+24 Release Gate Warning 根因修复与 Stable 收口（2026-07-26）

任务86仅修复 T+24 的两个 release gate warning。未重新部署，未重启 API/Web/Nginx/PostgreSQL，未切换 Nginx，未执行 migration deploy，未修改 schema/migration、RC tag、告警或 super_admin 权限，未导入业务数据，也未执行回滚。

最终有效执行窗口为 `2026-07-25T16:37:00Z–16:42:21Z`（Asia/Shanghai `2026-07-26 00:37:00–00:42:21`）。Codex 经 Tailscale `100.103.6.23` 自动连接生产，用户只在可见 SSH 窗口输入 sudo 与现有 super_admin 凭据；凭据、token、session、CSV 原文和生产 `.env` 均未进入聊天、命令参数或文档。

| 检查项 | 最终结果 | 脱敏证据摘要 |
| --- | --- | --- |
| 本地与 RC | **Pass** | `rc-20260712-2^{commit}`=`9f8f8f576dde54355983b96525335e94c55c8b32`；`git diff --check` exit=0；无 schema/migration 非授权变更 |
| 生产预检 | **Pass** | Admin/API live/API ready 均 HTTP 200、TLS verify=0；Nginx/Docker/PostgreSQL active；failed units=0；API/Web running、healthy、restart=0 |
| T+24 基线 | **Pass** | 最近24小时 Nginx 5xx/error、API/Web/PostgreSQL error、OOM/disk-full 均为 0；critical alerts=0；backup timer active；full backup 49 小时内；restore drill 5 天内 |
| warning 根因 | **Confirmed** | T+24 的真实 production E2E 权限 evidence 超过 24 小时有效期；审计近期活动在 T+24 时已过期。任务86首次真实管理员活动后审计 warning 自然清除，最终有效执行开始时 gate 为 `36/1/0`，唯一 warning 为 `E2E_PERMISSIONS_RECENT_RUN` |
| super_admin 链 | **Pass** | 登录成功；role=`super_admin`；权限数=37；`release_gate.read/run` 均存在；release gate read 通过；最终 logout-all 通过 |
| 未登录 401 | **Pass** | 未携带认证访问 `/me` 返回真实 HTTP 401 |
| 真实低权 403 | **Pass** | 复用已禁用任务84账号；只读确认仍绑定唯一最小角色 `salary.view_self`；登录与 `/me` 通过；`POST /release-gate/run` 和管理员接口均返回真实 HTTP 403 |
| 低权账号收尾 | **Pass** | smoke 后 logout-all、账号禁用和 session 撤销通过；最终 active admin/super_admin/low-priv=`1/1/0`；任务84账号 disabled=1、active=0、active sessions=0 |
| E2E evidence | **Pass** | 写入真实 production evidence；checks=`7/7`；mode=`production-real-low-privilege`；CI fixture=false；未修改旧 evidence 时间戳 |
| audit export smoke | **Pass** | 最小15分钟窗口；HTTP 200；`exportedCount=6`、`csvBytes=2018`、`sensitiveLeak=false`；最近24小时真实 audit activity count=11；CSV 已删除 |
| 最终 release gate | **Pass / exit 0** | generatedAt=`2026-07-25T16:37:17.975Z`；`37 pass / 0 warning / 0 fail`；required/recommended warning=none |
| 5分钟短观察 | **Pass** | 样本 0–5 全部通过；三个 HTTPS/TLS 入口持续正常；API/Web healthy、restart=0；Nginx/API/Web/PostgreSQL error=0；Nginx 5xx=0；critical alerts=0 |
| 敏感信息与临时文件 | **Pass** | evidence 敏感模式零匹配；`/run` 无 `task86.*` 残留；token/session/临时 CSV 已清理；未记录任何凭据或敏感原文 |

受限生产 evidence 路径：`/opt/salary-settlement-admin/evidence/task86-20260725T163700Z`。远端临时执行脚本在交付前删除；保留脱敏状态日志 `/home/salaryops/task86-status.log` 用于审计。

前两次尝试均安全停止。第一次在低权账号启用前发现旧任务84流程对既有最小角色执行冗余 PATCH 被当前 API 拒绝，cleanup 已撤销管理员 session；第二次在任何管理员凭据输入和账号写入前发现审计 warning 已被真实活动清除、gate 变为 `36/1/0`，因旧的精确前置断言而停止。最终脚本改为只读验证既有最小角色并接受附件规定的合法 warning 收敛状态，没有扩大授权范围。

最终自动化在全部生产检查完成后出现一个非生产收尾缺陷：敏感扫描使用 `grep` 配合 `set -e/pipefail`，零匹配时 `grep` 返回 1，导致 wrapper 最终 `CORE_COMPLETE` 标记为 fail。该退出状态恰由零匹配触发；它发生在 `37/0/0`、账号/session 清理、5分钟观察和最终数据库汇总全部通过之后，不代表生产失败。后续脚本应将“零匹配”规范化为成功退出。

任务86最终决定：**Full Go stable with accepted backup risk**。不建议回滚。无异机备份风险仍被接受但未解决；当前同机加密 full backup 与隔离 restore drill 不能覆盖 Droplet 整机、同机存储或区域性故障。

## 24. 任务88：本机备份长期化与隔离恢复 SOP（2026-07-27）

任务88通过 Tailscale 和现有 SSH key 自动连接生产。用户只在一个可见 SSH 窗口输入一次 sudo 密码；密码未进入聊天、命令参数、日志、文档或 Git。本次未部署、未重启、未切流、未执行 migration、未修改生产业务数据、未修改 timer/service/retention，也未配置异机备份。

| 检查项 | 结果 | 脱敏事实 |
| --- | --- | --- |
| 生产预检 | **Pass** | Nginx/Docker/PostgreSQL active；failed units=0；API/Web running、healthy、restart=0；Admin/API live/API ready HTTP 200、TLS verify=0；active critical alerts=0 |
| Timer/service | **Pass** | `salary-postgres-backup.timer` enabled/active；最近触发 `2026-07-27 02:16:16 UTC`；`salary-postgres-backup.service` 为 oneshot，Result=success、exit=0；下次 `2026-07-28 02:22:14 UTC` |
| 最新物理备份 | **Pass** | `postgres-full-20260727T021616Z.sql.gz`；`2026-07-27 02:16:17 UTC`；17,742 bytes；检查时约8小时42分 |
| Checksum/完整性 | **Pass** | 生成时同名 `.sha256` sidecar；`sha256sum -c` match；`gzip -t` 通过 |
| 权限/retention | **Pass** | 目录 `root:postgres 0750`；备份和 sidecar `root:postgres 0640`；world-readable/world-writable/group-writable 均为0；实际 retention=30天 |
| 容量 | **Pass** | 根文件系统使用率4%；备份目录13个数据文件、133,485 bytes；当前容量支持既有 retention |
| 隔离恢复证据 | **Pass / existing evidence reviewed** | 复核 `2026-07-20T13:00:20Z` 既有演练：PostgreSQL 16、`network=none`、无 host port、未接触生产库、非敏感版本/数据库/角色计数验证完成、临时容器和脚本清理完成；任务88未执行新演练 |
| 应用 backup record | **Warning** | 数据库记录没有随每日物理 timer 更新，当前只读汇总为 `BACKUP_WITHIN_72H=fail`；物理备份事实独立通过。修复需要生产写入授权，任务88未执行 |
| 无异机备份 | **Accepted / unresolved / non-blocking** | 当前不实施 DigitalOcean Spaces、S3、对象存储、远端同步或其他异机备份；进入正式长期运营前单独复核 |

新增长期 SOP、月度演练空白模板、生产风险台账和严格只读健康检查脚本。任务88只记录执行事实，不作产品验收结论。

## 25. 任务89：物理备份 Evidence 与应用 backup record 自动同步（Blocked，2026-07-27）

任务89完成了仓库与生产只读诊断，但在任何生产写入和实现提交前发现真实性要求与现有
backup health 规则不可同时满足。用户只在一个可见 SSH 窗口输入一次 sudo 密码；密码
未进入聊天、命令参数、文件、日志或 Git。发现用临时脚本与副本已清理。

| 检查项 | 结果 | 脱敏事实 |
| --- | --- | --- |
| Git/RC 基线 | **Pass** | `main`；开始时 `HEAD=origin/main=f177924fe8472cb3a1860106fe8d77847896a4db`；`rc-20260712-2^{commit}=9f8f8f576dde54355983b96525335e94c55c8b32`；任务80未跟踪目录未修改 |
| release gate 数据源 | **Confirmed** | `BackupRecord` / `backup_records`；`status=succeeded`、`backupType=full`；按 `completedAt` 降序，72小时 age 使用 `completedAt`，缺失时回退 `startedAt` |
| 现有唯一键 | **Confirmed** | `backupKey` 为数据库唯一字段，可作为物理 basename 幂等键；无需 schema/migration |
| 最新物理备份 | **Pass / unchanged** | `postgres-full-20260727T021616Z.sql.gz`；mtime=`2026-07-27T02:16:17Z`；17,742 bytes；root:postgres `0640`；sidecar match；gzip 通过 |
| Timer/service | **Pass** | timer enabled/active；service Result=success、exit=0；retention=30天 |
| 应用 backup record | **Stale** | 共1条；任务81加密 full record；completedAt=`2026-07-23T15:19:11Z`；检查时 age=92h；checksum present、`encrypted=true` |
| 当前 backup health | **Critical** | 只读等价计算为 `backup.success_too_old` |
| 阻断事实 | **Confirmed** | 每日脚本生成未加密 `.sql.gz`。如实新 record 必须为 `encrypted=false`，现有 `BackupHealthService` 会产生 `backup.not_encrypted` critical；写 `true` 是伪造，降低规则被任务硬边界禁止 |
| 生产修改 | **Not performed** | recorder/backup script/systemd unit/retention 均未改；backup record、业务表、restore drill evidence 均未写 |
| 服务与数据动作 | **Not performed** | 无 API/Web 部署；无 API/Web/Nginx/PostgreSQL 重启；无 Nginx 切流；无 migration；无异机备份配置 |
| release gate | **Not run after write** | 没有发生生产写入，故未伪造“修复后”门禁；72小时检查仍预期 fail，backup health 仍 critical |
| 回滚 | **Not required** | 实施未开始；无生产变更需要回滚 |
| 风险状态 | **Unchanged** | `RISK-DP-002` 保持 Open；`RISK-DP-001` 保持 Accepted |

后续需要 product/data/application/operations owner 明确选择并另行授权：把每日流程改为
真实文件级加密并在新的真实 full backup 后接入 recorder，或批准并论证 health 政策变更。
在此之前不得补录虚假 `encrypted=true`，也不得降低或关闭检查。本节只记录执行事实，不作
产品验收结论。
