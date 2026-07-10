CREATE TYPE "BackupStatus" AS ENUM ('running', 'succeeded', 'failed', 'expired', 'unknown');
CREATE TYPE "BackupType" AS ENUM ('full', 'partial', 'schema_only', 'audit_only');
CREATE TYPE "RestoreDrillStatus" AS ENUM ('running', 'succeeded', 'failed', 'cancelled');

CREATE TABLE "backup_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "backup_key" VARCHAR(128) NOT NULL,
  "status" "BackupStatus" NOT NULL,
  "backup_type" "BackupType" NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  "storage_alias" VARCHAR(128) NOT NULL,
  "file_size_bytes" BIGINT,
  "checksum_sha256" CHAR(64),
  "encrypted" BOOLEAN NOT NULL,
  "encryption_alias" VARCHAR(128),
  "scope_summary" JSONB,
  "safe_metadata" JSONB,
  "failure_reason" TEXT,
  "created_by" UUID,
  "updated_by" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "backup_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "restore_drill_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "drill_key" VARCHAR(128) NOT NULL,
  "status" "RestoreDrillStatus" NOT NULL,
  "environment_alias" VARCHAR(128) NOT NULL,
  "backup_key" VARCHAR(128),
  "started_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  "validation_summary" JSONB,
  "safe_metadata" JSONB,
  "failure_reason" TEXT,
  "created_by" UUID,
  "updated_by" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restore_drill_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "backup_records_backup_key_key" ON "backup_records"("backup_key");
CREATE INDEX "backup_records_status_started_at_idx" ON "backup_records"("status", "started_at");
CREATE INDEX "backup_records_backup_type_started_at_idx" ON "backup_records"("backup_type", "started_at");
CREATE UNIQUE INDEX "restore_drill_records_drill_key_key" ON "restore_drill_records"("drill_key");
CREATE INDEX "restore_drill_records_status_started_at_idx" ON "restore_drill_records"("status", "started_at");
CREATE INDEX "restore_drill_records_backup_key_idx" ON "restore_drill_records"("backup_key");

INSERT INTO "permissions" ("id", "code", "name", "description", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), 'backup_status.read', 'backup_status.read', 'Permission backup_status.read', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'backup_status.manage', 'backup_status.manage', 'Permission backup_status.manage', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'restore_drill.read', 'restore_drill.read', 'Permission restore_drill.read', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'restore_drill.manage', 'restore_drill.manage', 'Permission restore_drill.manage', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id", "created_at")
SELECT r."id", p."id", CURRENT_TIMESTAMP
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."code" = 'super_admin'
  AND p."code" IN ('backup_status.read', 'backup_status.manage', 'restore_drill.read', 'restore_drill.manage')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
