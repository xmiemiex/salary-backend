ALTER TABLE "employees" ADD COLUMN "business_sub_id" VARCHAR(255);
CREATE UNIQUE INDEX "employees_business_sub_id_key" ON "employees"("business_sub_id");
CREATE TABLE "monthly_adpos_fee_rates" (
  "settlement_month" DATE PRIMARY KEY,
  "fee_rate" DECIMAL(10,6) NOT NULL CHECK (fee_rate >= 0 AND fee_rate <= 1),
  "created_by" UUID NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "monthly_refresh_batches" (
  "id" UUID PRIMARY KEY,
  "settlement_month" DATE NOT NULL,
  "requested_by" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "monthly_refresh_batches_settlement_month_created_at_idx" ON "monthly_refresh_batches"("settlement_month", "created_at");
ALTER TABLE "sync_tasks" ADD COLUMN "refresh_batch_id" UUID REFERENCES "monthly_refresh_batches"("id");
CREATE INDEX "sync_tasks_refresh_batch_id_idx" ON "sync_tasks"("refresh_batch_id");
