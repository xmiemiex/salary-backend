ALTER TYPE "SyncTaskStatus" ADD VALUE 'retry_wait' AFTER 'pending';

CREATE TYPE "SyncExecutionErrorCategory" AS ENUM (
  'NETWORK_ERROR',
  'TIMEOUT',
  'RATE_LIMITED',
  'PROVIDER_5XX',
  'TEMPORARY_DATABASE_ERROR',
  'CREDENTIAL_MISSING',
  'CREDENTIAL_INVALID',
  'MONTH_LOCKED',
  'UNSUPPORTED_PLATFORM',
  'UNSUPPORTED_PROVIDER',
  'INVALID_CONFIGURATION',
  'VALIDATION_ERROR',
  'PERMISSION_ERROR',
  'BUSINESS_REJECTED'
);

ALTER TABLE "sync_tasks"
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_attempt_at" TIMESTAMP(3),
  ADD COLUMN "lease_owner" VARCHAR(64),
  ADD COLUMN "lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "last_attempt_at" TIMESTAMP(3),
  ADD COLUMN "last_error_category" "SyncExecutionErrorCategory";

CREATE INDEX "sync_tasks_trigger_type_status_next_attempt_at_idx"
  ON "sync_tasks"("trigger_type", "status", "next_attempt_at");
CREATE INDEX "sync_tasks_status_lease_expires_at_idx"
  ON "sync_tasks"("status", "lease_expires_at");
