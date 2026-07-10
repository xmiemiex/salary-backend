CREATE TYPE "AlertSeverity" AS ENUM ('info', 'warning', 'critical');

CREATE TYPE "AlertStatus" AS ENUM ('active', 'resolved', 'silenced');

CREATE TABLE "alerts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "fingerprint" VARCHAR(255) NOT NULL,
  "severity" "AlertSeverity" NOT NULL,
  "status" "AlertStatus" NOT NULL,
  "source" VARCHAR(64) NOT NULL,
  "category" VARCHAR(64) NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "safe_message" TEXT NOT NULL,
  "safe_details" JSONB,
  "first_seen_at" TIMESTAMP(3) NOT NULL,
  "last_seen_at" TIMESTAMP(3) NOT NULL,
  "resolved_at" TIMESTAMP(3),
  "acknowledged_at" TIMESTAMP(3),
  "acknowledged_by" UUID,
  "silenced_until" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notifications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "recipient_id" UUID NOT NULL,
  "alert_id" UUID,
  "type" VARCHAR(64) NOT NULL,
  "severity" "AlertSeverity" NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "safe_message" TEXT NOT NULL,
  "safe_details" JSONB,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "alerts_fingerprint_key" ON "alerts"("fingerprint");
CREATE INDEX "alerts_status_severity_idx" ON "alerts"("status", "severity");
CREATE INDEX "alerts_source_category_idx" ON "alerts"("source", "category");
CREATE INDEX "alerts_created_at_idx" ON "alerts"("created_at");
CREATE INDEX "notifications_recipient_id_read_at_created_at_idx" ON "notifications"("recipient_id", "read_at", "created_at");
CREATE INDEX "notifications_alert_id_idx" ON "notifications"("alert_id");
CREATE UNIQUE INDEX "notifications_unread_alert_recipient_type_key"
  ON "notifications"("recipient_id", "alert_id", "type")
  WHERE "read_at" IS NULL AND "alert_id" IS NOT NULL;

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_recipient_id_fkey"
  FOREIGN KEY ("recipient_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_alert_id_fkey"
  FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "permissions" ("id", "code", "name", "description", "created_at", "updated_at")
VALUES
  (md5('permission:notifications.read')::uuid, 'notifications.read', 'notifications.read', 'Read own in-app notifications', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (md5('permission:notifications.manage')::uuid, 'notifications.manage', 'notifications.manage', 'Manage in-app notifications', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (md5('permission:alerts.read')::uuid, 'alerts.read', 'alerts.read', 'Read alert center', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (md5('permission:alerts.manage')::uuid, 'alerts.manage', 'alerts.manage', 'Scan and manage alerts', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id", "created_at")
SELECT r."id", p."id", CURRENT_TIMESTAMP
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."code" = 'super_admin'
  AND p."code" IN ('notifications.read', 'notifications.manage', 'alerts.read', 'alerts.manage')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
