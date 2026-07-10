-- Existing sync tasks intentionally receive a NULL planning_key. This preserves
-- the historical ability to create multiple manual tasks for one logical source.
CREATE TYPE "SyncTaskTriggerType" AS ENUM ('manual', 'scheduled');
CREATE TYPE "SyncPlanningRunStatus" AS ENUM ('running', 'succeeded', 'failed');

ALTER TABLE "sync_tasks"
  ADD COLUMN "trigger_type" "SyncTaskTriggerType" NOT NULL DEFAULT 'manual',
  ADD COLUMN "planning_key" VARCHAR(255);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "sync_tasks"
    WHERE "planning_key" IS NOT NULL
    GROUP BY "planning_key" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate sync task planning keys must be resolved before migration';
  END IF;
END $$;

CREATE UNIQUE INDEX "sync_tasks_planning_key_key" ON "sync_tasks"("planning_key");

CREATE TABLE "sync_planning_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "settlement_month" DATE NOT NULL,
  "status" "SyncPlanningRunStatus" NOT NULL,
  "last_attempt_at" TIMESTAMP(3) NOT NULL,
  "last_success_at" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 1,
  "created_count" INTEGER NOT NULL DEFAULT 0,
  "existing_count" INTEGER NOT NULL DEFAULT 0,
  "blocked_count" INTEGER NOT NULL DEFAULT 0,
  "blocker_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "failure_code" VARCHAR(64),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sync_planning_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sync_planning_runs_settlement_month_key" ON "sync_planning_runs"("settlement_month");
