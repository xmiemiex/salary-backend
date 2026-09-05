-- Serialize fee/manual edits against locking, including writes through legacy endpoints.
CREATE FUNCTION monthly_finance_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m DATE;
BEGIN
  FOR m IN SELECT DISTINCT value FROM unnest(ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.settlement_month ELSE NULL END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.settlement_month ELSE NULL END
  ]) AS value WHERE value IS NOT NULL ORDER BY value
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('monthly-finance:' || to_char(m, 'YYYY-MM-DD') || 'T00:00:00.000Z', 0));
    IF TG_TABLE_NAME <> 'monthly_settlements' AND EXISTS (SELECT 1 FROM monthly_settlements WHERE settlement_month = m AND status = 'locked') THEN
      RAISE EXCEPTION 'MONTH_LOCKED: month % cannot be modified', m;
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER monthly_finance_lock BEFORE INSERT OR UPDATE OR DELETE ON monthly_settlements FOR EACH ROW EXECUTE FUNCTION monthly_finance_write_guard();
CREATE TRIGGER monthly_finance_lock BEFORE INSERT OR UPDATE OR DELETE ON monthly_card_provider_fee_rates FOR EACH ROW EXECUTE FUNCTION monthly_finance_write_guard();
CREATE TRIGGER monthly_finance_lock BEFORE INSERT OR UPDATE OR DELETE ON monthly_adpos_fee_rates FOR EACH ROW EXECUTE FUNCTION monthly_finance_write_guard();
CREATE TRIGGER monthly_finance_lock BEFORE INSERT OR UPDATE OR DELETE ON manual_card_spend_entries FOR EACH ROW EXECUTE FUNCTION monthly_finance_write_guard();
