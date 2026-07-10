-- CreateTable
CREATE TABLE "affiliate_account_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "affiliate_account_id" UUID NOT NULL,
    "encrypted_payload" TEXT NOT NULL,
    "masked_payload" JSONB,
    "status" "CommonStatus" NOT NULL DEFAULT 'active',
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_account_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_provider_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" "Provider" NOT NULL,
    "encrypted_payload" TEXT NOT NULL,
    "masked_payload" JSONB,
    "status" "CommonStatus" NOT NULL DEFAULT 'active',
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "card_provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_account_credentials_affiliate_account_id_key" ON "affiliate_account_credentials"("affiliate_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "card_provider_credentials_provider_key" ON "card_provider_credentials"("provider");

-- AddForeignKey
ALTER TABLE "affiliate_account_credentials" ADD CONSTRAINT "affiliate_account_credentials_affiliate_account_id_fkey" FOREIGN KEY ("affiliate_account_id") REFERENCES "affiliate_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
