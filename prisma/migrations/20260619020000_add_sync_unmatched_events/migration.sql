-- CreateEnum
CREATE TYPE "SyncUnmatchedEventStatus" AS ENUM ('open', 'ignored', 'resolved');

-- CreateTable
CREATE TABLE "sync_unmatched_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "settlement_month" DATE NOT NULL,
    "source_type" "SyncTaskSourceType" NOT NULL,
    "task_type" "SyncTaskType" NOT NULL,
    "platform" "SyncTaskPlatform",
    "provider" "Provider",
    "affiliate_account_id" UUID,
    "sync_task_id" UUID,
    "third_party_event_id" VARCHAR(128),
    "reason_code" VARCHAR(64) NOT NULL,
    "reason_message" TEXT,
    "sub_field" VARCHAR(64),
    "sub_value" VARCHAR(255),
    "card_id" VARCHAR(128),
    "card_last4" VARCHAR(16),
    "card_email" VARCHAR(255),
    "amount_usd" DECIMAL(18, 6),
    "currency" VARCHAR(16),
    "occurred_at" TIMESTAMP(3),
    "raw_safe_data" JSONB,
    "status" "SyncUnmatchedEventStatus" NOT NULL DEFAULT 'open',
    "resolved_employee_id" UUID,
    "resolution_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" UUID,

    CONSTRAINT "sync_unmatched_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_unmatched_events_settlement_month_source_type_status_idx" ON "sync_unmatched_events"("settlement_month", "source_type", "status");

-- CreateIndex
CREATE INDEX "sync_unmatched_events_sync_task_id_idx" ON "sync_unmatched_events"("sync_task_id");

-- CreateIndex
CREATE INDEX "sync_unmatched_events_affiliate_account_id_idx" ON "sync_unmatched_events"("affiliate_account_id");

-- CreateIndex
CREATE INDEX "sync_unmatched_events_provider_idx" ON "sync_unmatched_events"("provider");

-- CreateIndex
CREATE INDEX "sync_unmatched_events_third_party_event_id_idx" ON "sync_unmatched_events"("third_party_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_unmatched_events_source_type_task_type_third_party_event_id_key" ON "sync_unmatched_events"("source_type", "task_type", "third_party_event_id");

-- AddForeignKey
ALTER TABLE "sync_unmatched_events" ADD CONSTRAINT "sync_unmatched_events_affiliate_account_id_fkey" FOREIGN KEY ("affiliate_account_id") REFERENCES "affiliate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_unmatched_events" ADD CONSTRAINT "sync_unmatched_events_sync_task_id_fkey" FOREIGN KEY ("sync_task_id") REFERENCES "sync_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_unmatched_events" ADD CONSTRAINT "sync_unmatched_events_resolved_employee_id_fkey" FOREIGN KEY ("resolved_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
