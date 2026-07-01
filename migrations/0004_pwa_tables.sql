-- Naledi Star PWA tables
CREATE TABLE IF NOT EXISTS pwa_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    elderly_phone TEXT NOT NULL,
    elderly_name TEXT,
    carer_phone TEXT NOT NULL,
    carer_name TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(elderly_phone, carer_phone)
);

CREATE TABLE IF NOT EXISTS pwa_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_key TEXT NOT NULL,
    from_phone TEXT NOT NULL,
    to_phone TEXT,
    text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pwa_messages_key ON pwa_messages(conversation_key);
