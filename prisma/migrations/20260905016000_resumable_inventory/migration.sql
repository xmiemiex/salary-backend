CREATE TABLE "provider_inventory_scans" (
  "provider" "Provider" NOT NULL PRIMARY KEY,
  "credential_fingerprint" VARCHAR(64) NOT NULL,
  "through" TIMESTAMP(3) NOT NULL,
  "state" JSONB NOT NULL
);
