-- Align database-generated UUID defaults with Prisma's client-generated @default(uuid()).
ALTER TABLE "sync_tasks" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "affiliate_account_credentials" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "card_provider_credentials" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "sync_unmatched_events" ALTER COLUMN "id" DROP DEFAULT;

-- PostgreSQL truncated the original overlength name differently from Prisma's expected name.
ALTER INDEX "sync_unmatched_events_source_type_task_type_third_party_event_i"
  RENAME TO "sync_unmatched_events_source_type_task_type_third_party_eve_key";
