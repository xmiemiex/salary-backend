ALTER TABLE "card_spend_events"
  ADD COLUMN "amount" DECIMAL(18, 6),
  ADD COLUMN "currency" VARCHAR(16),
  ADD COLUMN "imported_by" UUID;
