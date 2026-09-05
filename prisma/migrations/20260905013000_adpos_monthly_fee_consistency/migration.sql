CREATE FUNCTION adpos_monthly_fee_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE monthly_rate DECIMAL(10,6);
BEGIN
  IF lower(btrim(NEW.provider_name)) = 'adpos' THEN
    SELECT fee_rate INTO monthly_rate FROM monthly_adpos_fee_rates WHERE settlement_month = NEW.settlement_month;
    IF FOUND THEN
      NEW.fee_rate := monthly_rate;
      NEW.actual_spend_usd := NEW.settled_spend_usd * (1 + monthly_rate);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER adpos_monthly_fee_consistency BEFORE INSERT OR UPDATE ON manual_card_spend_entries FOR EACH ROW EXECUTE FUNCTION adpos_monthly_fee_consistency();
