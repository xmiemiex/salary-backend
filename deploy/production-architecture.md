# Production Deployment Architecture — Task 78

Status: **No-Go: production deployment plan prepared only**. This document is a plan, not production evidence or deployment authorization.

## Architecture and boundaries

```text
Cloudflare
  -> host Nginx (public TCP 80/443 only; HTTPS termination)
       -> 127.0.0.1:8080 -> Web container (Vite static assets on Nginx)
       -> 127.0.0.1:3000 -> API container (NestJS)
                               -> host PostgreSQL 16 via Docker host gateway
```

- The API and Web published ports bind only to `127.0.0.1`; neither is publicly reachable directly. PostgreSQL 5432 must remain absent from public firewall ingress.
- Compose manages only `api` and `web`. It deliberately does not start a second PostgreSQL instance, avoiding conflict with the installed system PostgreSQL 16 and its established backup timer.
- PostgreSQL must listen only on the minimum host/Docker bridge addresses needed by the API container, with a narrow `pg_hba.conf` rule for the application role. Validate the exact bridge subnet before the release task; never bind PostgreSQL broadly to the public interface.
- Release artifacts live under `/opt/salary-settlement-admin/releases/<release-id>`; mutable configuration lives at `/opt/salary-settlement-admin/shared/.env`. The populated file is server-only, permission-restricted, and never committed or baked into an image.
- The Web API base URL is a non-secret Vite build input. Because it is embedded in static JavaScript, any change requires rebuilding the Web image.
- Local daily backup and an empty-baseline restore drill exist, but no off-host backup exists. Loss of the Droplet remains a release-blocking risk.

## Image and runtime design

- Both images build with Node.js 22 and pnpm 10.32.1 using the committed lockfile. The API uses a multi-stage build, starts the verified Nest output `apps/api/dist/apps/api/src/main.js`, and runs as the image's non-root `node` user.
- The Web build produces `apps/web/dist`; a dedicated Nginx container serves only static files and provides SPA fallback plus `/healthz`.
- Compose applies restart policies, bounded JSON logs, read-only root filesystems, temporary writable paths, health checks, and `no-new-privileges`. It mounts no secrets.
- `DATABASE_URL` uses the server-only application role and `host.docker.internal` host-gateway address. The actual credential is never recorded in Git.

## Database initialization plan (do not execute in Task 78)

1. Under a separately authorized release task, verify the system PostgreSQL version and backup/restore readiness.
2. Create database `salary_settlement` and login role `salary_app` using a password generated and stored only on the server. Grant connection to that database, usage on the application schema, and only the object privileges required by the migrations/application; do not grant superuser, role creation, database creation, replication, or bypass-RLS privileges.
3. Configure the minimum Docker-bridge listener and `pg_hba.conf` source range, reload PostgreSQL, and prove port 5432 is not publicly reachable.
4. Write the resulting `DATABASE_URL` only to `/opt/salary-settlement-admin/shared/.env` with restrictive ownership/mode. Do not create a business user or administrator account and do not import data.
5. Before migrations, capture an approved full backup, checksum/metadata, and a restore-capable reference. Off-host backup remains unresolved.

## Migration plan (do not execute in Task 78)

1. Bind the artifact and migration directory to the approved RC commit, then collect migration status before any write.
2. Any pending migration keeps the decision at No-Go until the release window and named owners are ready.
3. Only after explicit second authorization, execute the repository's `pnpm db:migrate` or the reviewed equivalent inside the exact release image, then collect status again.
4. On failure, stop traffic cutover and enter manual rollback/incident handling. Prisma has no automatic down migration; never infer that application rollback reverses schema changes. Database restore is a separate destructive action requiring separate approval.

## Health and evidence collection points

| Check | Planned source | Pass condition |
| --- | --- | --- |
| API liveness/readiness | `/health/live`, `/health/ready` | 200; readiness confirms DB access |
| Web static service | `/healthz` and `/` | 200 and expected release UI loads |
| Host Nginx/upstreams | both public hostnames plus Nginx logs | TLS valid, expected upstream, no sustained 5xx |
| Release gate/env/migration | existing release evidence commands | exact release identity; redacted Pass artifacts |
| Backup/restore drill | system backup metadata and isolated drill record | within policy; checksums and owner confirmation |
| Alerts/logs | active-alert view, Docker/Nginx/PostgreSQL logs | no critical alerts or unexplained error-rate rise |
| Permissions/audit export | minimum approved smoke identities and filters | expected allow/deny behavior; bounded export succeeds |

None of these planned checks is a production evidence pass until executed against the separately authorized production release and returned in redacted form.
