-- Preserve historical manually recorded rates only when the month has one exact rate.
-- Conflicting historical rates remain untouched and require explicit review before release.
BEGIN;
ALTER TABLE monthly_adpos_fee_rates DISABLE TRIGGER monthly_finance_lock;
INSERT INTO monthly_adpos_fee_rates (settlement_month, fee_rate, created_by, updated_at)
SELECT settlement_month, MIN(fee_rate), MIN(created_by::text)::uuid, MAX(updated_at)
FROM manual_card_spend_entries
WHERE lower(btrim(provider_name)) = 'adpos' AND status = 'confirmed'
  AND card_identifier IS DISTINCT FROM 'monthly-dashboard'
GROUP BY settlement_month
HAVING COUNT(DISTINCT fee_rate) = 1 AND MIN(fee_rate) BETWEEN 0 AND 1
  AND bool_and(actual_spend_usd = round(settled_spend_usd * (1 + fee_rate), 6))
ON CONFLICT (settlement_month) DO NOTHING;
ALTER TABLE monthly_adpos_fee_rates ENABLE TRIGGER monthly_finance_lock;
COMMIT;
