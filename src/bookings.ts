import { Hono } from 'hono';
import type { Bindings } from './helpers';
import { calendar } from './helpers';

export function register(app: Hono<{ Bindings: Bindings }>) {
  app.get('/api/calendar/auth', async (c) => {
    const clientId = c.env.GOOGLE_CLIENT_ID;
    if (!clientId) return c.json({ status: 'error', message: 'Google Calendar not configured' }, 503);
    const redirectUri = `${new URL(c.req.url).origin}/api/calendar/callback`;
    const url = calendar.getAuthUrl(clientId, redirectUri);
    return c.redirect(url);
  });

  app.get('/api/calendar/callback', async (c) => {
    const clientId = c.env.GOOGLE_CLIENT_ID;
    const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
    const code = c.req.query('code');
    if (!clientId || !clientSecret) return c.json({ status: 'error', message: 'Google Calendar not configured' }, 503);
    if (!code) return c.json({ status: 'error', message: 'No authorization code' }, 400);
    const redirectUri = `${new URL(c.req.url).origin}/api/calendar/callback`;
    try {
      const tokens = await calendar.exchangeCode(clientId, clientSecret, code, redirectUri);
      await c.env.NALEDI_DB.prepare(
        `INSERT OR REPLACE INTO calendar_tokens (id, refresh_token, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)`
      ).bind(tokens.refresh_token).run();
      return c.json({ status: 'success', message: 'Calendar connected! You can close this tab.' });
    } catch (err: any) {
      return c.json({ status: 'error', message: err.message }, 500);
    }
  });

  app.get('/api/calendar/status', async (c) => {
    const row = await c.env.NALEDI_DB.prepare(
      'SELECT refresh_token, updated_at FROM calendar_tokens WHERE id = 1'
    ).first<{ refresh_token: string; updated_at: string }>();
    return c.json({
      status: 'success',
      connected: !!row?.refresh_token,
      connected_at: row?.updated_at || null,
    });
  });

  app.get('/api/calendar/events', async (c) => {
    const clientId = c.env.GOOGLE_CLIENT_ID;
    const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return c.json({ status: 'error', message: 'Calendar not configured' }, 503);
    const row = await c.env.NALEDI_DB.prepare(
      'SELECT refresh_token FROM calendar_tokens WHERE id = 1'
    ).first<{ refresh_token: string }>();
    if (!row) return c.json({ status: 'error', message: 'Calendar not connected. Visit /api/calendar/auth to connect.' }, 401);
    try {
      const { access_token } = await calendar.refreshAccessToken(clientId, clientSecret, row.refresh_token);
      const maxResults = Math.min(Number(c.req.query('max')) || 10, 50);
      const events = await calendar.listEvents(access_token, maxResults, c.req.query('from') || undefined);
      return c.json({ status: 'success', events });
    } catch (err: any) {
      return c.json({ status: 'error', message: err.message }, 500);
    }
  });

  app.post('/api/calendar/check', async (c) => {
    const clientId = c.env.GOOGLE_CLIENT_ID;
    const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return c.json({ status: 'error', message: 'Calendar not configured' }, 503);
    const row = await c.env.NALEDI_DB.prepare(
      'SELECT refresh_token FROM calendar_tokens WHERE id = 1'
    ).first<{ refresh_token: string }>();
    if (!row) return c.json({ status: 'error', message: 'Calendar not connected.' }, 401);
    const { timeMin, timeMax } = await c.req.json();
    if (!timeMin || !timeMax) return c.json({ status: 'error', message: 'timeMin and timeMax required' }, 400);
    try {
      const { access_token } = await calendar.refreshAccessToken(clientId, clientSecret, row.refresh_token);
      const busy = await calendar.checkAvailability(access_token, timeMin, timeMax);
      return c.json({ status: 'success', busy });
    } catch (err: any) {
      return c.json({ status: 'error', message: err.message }, 500);
    }
  });

  app.post('/api/calendar/book', async (c) => {
    const clientId = c.env.GOOGLE_CLIENT_ID;
    const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return c.json({ status: 'error', message: 'Calendar not configured' }, 503);
    const row = await c.env.NALEDI_DB.prepare(
      'SELECT refresh_token FROM calendar_tokens WHERE id = 1'
    ).first<{ refresh_token: string }>();
    if (!row) return c.json({ status: 'error', message: 'Calendar not connected.' }, 401);
    const body = await c.req.json();
    if (!body.summary || !body.start?.dateTime || !body.end?.dateTime) {
      return c.json({ status: 'error', message: 'summary, start.dateTime, end.dateTime required' }, 400);
    }
    try {
      const { access_token } = await calendar.refreshAccessToken(clientId, clientSecret, row.refresh_token);
      const event = await calendar.createEvent(access_token, {
        summary: body.summary,
        description: body.description || '',
        start: { dateTime: body.start.dateTime, timeZone: body.start.timeZone || 'Africa/Johannesburg' },
        end: { dateTime: body.end.dateTime, timeZone: body.end.timeZone || 'Africa/Johannesburg' },
        attendees: body.attendees,
      });
      return c.json({ status: 'success', event });
    } catch (err: any) {
      return c.json({ status: 'error', message: err.message }, 500);
    }
  });
}
