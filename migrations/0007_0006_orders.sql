-- Migration number: 0007 	 2026-06-17T12:38:53.349Z
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  charge_id TEXT NOT NULL,
  product TEXT NOT NULL,
  amount_in_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'ZAR',
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_notes TEXT,
  order_type TEXT NOT NULL DEFAULT 'print',
  order_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_notified ON orders(notified);
