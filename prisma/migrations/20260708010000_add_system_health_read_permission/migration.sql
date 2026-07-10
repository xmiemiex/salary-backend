-- Idempotent permission data migration for the read-only system health center.
INSERT INTO "permissions" ("id", "code", "name", "created_at", "updated_at")
VALUES
  (md5('permission:system_health.read')::uuid, 'system_health.read', 'system_health.read', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id", "created_at")
SELECT role_row."id", permission_row."id", CURRENT_TIMESTAMP
FROM "roles" AS role_row
CROSS JOIN "permissions" AS permission_row
WHERE role_row."code" = 'super_admin'
  AND permission_row."code" = 'system_health.read'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
