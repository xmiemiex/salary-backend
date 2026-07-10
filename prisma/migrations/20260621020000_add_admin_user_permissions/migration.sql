-- Idempotent permission data migration. Existing user.manage and role.manage
-- permissions are intentionally left unchanged.
INSERT INTO "permissions" ("id", "code", "name", "created_at", "updated_at")
VALUES
  (md5('permission:admin_users.read')::uuid, 'admin_users.read', 'admin_users.read', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (md5('permission:admin_users.manage')::uuid, 'admin_users.manage', 'admin_users.manage', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id", "created_at")
SELECT role_row."id", permission_row."id", CURRENT_TIMESTAMP
FROM "roles" AS role_row
CROSS JOIN "permissions" AS permission_row
WHERE role_row."code" = 'super_admin'
  AND permission_row."code" IN ('admin_users.read', 'admin_users.manage')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
