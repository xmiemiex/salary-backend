-- Task 101: PhotonPay historical email aliases and provider-card accounting exclusions.
-- This migration is additive and does not rewrite or delete existing card or exception data.

ALTER TYPE "ProviderCardMatchStatus" ADD VALUE 'excluded';

CREATE TYPE "ProviderCardMatchSource" AS ENUM ('employee_primary_email', 'provider_email_alias');
CREATE TYPE "ProviderCardExclusionReason" AS ENUM ('admin_test_card');

ALTER TABLE "provider_cards"
ADD COLUMN "match_source" "ProviderCardMatchSource";

CREATE TABLE "provider_email_aliases" (
    "id" UUID NOT NULL,
    "provider" "Provider" NOT NULL DEFAULT 'photonpay',
    "alias_email_normalized" VARCHAR(255) NOT NULL,
    "employee_id" UUID NOT NULL,
    "status" "CommonStatus" NOT NULL DEFAULT 'active',
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3),
    "reason" TEXT,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "provider_email_aliases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "provider_email_aliases_photonpay_only_check" CHECK ("provider" = 'photonpay'),
    CONSTRAINT "provider_email_aliases_status_check" CHECK ("status" IN ('active', 'disabled')),
    CONSTRAINT "provider_email_aliases_valid_period_check" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from")
);

CREATE UNIQUE INDEX "provider_email_aliases_provider_alias_email_normalized_valid_from_key"
ON "provider_email_aliases"("provider", "alias_email_normalized", "valid_from");
CREATE INDEX "provider_email_aliases_provider_alias_email_normalized_status_valid_from_idx"
ON "provider_email_aliases"("provider", "alias_email_normalized", "status", "valid_from");
CREATE INDEX "provider_email_aliases_employee_id_status_idx"
ON "provider_email_aliases"("employee_id", "status");

ALTER TABLE "provider_email_aliases" ADD CONSTRAINT "provider_email_aliases_employee_id_fkey"
FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION enforce_provider_email_alias_period()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('provider_email_alias:' || NEW.provider::text || ':' || NEW.alias_email_normalized, 0));
  IF NEW.status = 'active' AND EXISTS (
    SELECT 1
    FROM provider_email_aliases existing
    WHERE existing.provider = NEW.provider
      AND existing.alias_email_normalized = NEW.alias_email_normalized
      AND existing.status = 'active'
      AND existing.id <> NEW.id
      AND tsrange(existing.valid_from, COALESCE(existing.valid_to, 'infinity'::timestamp), '[)')
          && tsrange(NEW.valid_from, COALESCE(NEW.valid_to, 'infinity'::timestamp), '[)')
  ) THEN
    RAISE EXCEPTION 'provider email alias effective period overlaps an active alias'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_email_aliases_no_overlap"
BEFORE INSERT OR UPDATE OF "provider", "alias_email_normalized", "status", "valid_from", "valid_to"
ON "provider_email_aliases"
FOR EACH ROW EXECUTE FUNCTION enforce_provider_email_alias_period();

CREATE TABLE "provider_card_accounting_exclusions" (
    "id" UUID NOT NULL,
    "provider_card_id" UUID NOT NULL,
    "reason" "ProviderCardExclusionReason" NOT NULL DEFAULT 'admin_test_card',
    "status" "CommonStatus" NOT NULL DEFAULT 'active',
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "note" TEXT,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "provider_card_accounting_exclusions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "provider_card_accounting_exclusions_status_check" CHECK ("status" IN ('active', 'disabled')),
    CONSTRAINT "provider_card_accounting_exclusions_effective_period_check" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from")
);

CREATE UNIQUE INDEX "provider_card_accounting_exclusions_provider_card_id_effective_from_key"
ON "provider_card_accounting_exclusions"("provider_card_id", "effective_from");
CREATE INDEX "provider_card_accounting_exclusions_provider_card_id_status_effective_from_idx"
ON "provider_card_accounting_exclusions"("provider_card_id", "status", "effective_from");

ALTER TABLE "provider_card_accounting_exclusions" ADD CONSTRAINT "provider_card_accounting_exclusions_provider_card_id_fkey"
FOREIGN KEY ("provider_card_id") REFERENCES "provider_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION enforce_provider_card_exclusion_period()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM provider_cards card
    WHERE card.id = NEW.provider_card_id AND card.provider = 'photonpay'
  ) THEN
    RAISE EXCEPTION 'provider card accounting exclusions are restricted to PhotonPay cards'
      USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('provider_card_exclusion:' || NEW.provider_card_id::text, 0));
  IF NEW.status = 'active' AND EXISTS (
    SELECT 1
    FROM provider_card_accounting_exclusions existing
    WHERE existing.provider_card_id = NEW.provider_card_id
      AND existing.status = 'active'
      AND existing.id <> NEW.id
      AND tsrange(existing.effective_from, COALESCE(existing.effective_to, 'infinity'::timestamp), '[)')
          && tsrange(NEW.effective_from, COALESCE(NEW.effective_to, 'infinity'::timestamp), '[)')
  ) THEN
    RAISE EXCEPTION 'provider card exclusion effective period overlaps an active exclusion'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_card_accounting_exclusions_no_overlap"
BEFORE INSERT OR UPDATE OF "provider_card_id", "status", "effective_from", "effective_to"
ON "provider_card_accounting_exclusions"
FOR EACH ROW EXECUTE FUNCTION enforce_provider_card_exclusion_period();

CREATE TABLE "provider_card_match_resolutions" (
    "id" UUID NOT NULL,
    "provider_card_id" UUID NOT NULL,
    "resolution_type" VARCHAR(64) NOT NULL,
    "previous_match_status" "ProviderCardMatchStatus" NOT NULL,
    "previous_reason_code" VARCHAR(64),
    "new_match_status" "ProviderCardMatchStatus" NOT NULL,
    "new_reason_code" VARCHAR(64),
    "employee_id" UUID,
    "alias_id" UUID,
    "exclusion_id" UUID,
    "resolved_by" UUID NOT NULL,
    "resolved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "safe_metadata" JSONB,
    CONSTRAINT "provider_card_match_resolutions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "provider_card_match_resolutions_provider_card_id_resolved_at_idx"
ON "provider_card_match_resolutions"("provider_card_id", "resolved_at");
CREATE INDEX "provider_card_match_resolutions_alias_id_idx" ON "provider_card_match_resolutions"("alias_id");
CREATE INDEX "provider_card_match_resolutions_exclusion_id_idx" ON "provider_card_match_resolutions"("exclusion_id");

ALTER TABLE "provider_card_match_resolutions" ADD CONSTRAINT "provider_card_match_resolutions_provider_card_id_fkey"
FOREIGN KEY ("provider_card_id") REFERENCES "provider_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_card_match_resolutions" ADD CONSTRAINT "provider_card_match_resolutions_employee_id_fkey"
FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "provider_card_match_resolutions" ADD CONSTRAINT "provider_card_match_resolutions_alias_id_fkey"
FOREIGN KEY ("alias_id") REFERENCES "provider_email_aliases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "provider_card_match_resolutions" ADD CONSTRAINT "provider_card_match_resolutions_exclusion_id_fkey"
FOREIGN KEY ("exclusion_id") REFERENCES "provider_card_accounting_exclusions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION prevent_provider_card_match_resolution_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'provider card match resolutions are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "provider_card_match_resolutions_append_only"
BEFORE UPDATE OR DELETE ON "provider_card_match_resolutions"
FOR EACH ROW EXECUTE FUNCTION prevent_provider_card_match_resolution_mutation();

INSERT INTO "permissions" ("id", "code", "name", "created_at", "updated_at")
VALUES
  (md5('permission:photonpay_unmatched.read')::uuid, 'photonpay_unmatched.read', 'photonpay_unmatched.read', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (md5('permission:photonpay_email_alias.manage')::uuid, 'photonpay_email_alias.manage', 'photonpay_email_alias.manage', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (md5('permission:photonpay_rematch.execute')::uuid, 'photonpay_rematch.execute', 'photonpay_rematch.execute', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (md5('permission:provider_card_exclusion.manage')::uuid, 'provider_card_exclusion.manage', 'provider_card_exclusion.manage', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id", "created_at")
SELECT role_row."id", permission_row."id", CURRENT_TIMESTAMP
FROM "roles" AS role_row
CROSS JOIN "permissions" AS permission_row
WHERE role_row."code" = 'super_admin'
  AND permission_row."code" IN (
    'photonpay_unmatched.read',
    'photonpay_email_alias.manage',
    'photonpay_rematch.execute',
    'provider_card_exclusion.manage'
  )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
