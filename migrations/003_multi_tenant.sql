-- Multi-tenant client system for ORION PRO
-- Adds client accounts, feature toggles, usage tracking, wallets

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  waba_phone_number_id TEXT,
  waba_access_token TEXT,
  system_prompt TEXT,
  plan TEXT DEFAULT 'custom',
  status TEXT DEFAULT 'active',
  monthly_base_fee_cents INTEGER DEFAULT 269000,
  wallet_balance_cents INTEGER DEFAULT 0,
  wallet_threshold_cents INTEGER DEFAULT 50000,
  billing_email TEXT,
  test_number TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS client_features (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  enabled INTEGER DEFAULT 0,
  monthly_cap INTEGER DEFAULT 0,
  current_usage INTEGER DEFAULT 0,
  billing_period TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (client_id) REFERENCES clients(id),
  UNIQUE(client_id, feature_key, billing_period)
);

CREATE TABLE IF NOT EXISTS usage_log (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  model TEXT,
  input_units INTEGER DEFAULT 0,
  output_units INTEGER DEFAULT 0,
  input_cost_cents INTEGER DEFAULT 0,
  output_cost_cents INTEGER DEFAULT 0,
  total_cost_cents INTEGER DEFAULT 0,
  request_phone TEXT,
  response_text TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  description TEXT,
  reference TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

CREATE INDEX IF NOT EXISTS idx_client_features_lookup ON client_features(client_id, feature_key, billing_period);
CREATE INDEX IF NOT EXISTS idx_usage_log_client ON usage_log(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_log_period ON usage_log(client_id, feature_key, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_client ON transactions(client_id, created_at);
