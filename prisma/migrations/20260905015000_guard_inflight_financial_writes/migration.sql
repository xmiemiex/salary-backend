-- An in-flight provider request must not write after another request locks its month.
CREATE TRIGGER monthly_finance_lock BEFORE INSERT OR UPDATE OR DELETE ON income_records FOR EACH ROW EXECUTE FUNCTION monthly_finance_write_guard();
CREATE TRIGGER monthly_finance_lock BEFORE INSERT OR UPDATE OR DELETE ON card_spend_events FOR EACH ROW EXECUTE FUNCTION monthly_finance_write_guard();
