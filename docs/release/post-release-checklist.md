# Post-Release Checklist

Use this checklist after production deployment. Each check must have an owner, method, pass standard, and failure handling.

## T+0 Immediate Checks

| Check | Owner | Method | Pass standard | Failure handling |
| --- | --- | --- | --- | --- |
| Deployment version | Release owner | Compare deployed API/Web version or image digest with approved release artifact. | Deployed version matches approval record. | Stop observation and roll back mismatched component. |
| API health | Operations owner | Check production API health endpoint and service status. | Health endpoint passes and service is stable. | Roll back API if unavailable or restart loop occurs. |
| Web reachability | Operations owner | Open production Web URL and login page. | Web loads expected release. | Roll back Web or restore previous routing. |
| Release gate | Technical lead | Run `pnpm release:check` in production or approved release-check environment. | Exit code `0`, warning `0`, fail `0`. | Enter rollback decision flow for any required failure. |
| Admin login | Technical lead | Perform approved admin smoke login. | Login succeeds and audit event is recorded. | Roll back if admin access is broadly affected. |
| Critical alerts | Operations owner | Inspect production monitoring. | Active critical alerts are `0`. | Roll back if release-related critical alert appears. |

## T+30 Minutes Checks

| Check | Owner | Method | Pass standard | Failure handling |
| --- | --- | --- | --- | --- |
| Permission routes | Technical lead | Inspect 401/403 logs and test protected admin routes. | No abnormal authorization failures or unintended access. | Roll back API/Web and preserve logs. |
| Sync tasks | Operations owner | Review scheduler status, retry queue, failed queue, and leases. | No unexpected failure or backlog growth. | Pause scheduler and assess rollback. |
| Audit logs | Data or compliance owner | Confirm login, release smoke, and export actions are auditable. | Expected audit entries exist. | Roll back if audit write path is broken. |
| Audit export | Technical lead | Run approved audit export smoke operation. | Export succeeds and file is non-empty. | Roll back or hotfix depending on compliance impact. |
| Error logs | Operations owner | Review API, Web, scheduler, and database logs. | No recurring high-severity release-related errors. | Open incident and decide rollback or hotfix. |
| Backup health | Data owner | Inspect backup health indicator. | Backup health is not critical. | Block further changes until backup health is restored. |

## T+2 Hours Checks

| Check | Owner | Method | Pass standard | Failure handling |
| --- | --- | --- | --- | --- |
| Key business workflow | Product or business owner | Execute or review agreed critical salary settlement admin workflow. | Workflow completes without blocker. | Open incident and decide hotfix or rollback. |
| System health | Technical lead | Inspect system health page and release gate relevant checks. | No critical item; warnings have owners if any. | Roll back if critical health is release-related. |
| Alert trend | Operations owner | Compare alert volume against baseline. | No upward critical or sustained warning trend. | Escalate and assign mitigation owner. |
| Data counters | Data owner | Review key table counts and growth trend. | No unexpected deletion, duplication, or surge. | Pause automation and investigate data integrity. |
| Support feedback | Product or business owner | Review support channel or stakeholder feedback. | No release-blocking complaint. | Triage and decide hotfix or rollback. |

## T+24 Hours Checks

| Check | Owner | Method | Pass standard | Failure handling |
| --- | --- | --- | --- | --- |
| Sync success rate | Operations owner | Compare successful, retrying, and failed sync tasks against baseline. | Success rate remains within normal range. | Pause scheduler if failures are release-related. |
| Retry/fail queues | Technical lead | Inspect retry and failed queues. | No abnormal backlog. | Open incident and repair or roll back. |
| Admin audit review | Data or compliance owner | Review privileged admin actions and permission denials. | Actions are expected and traceable. | Investigate access issue and roll back if authorization regressed. |
| Backup schedule | Data owner | Confirm scheduled backup after release. | Backup job succeeds after release. | Fix backup system before next release. |
| Data growth anomaly | Data owner | Compare key growth metrics to pre-release baseline. | No unexplained anomaly. | Freeze data-affecting jobs and assess restore/repair. |
| Final release status | Release owner | Review all T+0, T+30, T+2h, and T+24h evidence. | All checks pass or documented non-blocking items have owners. | Keep release in incident status until resolved. |
