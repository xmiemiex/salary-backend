CREATE TABLE "provider_inventory_checkpoints" (
 "provider" "Provider" PRIMARY KEY,
 "credential_fingerprint" VARCHAR(64) NOT NULL,
 "completed_through" TIMESTAMP(3) NOT NULL
);
