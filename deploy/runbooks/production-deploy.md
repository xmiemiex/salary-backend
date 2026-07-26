# Production Deployment Runbook — Archived Source, Execution Requires Authorization

Current production status: **Full Go stable with accepted backup risk**. Final release gate: **`37 pass / 0 warning / 0 fail`**, exit=`0`. Off-host backup remains unconfigured; that risk is accepted for this stage but is not resolved.

This runbook is the archived deployment source used during Tasks 77–86. It does not authorize another deployment. Every future execution requires a separate approved release task and window.

## Preconditions and release identity

1. Name the release, rollback, operations, data, and business owners; obtain explicit approvals and a confirmed window.
2. Confirm off-host backup disposition, active alerts, capacity, certificates, system services, and that only 80/443 are publicly exposed.
3. Resolve tag `rc-20260712-2` to `9f8f8f576dde54355983b96525335e94c55c8b32`. Verify the checked-out detached commit, CI artifact manifest, image labels/digests, source archive checksum, and migration directory all bind to that same commit. Stop on any mismatch; never move or recreate the tag.
4. Confirm a successful full production backup within policy, its checksum and storage reference, and the latest approved restore-drill evidence. This is a gate, not permission to trigger a backup or restore.
5. Place the populated, permission-restricted environment file only at `/opt/salary-settlement-admin/shared/.env`. Review names against `.env.production.example`; reject placeholders and never print values. Confirm `VITE_API_BASE_URL` before Web build.

## Preflight and migration gate

1. Run the existing environment check in the approved release context and retain its redacted output, exit code, timestamp, commit, and operator.
2. Collect migration status before writes and compare pending identifiers with the approved RC. Pending, drift, connection uncertainty, or a baseline mismatch means No-Go.
3. Build images from the verified commit with `docker-compose.prod.yml` or pull digest-pinned images from the approved registry. Record image digests and scan/provenance results; do not use a mutable tag as identity.
4. Validate the Compose model with the server-only env file without rendering or storing secrets in evidence. Review that ports are `127.0.0.1:3000/8080`, no PostgreSQL container exists, and no secret mounts exist.
5. Migration execution is a separate write authorization. Only after explicit second authorization and backup confirmation may the operator run `pnpm db:migrate` (or the reviewed exact container equivalent). Re-collect migration status. Failure stops the release; do not improvise rollback SQL.

## Start, verify, and cut over

1. Start the candidate API/Web project without replacing the current Nginx placeholder. Wait for Compose health to become healthy.
2. From the host, verify `127.0.0.1:3000/health/live`, `127.0.0.1:3000/health/ready`, `127.0.0.1:8080/healthz`, and the Web root. Confirm the API readiness response includes successful database connectivity.
3. Render `deploy/nginx/salary-production.conf.template` into a new candidate file using the existing Certbot certificate paths. Preserve the live placeholder file and symlink/config snapshot. Run `nginx -t`; stop on warnings or errors.
4. With rollback owner online, atomically enable the reviewed candidate site and gracefully reload Nginx. Never overwrite Certbot-managed material. The template returns 503 when an upstream is absent; the preserved placeholder is the primary immediate rollback.
5. Verify both public hostnames through Cloudflare: certificate, redirects, headers, Web navigation, API liveness/readiness, upload limit behavior, and absence of direct access to ports 3000/8080/5432.

## Required smoke tests and observation

1. Run the minimum administrator permission smoke with a pre-approved identity: expected permitted operations succeed and expected denied operations remain denied. Do not create a production administrator in this runbook.
2. Run the bounded audit export smoke with an approved non-sensitive filter and handling path. Confirm an audit record and no secret/credential material in the export.
3. Collect release-gate, env-check, migration-status, backup, restore-drill, active-alert, permission-smoke, audit-export-smoke, image digest, Nginx config test, and health evidence with timestamps and release identity.
4. Observe Nginx/API/Web/PostgreSQL logs, 4xx/5xx and latency, container restarts, database errors/connections, CPU, memory, disk, and active alerts for the approved period.

## Go / No-Go decision and failure handling

Go requires every required human approval and real production evidence item to pass, the exact artifact identity to match, both containers/upstreams to be healthy, migrations to match, rollback to remain viable, and no critical alert. Any missing, stale, warning-as-pass, mismatch, pending migration, health failure, security exposure, unexplained error rise, or owner absence is No-Go.

On failure: stop the cutover, retain evidence, keep/restore the 503 placeholder, do not retry writes blindly, and invoke `production-rollback.md` when its triggers apply. Record the final decision, operator, timestamps, commands (redacted), image digests, observations, and incident/change references.
