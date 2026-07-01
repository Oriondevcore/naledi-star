const sqlite3 = require('better-sqlite3');
const https = require('https');

const DB_PATH = 'C:\\Users\\Admin\\AppData\\Local\\OpenKJ\\OpenKJ\\openkj.sqlite';
const API_URL = 'https://helpme-api.orion269.workers.dev/api/karaoke/sync';
const SYNC_KEY = process.env.SYNC_KEY || '';

async function sync() {
  console.log('Opening OpenKJ database...');
  const db = sqlite3(DB_PATH, { readonly: true });

  const rows = db.prepare(`
    SELECT songid, Artist, Title, DiscId, Duration, path, filename, searchstring, plays, lastplay
    FROM dbSongs
    WHERE DiscId NOT IN ('!!BAD!!', '!!DROPPED!!')
       OR DiscId IS NULL
    ORDER BY songid
  `).all();

  db.close();
  console.log(`Read ${rows.length} songs from OpenKJ`);

  const songs = rows.map(r => ({
    artist: r.Artist || '',
    title: r.Title || '',
    disc_id: r.DiscId || null,
    duration: r.Duration || null,
    filepath: r.path || '',
    filename: r.filename || null,
    search_string: r.searchstring || null,
    plays: r.plays || 0,
    last_play: r.lastplay || null,
  }));

  const batchSize = 100;
  let totalAdded = 0, totalUpdated = 0;

  for (let i = 0; i < songs.length; i += batchSize) {
    const batch = songs.slice(i, i + batchSize);
    const data = JSON.stringify({ songs: batch });

    await new Promise((resolve, reject) => {
      const url = new URL(API_URL);
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'X-Sync-Key': SYNC_KEY,
        },
      }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          const result = JSON.parse(body);
          if (result.status === 'success') {
            totalAdded += result.added;
            totalUpdated += result.updated;
            const pct = Math.min(100, Math.round((i + batch.length) / songs.length * 100));
            console.log(`Progress: ${pct}% (${i + batch.length}/${songs.length}) - +${result.added} new, ${result.updated} updated`);
          } else {
            console.error('Sync error:', result.message);
          }
          resolve();
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  console.log(`\nDone! ${totalAdded} added, ${totalUpdated} updated (${songs.length} total)`);
}

sync().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
