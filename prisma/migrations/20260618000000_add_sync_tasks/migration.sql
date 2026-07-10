-- CreateEnum
CREATE TYPE "SyncTaskSourceType" AS ENUM ('affiliate_income', 'card_spend');

-- CreateEnum
CREATE TYPE "SyncTaskType" AS ENUM ('affiliate_income', 'airwallex_card', 'photonpay_card');

-- CreateEnum
CREATE TYPE "SyncTaskPlatform" AS ENUM ('everflow', 'cake', 'airwallex', 'photonpay');

-- CreateEnum
CREATE TYPE "SyncTaskStatus" AS ENUM ('not_implemented', 'pending', 'running', 'completed', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "sync_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_type" "SyncTaskSourceType" NOT NULL,
    "task_type" "SyncTaskType" NOT NULL,
    "platform" "SyncTaskPlatform" NOT NULL,
    "affiliate_account_id" UUID,
    "provider" "Provider",
    "settlement_month" DATE NOT NULL,
    "status" "SyncTaskStatus" NOT NULL DEFAULT 'not_implemented',
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "error_message" TEXT,
    "requested_by" UUID,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "request_payload" JSONB,
    "result_payload" JSONB,

    CONSTRAINT "sync_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_tasks_settlement_month_task_type_idx" ON "sync_tasks"("settlement_month", "task_type");

-- CreateIndex
CREATE INDEX "sync_tasks_platform_status_idx" ON "sync_tasks"("platform", "status");

-- CreateIndex
CREATE INDEX "sync_tasks_affiliate_account_id_idx" ON "sync_tasks"("affiliate_account_id");

-- AddForeignKey
ALTER TABLE "sync_tasks" ADD CONSTRAINT "sync_tasks_affiliate_account_id_fkey" FOREIGN KEY ("affiliate_account_id") REFERENCES "affiliate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
