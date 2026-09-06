-- Evidence only: no income records or financial totals are changed/backfilled.
CREATE TABLE "cake_monthly_income_reviews" (
  "affiliate_account_id" UUID NOT NULL,
  "settlement_month" DATE NOT NULL,
  "base_fingerprint" VARCHAR(64) NOT NULL,
  "confirmed_by" UUID NOT NULL,
  "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cake_monthly_income_reviews_pkey" PRIMARY KEY ("affiliate_account_id", "settlement_month"),
  CONSTRAINT "cake_monthly_income_reviews_affiliate_account_id_fkey" FOREIGN KEY ("affiliate_account_id") REFERENCES "affiliate_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TRIGGER monthly_finance_lock BEFORE INSERT OR UPDATE OR DELETE ON cake_monthly_income_reviews FOR EACH ROW EXECUTE FUNCTION monthly_finance_write_guard();
