-- Naledi Subscribers / Subscription Management
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  email TEXT DEFAULT '',
  plan TEXT NOT NULL DEFAULT 'explorer',
  status TEXT NOT NULL DEFAULT 'active',
  conversations_used INTEGER NOT NULL DEFAULT 0,
  conversations_limit INTEGER NOT NULL DEFAULT 500,
  onboarded INTEGER NOT NULL DEFAULT 0,
  paused_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscribers_phone ON subscribers(phone);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status);
