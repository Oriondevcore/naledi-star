-- Naledi Star PWA - Magic-link tokens
CREATE TABLE IF NOT EXISTS pwa_tokens (
    token TEXT PRIMARY KEY,
    phone TEXT,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'elderly',
    created_by TEXT,
    is_active INTEGER DEFAULT 1,
    last_used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
