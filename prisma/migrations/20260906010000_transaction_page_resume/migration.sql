CREATE TABLE provider_transaction_scans (
  provider "Provider" NOT NULL,
  settlement_month DATE NOT NULL,
  scope_fingerprint VARCHAR(64) NOT NULL,
  state JSONB NOT NULL,
  PRIMARY KEY (provider, settlement_month)
);
