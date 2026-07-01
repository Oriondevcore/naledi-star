import { Hono } from 'hono';
import type { Bindings } from './helpers';

export function register(app: Hono<{ Bindings: Bindings }>) {
  app.post('/api/karaoke/sync', async (c) => {
    const syncKey = c.req.header('X-Sync-Key');
    if (!syncKey || syncKey !== (c.env as any).SYNC_KEY) {
      return c.json({ status: 'error', message: 'Invalid sync key' }, 401);
    }
    const { songs } = await c.req.json();
    if (!Array.isArray(songs) || songs.length === 0) {
      return c.json({ status: 'error', message: 'songs array required' }, 400);
    }
    let added = 0, updated = 0;
    const stmt = c.env.KARAOKE_DB.prepare(
      `INSERT INTO dbSongs (Artist, Title, DiscId, Duration, path, filename, searchstring, plays, lastplay)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         Artist = excluded.Artist, Title = excluded.Title, DiscId = excluded.DiscId,
         Duration = excluded.Duration, filename = excluded.filename,
         searchstring = excluded.searchstring, plays = excluded.plays, lastplay = excluded.lastplay`
    );
    for (const song of songs) {
      const result = await stmt.bind(
        song.artist, song.title, song.disc_id || null,
        song.duration || null, song.filepath, song.filename || null,
        song.search_string || null, song.plays || 0, song.last_play || null
      ).run();
      if (result.meta.changes > 1) updated++; else added++;
    }
    return c.json({ status: 'success', added, updated, total: songs.length });
  });
}
