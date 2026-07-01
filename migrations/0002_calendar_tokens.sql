-- Calendar tokens for Google Calendar OAuth
CREATE TABLE IF NOT EXISTS calendar_tokens (
    id INTEGER PRIMARY KEY,
    refresh_token TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
