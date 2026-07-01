-- SupaTraxx Karaoke - Song library synced from OpenKJ
CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist TEXT NOT NULL,
    title TEXT NOT NULL,
    disc_id TEXT,
    duration INTEGER,
    filename TEXT,
    filepath TEXT UNIQUE NOT NULL,
    search_string TEXT,
    plays INTEGER DEFAULT 0,
    last_play TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist);
CREATE INDEX IF NOT EXISTS idx_songs_title ON songs(title);
CREATE INDEX IF NOT EXISTS idx_songs_search ON songs(search_string);
