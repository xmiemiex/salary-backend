-- AddEnum
CREATE TYPE "ProviderCardMatchStatus" AS ENUM ('matched', 'unmatched', 'conflict');

-- AddTable
CREATE TABLE "provider_cards" (
    "id" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "card_id" VARCHAR(128) NOT NULL,
    "cardholder_id" VARCHAR(128),
    "cardholder_email_normalized" VARCHAR(255),
    "masked_card_number" VARCHAR(32),
    "nickname" VARCHAR(255),
    "provider_status" VARCHAR(64),
    "employee_id" UUID,
    "match_status" "ProviderCardMatchStatus" NOT NULL DEFAULT 'unmatched',
    "unmatched_reason_code" VARCHAR(64),
    "last_card_synced_at" TIMESTAMP(3),
    "last_transaction_synced_at" TIMESTAMP(3),
    "last_transaction_sync_status" VARCHAR(64),
    "source_created_at" TIMESTAMP(3),
    "source_updated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_cards_pkey" PRIMARY KEY ("id")
);

-- AddIndexes
CREATE UNIQUE INDEX "provider_cards_provider_card_id_key" ON "provider_cards"("provider", "card_id");
CREATE INDEX "provider_cards_provider_match_status_idx" ON "provider_cards"("provider", "match_status");
CREATE INDEX "provider_cards_employee_id_idx" ON "provider_cards"("employee_id");

-- AddForeignKey
ALTER TABLE "provider_cards" ADD CONSTRAINT "provider_cards_employee_id_fkey"
FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
