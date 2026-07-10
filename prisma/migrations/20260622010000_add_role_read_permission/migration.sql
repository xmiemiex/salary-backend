-- Idempotent permission catalog update; permissions remain code/migration managed.
INSERT INTO "permissions" ("id", "code", "name", "description", "created_at", "updated_at")
VALUES (
  md5('permission:role.read')::uuid,
  'role.read',
  '查看角色与权限',
  '查看角色列表、详情和只读权限目录',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE
SET "name" = EXCLUDED."name", "description" = EXCLUDED."description", "updated_at" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("role_id", "permission_id", "created_at")
SELECT role_row."id", permission_row."id", CURRENT_TIMESTAMP
FROM "roles" AS role_row
CROSS JOIN "permissions" AS permission_row
WHERE role_row."code" = 'super_admin' AND permission_row."code" = 'role.read'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
