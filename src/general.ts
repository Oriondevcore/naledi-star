import { Hono } from 'hono';
import type { Bindings } from './helpers';
import { sendWhatsAppMessage } from './cloud-api';
import { sanitizePhone } from './helpers';
import { getAllClients, getGlobalUsageSummary, getClientUsageStats, setFeature, addTransaction } from './feature-router';

function privchatIdentify(pin: string, env: Bindings): string | null {
  if (pin === (env as any).GRAHAM_PIN) return 'Graham';
  return null;
}

export function register(app: Hono<{ Bindings: Bindings }>) {
  app.get('/api/logs', async (c) => {
    const limit = Math.min(Number(c.req.query('limit')) || 50, 200);
    const logs = await c.env.NALEDI_DB.prepare(
      'SELECT id, user_id, user_name, user_message, naledi_reply, created_at FROM naledi_logs ORDER BY id DESC LIMIT ?'
    ).bind(limit).all();
    return c.json({ status: 'success', logs: logs.results });
  });

  app.get('/api/pwa/config', (c) => {
    return c.json({ appName: 'Naledi Star', supportPhone: '27724971810' });
  });

  // ── Gateway Heartbeat ──
  app.post('/api/gateway/heartbeat', async (c) => {
    try {
      const { gateway, status, detail, uptime, memory_mb } = await c.req.json();
      if (!gateway) return c.json({ error: 'gateway required' }, 400);
      await c.env.NALEDI_DB.prepare(
        `CREATE TABLE IF NOT EXISTS gateway_heartbeats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          gateway TEXT,
          status TEXT,
          detail TEXT,
          uptime REAL,
          memory_mb INTEGER,
          created_at TEXT DEFAULT (datetime('now'))
        )`
      ).run();
      await c.env.NALEDI_DB.prepare(
        "INSERT INTO gateway_heartbeats (gateway, status, detail, uptime, memory_mb) VALUES (?, ?, ?, ?, ?)"
      ).bind(gateway, status || 'unknown', detail || null, uptime || 0, memory_mb || 0).run();
      return c.json({ status: 'ok' });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.get('/api/gateway/status', async (c) => {
    try {
      const recent = await c.env.NALEDI_DB.prepare(
        "SELECT gateway, status, detail, uptime, memory_mb, created_at FROM gateway_heartbeats WHERE created_at >= datetime('now', '-5 minutes') ORDER BY id DESC"
      ).all<any>();
      const map: Record<string, any> = {};
      for (const h of (recent.results || [])) {
        if (!map[h.gateway] || h.created_at > map[h.gateway].created_at) {
          map[h.gateway] = h;
        }
      }
      return c.json({ status: 'success', gateways: Object.values(map) });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ── PlantWise Auth ──
  async function hashPassword(password: string): Promise<string> {
    const data = new TextEncoder().encode(password + 'orion-plantwise-v2');
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  app.post('/api/auth/register', async (c) => {
    try {
      const { email, password, name } = await c.req.json();
      if (!email || !password) return c.json({ status: 'error', message: 'email and password required' }, 400);
      const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first();
      if (existing) return c.json({ status: 'error', message: 'Email already registered' }, 409);
      const uuid = crypto.randomUUID();
      const hash = await hashPassword(password);
      const user = await c.env.DB.prepare(
        "INSERT INTO users (uuid, name, email, password_hash, auth_provider, is_verified) VALUES (?, ?, ?, ?, 'local', 1) RETURNING id, uuid, name, email"
      ).bind(uuid, name || email.split('@')[0], email.toLowerCase(), hash).first<{ id: number; uuid: string; name: string; email: string }>();
      if (!user) return c.json({ status: 'error', message: 'Failed to create user' }, 500);
      const token = crypto.randomUUID();
      const expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
      await c.env.DB.prepare(
        'INSERT INTO user_sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
      ).bind(token, user.id, expires).run();
      return c.json({ status: 'ok', token, user: { id: user.uuid, name: user.name, email: user.email } });
    } catch (e: any) {
      return c.json({ status: 'error', message: e.message }, 500);
    }
  });

  app.post('/api/auth/login', async (c) => {
    try {
      const { email, password } = await c.req.json();
      if (!email || !password) return c.json({ status: 'error', message: 'email and password required' }, 400);
      const user = await c.env.DB.prepare(
        'SELECT id, uuid, name, email, password_hash FROM users WHERE email = ? AND is_active = 1'
      ).bind(email.toLowerCase()).first<{ id: number; uuid: string; name: string; email: string; password_hash: string }>();
      if (!user) return c.json({ status: 'error', message: 'Invalid email or password' }, 401);
      const hash = await hashPassword(password);
      if (user.password_hash !== hash) return c.json({ status: 'error', message: 'Invalid email or password' }, 401);
      const token = crypto.randomUUID();
      const expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
      await c.env.DB.prepare(
        'INSERT INTO user_sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
      ).bind(token, user.id, expires).run();
      return c.json({ status: 'ok', token, user: { id: user.uuid, name: user.name, email: user.email } });
    } catch (e: any) {
      return c.json({ status: 'error', message: e.message }, 500);
    }
  });

  app.get('/api/auth/me', async (c) => {
    try {
      const auth = c.req.header('Authorization');
      if (!auth || !auth.startsWith('Bearer ')) return c.json({ status: 'error', message: 'Unauthorized' }, 401);
      const token = auth.slice(7);
      const session = await c.env.DB.prepare(
        'SELECT s.user_id, s.expires_at FROM user_sessions s WHERE s.id = ? AND s.expires_at > datetime(\'now\')'
      ).bind(token).first<{ user_id: number; expires_at: string }>();
      if (!session) return c.json({ status: 'error', message: 'Session expired or invalid' }, 401);
      const user = await c.env.DB.prepare(
        'SELECT uuid, name, email FROM users WHERE id = ?'
      ).bind(session.user_id).first<{ uuid: string; name: string; email: string }>();
      if (!user) return c.json({ status: 'error', message: 'User not found' }, 404);
      return c.json({ status: 'ok', user: { id: user.uuid, name: user.name, email: user.email } });
    } catch (e: any) {
      return c.json({ status: 'error', message: e.message }, 500);
    }
  });

  app.get('/a/:token', async (c) => {
    const { token } = c.req.param();
    const row = await c.env.NALEDI_DB.prepare(
      'SELECT phone, name, role, is_active FROM pwa_tokens WHERE token = ?'
    ).bind(token).first<{ phone: string; name: string; role: string; is_active: number }>();
    if (!row || !row.is_active) {
      const html = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;background:#0B1D3A;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px}div{max-width:320px}h2{color:#EF5350}p{color:#90A4AE}</style></head><body><div><h2>Link expired or invalid</h2><p>Please contact Graham for a new access link.</p></div></body></html>`;
      return c.html(html);
    }
    await c.env.NALEDI_DB.prepare(
      'UPDATE pwa_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token = ?'
    ).bind(token).run();
    const loginHtml = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script>
      localStorage.setItem('naledi_token','${token}');
      localStorage.setItem('naledi_name','${row.name.replace(/'/g, "\\'")}');
      localStorage.setItem('naledi_phone','${row.phone}');
      localStorage.setItem('naledi_role','${row.role}');
      window.location.replace('/');
    </script><style>body{background:#0B1D3A;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;}</style></head><body><p>Logging you in...</p></body></html>`;
    return c.html(loginHtml);
  });

  app.get('/api/pwa/me', async (c) => {
    const token = c.req.query('token') || '';
    if (!token) return c.json({ error: 'Token required' }, 401);
    const row = await c.env.NALEDI_DB.prepare(
      'SELECT phone, name, role, is_active FROM pwa_tokens WHERE token = ?'
    ).bind(token).first<{ phone: string; name: string; role: string; is_active: number }>();
    if (!row || !row.is_active) return c.json({ error: 'Invalid token' }, 401);
    return c.json({ phone: row.phone, name: row.name, role: row.role });
  });

  app.post('/api/pwa/admin/tokens', async (c) => {
    const { token: adminToken, phone, name, role } = await c.req.json();
    const admin = await c.env.NALEDI_DB.prepare(
      'SELECT phone, is_active FROM pwa_tokens WHERE token = ? AND role = ?'
    ).bind(adminToken, 'admin').first<{ phone: string; is_active: number }>();
    const grahamNumber = (c.env as any).GRAHAM_NUMBER || '';
    const adminCode = (c.env as any).ADMIN_AUTH_CODE || '';
    const isAuthorized = admin?.is_active || (adminToken === adminCode && grahamNumber.length > 0);
    if (!isAuthorized) return c.json({ error: 'Unauthorized' }, 403);
    if (!phone || !name || !role) return c.json({ error: 'phone, name, role required' }, 400);
    const newToken = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    await c.env.NALEDI_DB.prepare(
      'INSERT INTO pwa_tokens (token, phone, name, role, created_by) VALUES (?, ?, ?, ?, ?)'
    ).bind(newToken, phone, name, role, adminToken).run();
    const url = `${new URL(c.req.url).origin}/a/${newToken}`;
    return c.json({ status: 'success', token: newToken, url });
  });

  app.post('/api/pwa/admin/tokens/revoke', async (c) => {
    const { token: adminToken, target } = await c.req.json();
    const admin = await c.env.NALEDI_DB.prepare(
      'SELECT is_active FROM pwa_tokens WHERE token = ? AND role = ?'
    ).bind(adminToken, 'admin').first<{ is_active: number }>();
    const revokeAdminCode = (c.env as any).ADMIN_AUTH_CODE || '';
    if (!admin?.is_active && adminToken !== revokeAdminCode) return c.json({ error: 'Unauthorized' }, 403);
    await c.env.NALEDI_DB.prepare('UPDATE pwa_tokens SET is_active = 0 WHERE token = ?').bind(target).run();
    return c.json({ status: 'success' });
  });

  app.get('/api/pwa/graham-check', async (c) => {
    const phone = c.req.query('phone') || '';
    const grahamNumber = (c.env as any).GRAHAM_NUMBER || '';
    return c.json({ isGraham: grahamNumber.length > 0 && phone === sanitizePhone(grahamNumber) });
  });

  app.get('/api/pwa/matches', async (c) => {
    const phone = sanitizePhone(c.req.query('phone') || '');
    if (!phone) return c.json({ role: 'unknown' });

    const active = await c.env.NALEDI_DB.prepare(
      'SELECT * FROM pwa_assignments WHERE (elderly_phone = ? OR carer_phone = ?) AND status = ?'
    ).bind(phone, phone, 'active').all();

    const asElderly = active.results.filter((r: any) => r.elderly_phone === phone);
    const asCarer = active.results.filter((r: any) => r.carer_phone === phone);

    if (asCarer.length > 0) {
      return c.json({
        role: 'carer',
        clients: asCarer.map((r: any) => ({
          id: r.elderly_phone,
          name: r.elderly_name || r.elderly_phone,
        })),
      });
    }

    if (asElderly.length > 0) {
      const match: any = asElderly[0];
      return c.json({
        role: 'elderly',
        carer: { id: match.carer_phone, name: match.carer_name },
      });
    }

    const pendingCount = await c.env.NALEDI_DB.prepare(
      "SELECT COUNT(*) as count FROM pwa_assignments WHERE status = 'pending'"
    ).first<{ count: number }>();

    return c.json({
      role: 'unknown',
      total_matches: active.results.length,
      pending_matches: pendingCount?.count || 0,
    });
  });

  app.post('/api/pwa/messages', async (c) => {
    const { from_phone, to_id, text } = await c.req.json();
    if (!from_phone || !to_id || !text) return c.json({ status: 'error', message: 'Missing fields' }, 400);
    const phones = [sanitizePhone(from_phone), sanitizePhone(to_id)].sort();
    const conversationKey = phones.join(':');
    await c.env.NALEDI_DB.prepare(
      'INSERT INTO pwa_messages (conversation_key, from_phone, text) VALUES (?, ?, ?)'
    ).bind(conversationKey, sanitizePhone(from_phone), text).run();
    return c.json({ status: 'success' });
  });

  app.get('/api/pwa/messages', async (c) => {
    const phone = sanitizePhone(c.req.query('phone') || '');
    const partner = sanitizePhone(c.req.query('partner') || '');
    if (!phone || !partner) return c.json({ messages: [] });
    const conversationKey = [phone, partner].sort().join(':');
    const msgs = await c.env.NALEDI_DB.prepare(
      'SELECT id, from_phone, text, created_at FROM pwa_messages WHERE conversation_key = ? ORDER BY id ASC LIMIT 200'
    ).bind(conversationKey).all();
    return c.json({
      messages: msgs.results.map((m: any) => ({
        id: m.id,
        from: m.from_phone,
        text: m.text,
        created_at: m.created_at,
      })),
    });
  });

  app.post('/api/pwa/emergency', async (c) => {
    const { phone, name } = await c.req.json();
    if (!phone) return c.json({ status: 'error', message: 'Phone required' }, 400);
    const from = sanitizePhone(phone);

    const assign = await c.env.NALEDI_DB.prepare(
      'SELECT * FROM pwa_assignments WHERE elderly_phone = ? AND status = ?'
    ).bind(from, 'active').first<any>();

    if (assign) {
      try {
        await c.env.SELF.fetch('http://dummy/api/incoming', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: (c.env as any).GRAHAM_NUMBER || '27724971810',
            body: `🚨 EMERGENCY ALERT from ${name || phone} (elderly client). Their carer is ${assign.carer_name} (${assign.carer_phone}). Please notify them immediately.`,
            name: 'Naledi Star Alert',
          }),
        });
      } catch { }
    }

    await c.env.NALEDI_DB.prepare(
      "INSERT INTO naledi_logs (user_id, user_name, user_message, naledi_reply) VALUES (?, ?, '🚨 EMERGENCY BUTTON PRESSED', 'Alert sent to carer')"
    ).bind(from, name || 'Unknown').run();

    return c.json({ status: 'success', alerted: !!assign });
  });

  // ── Business Dashboard ──
  app.get('/api/business/summary', async (c) => {
    const phone = sanitizePhone(c.req.query('phone') || '');
    if (phone !== '27724971810') {
      return c.json({ error: 'Unauthorized' }, 403);
    }
    try {
      const db = c.env.NALEDI_DB;

      async function safeQuery<T>(promise: Promise<T>): Promise<T | null> {
        try { return await promise; } catch { return null; }
      }

      const [logs, users, orders, pending, songs, todayLogs, revenue, revenueMonth, monthPayments, subs, sentToday, failedToday, lastActive, subscriptions, platformRevenue] = await Promise.all([
        safeQuery(db.prepare("SELECT COUNT(*) as c FROM naledi_logs WHERE created_at >= datetime('now', '-7 days')").first<{ c: number }>()),
        safeQuery(c.env.DB.prepare('SELECT COUNT(*) as c FROM users').first<{ c: number }>()),
        safeQuery(db.prepare("SELECT COUNT(*) as c FROM orders WHERE notified = 0").first<{ c: number }>()),
        safeQuery(db.prepare("SELECT COUNT(*) as c FROM outbox_messages WHERE status = 'pending'").first<{ c: number }>()),
        safeQuery(c.env.KARAOKE_DB.prepare('SELECT COUNT(*) as c FROM dbSongs').first<{ c: number }>()),
        safeQuery(db.prepare("SELECT COUNT(*) as c FROM naledi_logs WHERE date(created_at) = date('now')").first<{ c: number }>()),
        safeQuery(db.prepare("SELECT COALESCE(SUM(amount_in_cents), 0) as c FROM payments WHERE status = 'completed'").first<{ c: number }>()),
        safeQuery(db.prepare("SELECT COALESCE(SUM(amount_in_cents), 0) as c FROM payments WHERE status = 'completed' AND created_at >= datetime('now', '-30 days')").first<{ c: number }>()),
        safeQuery(db.prepare("SELECT COUNT(*) as c FROM payments WHERE status = 'completed' AND created_at >= datetime('now', '-30 days')").first<{ c: number }>()),
        safeQuery(db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active, SUM(CASE WHEN plan = 'starter' THEN 1 ELSE 0 END) as starter, SUM(CASE WHEN plan = 'business' THEN 1 ELSE 0 END) as business, SUM(CASE WHEN plan = 'pro' THEN 1 ELSE 0 END) as pro FROM subscribers").first<any>()),
        safeQuery(db.prepare("SELECT COUNT(*) as c FROM outbox_messages WHERE status = 'sent' AND date(created_at) = date('now')").first<{ c: number }>()),
        safeQuery(db.prepare("SELECT COUNT(*) as c FROM outbox_messages WHERE status = 'failed' AND date(created_at) = date('now')").first<{ c: number }>()),
        safeQuery(db.prepare("SELECT MAX(created_at) as t FROM naledi_logs").first<{ t: string }>()),
        safeQuery(c.env.DB.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active, SUM(CASE WHEN status = 'trialing' THEN 1 ELSE 0 END) as trialing, SUM(CASE WHEN status = 'past_due' THEN 1 ELSE 0 END) as past_due, SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) as canceled FROM subscriptions").first<any>()),
        safeQuery(c.env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) as c FROM invoices WHERE status = 'paid' AND created_at >= datetime('now', '-30 days')").first<{ c: number }>()),
      ]);
      return c.json({
        status: 'success',
        today_enquiries: todayLogs?.c || 0,
        weekly_enquiries: logs?.c || 0,
        total_users: users?.c || 0,
        pending_orders: orders?.c || 0,
        pending_outbox: pending?.c || 0,
        karaoke_songs: songs?.c || 0,
        revenue_cents: revenue?.c || 0,
        revenue_cents_30d: revenueMonth?.c || 0,
        payments_30d: monthPayments?.c || 0,
        subscribers_total: subs?.total || 0,
        subscribers_active: subs?.active || 0,
        subscribers_starter: subs?.starter || 0,
        subscribers_business: subs?.business || 0,
        subscribers_pro: subs?.pro || 0,
        outbox_sent_today: sentToday?.c || 0,
        outbox_failed_today: failedToday?.c || 0,
        last_naledi_active: lastActive?.t || null,
        subscriptions_total: subscriptions?.total || 0,
        subscriptions_active: subscriptions?.active || 0,
        subscriptions_trialing: subscriptions?.trialing || 0,
        subscriptions_past_due: subscriptions?.past_due || 0,
        subscriptions_canceled: subscriptions?.canceled || 0,
        platform_revenue_30d: platformRevenue?.c || 0,
        as_of: new Date().toISOString(),
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ── Dashboard HTML page ──
  app.get('/dashboard', async (c) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ORION PRO — Dashboard</title>
<meta name="theme-color" content="#0c0c0d">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0c0c0d;color:#e0e0e0;min-height:100vh;min-height:100dvh}
  .container{max-width:720px;margin:0 auto;padding:20px 16px 40px}
  .header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid #1a1a1a}
  .header h1{font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.3px}
  .header h1 em{color:#c8a84e;font-style:normal}
  .header .time{font-size:12px;color:#555;font-weight:400}
  .header .logout{background:none;border:1px solid #222;color:#555;padding:6px 14px;border-radius:8px;font-size:11px;cursor:pointer;transition:all .2s}
  .header .logout:hover{border-color:#c8a84e;color:#c8a84e}
  .login{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:80vh;text-align:center;padding:24px}
  .login .logo{font-size:32px;font-weight:700;color:#fff;margin-bottom:4px;letter-spacing:-1px}
  .login .logo em{color:#c8a84e;font-style:normal}
  .login .tagline{color:#555;font-size:13px;margin-bottom:32px}
  .login input{padding:14px 16px;border-radius:10px;border:1px solid #222;background:#0d0d0d;color:#fff;font-size:16px;width:100%;max-width:280px;text-align:center;outline:none;transition:border-color 0.2s}
  .login input:focus{border-color:#c8a84e}
  .login button{margin-top:12px;padding:14px 0;border-radius:10px;border:none;background:#c8a84e;color:#0c0c0d;font-size:16px;font-weight:600;width:100%;max-width:280px;cursor:pointer;transition:opacity 0.2s}
  .login button:active{opacity:0.7}
  .login .error{color:#ff4444;font-size:13px;margin-top:8px;display:none}
  .grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:20px}
  .card{background:linear-gradient(135deg,#111,#0d0d0d);border:1px solid #1a1a1a;border-radius:12px;padding:14px;transition:border-color 0.2s}
  .card:hover{border-color:#2a2a2a}
  .card.highlight{border-color:#c8a84e33;background:linear-gradient(135deg,#111108,#0d0d0a)}
  .card.highlight:hover{border-color:#c8a84e66}
  .card .label{font-size:10px;text-transform:uppercase;letter-spacing:0.8px;color:#555;margin-bottom:4px}
  .card .value{font-size:26px;font-weight:700;color:#fff;line-height:1.1}
  .card .value.gold{color:#c8a84e}
  .card .value.green{color:#22c55e}
  .card .value.red{color:#ef4444}
  .card .sub{font-size:10px;color:#444;margin-top:4px}
  .card.full{grid-column:1/-1}
  .section-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#444;margin:24px 0 10px;display:flex;align-items:center;gap:8px}
  .section-title .badge{font-size:9px;background:#1a1a1a;color:#666;padding:2px 8px;border-radius:10px;font-weight:400;text-transform:none;letter-spacing:0}
  .log-item{display:grid;grid-template-columns:auto 1fr auto;gap:10px;padding:8px 0;border-bottom:1px solid #0f0f0f;font-size:12px;align-items:center}
  .log-item .name{color:#ccc;font-weight:500}
  .log-item .msg{color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .log-item .time{color:#333;font-size:10px;white-space:nowrap;font-variant-numeric:tabular-nums}
  .tabs{display:flex;gap:4px;margin-bottom:16px;background:#0a0a0a;padding:4px;border-radius:10px;border:1px solid #1a1a1a}
  .tab{padding:8px 16px;border-radius:8px;font-size:12px;font-weight:500;color:#555;cursor:pointer;transition:all .2s;border:none;background:none}
  .tab.active{background:#1a1a1a;color:#fff}
  .tab:hover:not(.active){color:#888}
  .tab-content{display:none}
  .tab-content.active{display:block}
  .payment-item{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #0f0f0f;font-size:12px}
  .payment-item .name{color:#ccc}
  .payment-item .amt{color:#c8a84e;font-weight:600;font-variant-numeric:tabular-nums}
  .payment-item .date{color:#333;font-size:10px}
  .quick-msg{display:flex;gap:8px;margin-top:12px}
  .quick-msg input{flex:1;padding:10px 14px;border-radius:8px;border:1px solid #1a1a1a;background:#0d0d0d;color:#fff;font-size:13px;outline:none;transition:border-color .2s}
  .quick-msg input:focus{border-color:#c8a84e}
  .quick-msg button{padding:10px 20px;border-radius:8px;border:none;background:#c8a84e;color:#0c0c0d;font-weight:600;font-size:12px;cursor:pointer;white-space:nowrap;transition:opacity .2s}
  .quick-msg button:active{opacity:0.7}
  .status{font-size:11px;color:#555;margin-top:6px;transition:opacity .3s}
  .footer{margin-top:32px;padding-top:12px;border-top:1px solid #1a1a1a;font-size:10px;color:#333;text-align:center}
  .footer a{color:#444;text-decoration:none}
  .footer a:hover{color:#c8a84e}
  .status-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px}
  .status-dot.green{background:#22c55e}
  .status-dot.red{background:#ef4444}
  .status-dot.yellow{background:#eab308}
  @media(max-width:560px){.grid{grid-template-columns:1fr 1fr}.container{padding:16px 12px 32px}.card .value{font-size:22px}}
  @media(max-width:380px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="container" id="app">
  <div class="login" id="loginScreen">
    <div class="logo">ORION <em>PRO</em></div>
    <div class="tagline">Owner Dashboard</div>
    <input type="tel" id="phoneInput" placeholder="Your phone number" inputmode="numeric">
    <button onclick="login()">Enter</button>
    <div class="error" id="loginError"></div>
  </div>
  <div id="dashboard" style="display:none">
    <div class="header">
      <div>
        <h1><em>ORION</em> PRO <span id="userLabel"></span></h1>
        <div class="time" id="lastUpdated">Loading...</div>
      </div>
      <button class="logout" onclick="logout()">Logout</button>
    </div>
    <div class="grid" id="cards"></div>
    <div class="tabs">
      <button class="tab active" onclick="switchTab('enquiries',this)">Enquiries</button>
      <button class="tab" onclick="switchTab('payments',this)">Payments</button>
      <button class="tab" onclick="switchTab('outbox',this)">Outbox</button>
      <button class="tab" onclick="switchTab('send',this)">Send</button>
    </div>
    <div class="tab-content active" id="tab-enquiries">
      <div class="section-title">Recent Enquiries <span class="badge" id="enquiryCount">0</span></div>
      <div id="logs"></div>
    </div>
    <div class="tab-content" id="tab-payments">
      <div class="section-title">Payment History <span class="badge" id="paymentCount">0</span></div>
      <div id="payments"></div>
    </div>
    <div class="tab-content" id="tab-outbox">
      <div class="section-title">Message Queue <span class="badge" id="outboxCount">0</span></div>
      <div id="outboxMessages"></div>
    </div>
    <div class="tab-content" id="tab-send">
      <div class="section-title">Send Message</div>
      <div class="quick-msg">
        <input type="text" id="msgInput" placeholder="Message to Graham..." maxlength="500">
        <button onclick="sendMessage()">Send</button>
      </div>
      <div class="status" id="msgStatus"></div>
    </div>
    <div class="footer">
      <a href="/admin/customers">Customers</a> &middot; <a href="/admin/leads">Leads</a> &middot;
      <a href="/admin/guide">Guide</a> &middot; Orion 2026
    </div>
  </div>
</div>
<script>
const STORAGE_KEY = 'orion_dash_phone';
let phone = localStorage.getItem(STORAGE_KEY) || '';
let refreshInterval;

if (phone) showDashboard(phone);

function login() {
  const p = document.getElementById('phoneInput').value.replace(/[^0-9]/g,'');
  if (p !== '27724971810') {
    document.getElementById('loginError').textContent = 'Not authorized.';
    document.getElementById('loginError').style.display = 'block';
    return;
  }
  localStorage.setItem(STORAGE_KEY, p);
  showDashboard(p);
}

function logout() {
  localStorage.removeItem(STORAGE_KEY);
  clearInterval(refreshInterval);
  location.reload();
}

function showDashboard(phone) {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
  document.getElementById('userLabel').textContent = '(Graham)';
  fetchData(phone);
  refreshInterval = setInterval(() => fetchData(phone), 30000);
}

function switchTab(name, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

function fmtZAR(cents) {
  return 'R' + (cents / 100).toLocaleString('en-ZA', {minimumFractionDigits:2,maximumFractionDigits:2});
}

async function fetchData(phone) {
  try {
    const [summaryRes, logsRes, paymentsRes, outboxRes, gwRes] = await Promise.all([
      fetch('/api/business/summary?phone=' + phone),
      fetch('/api/logs?limit=15'),
      fetch('/api/admin/payments?phone=' + phone + '&limit=20'),
      fetch('/api/outbox?sender=naledi'),
      fetch('/api/gateway/status')
    ]);
    const summary = await summaryRes.json();
    const logs = await logsRes.json();
    const payments = await paymentsRes.json();
    const outbox = await outboxRes.json();
    const gw = await gwRes.json();
    renderCards(summary, gw.gateways || []);
    renderLogs(logs.logs || []);
    renderPayments(payments.payments || []);
    renderOutbox(outbox.messages || []);
    document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString() + ' today';
  } catch(e) {
    document.getElementById('lastUpdated').textContent = 'Offline';
  }
}

function renderCards(d, gateways) {
  if (d.status !== 'success') return;
  const revenue30 = fmtZAR(d.revenue_cents_30d);
  const nalGw = gateways.find(g => g.gateway === 'naledi');
  const gwStatus = nalGw ? (nalGw.status === 'connected' ? 'Connected' : nalGw.status) : 'No signal';
  const gwClass = nalGw && nalGw.status === 'connected' ? 'green' : 'red';
  document.getElementById('cards').innerHTML = [
    {label:'Enquiries Today',value:d.today_enquiries,cls:'gold',sub:d.weekly_enquiries+' this week'},
    {label:'Revenue (30d)',value:revenue30,cls:'gold highlight',sub:d.payments_30d+' payments'},
    {label:'Total Revenue',value:fmtZAR(d.revenue_cents),cls:'gold',sub:'all time'},
    {label:'Subscribers',value:d.subscribers_total||0,cls:'',sub:(d.subscribers_active||0)+' active'},
    {label:'Outbox Sent Today',value:d.outbox_sent_today,cls:'green',sub:(d.outbox_failed_today||0)>0?d.outbox_failed_today+' failed':'no failures'},
    {label:'Queue Depth',value:d.pending_outbox,cls:d.pending_outbox>5?'yellow':'',sub:d.pending_orders+' pending orders'},
    {label:'Naledi Gateway',value:gwStatus,cls:gwClass,sub:nalGw?nalGw.memory_mb+'MB RAM':'no heartbeat'},
    {label:'Naledi Active',value:d.last_naledi_active?new Date(d.last_naledi_active+'Z').toLocaleDateString():'--',cls:'',sub:d.last_naledi_active?'last activity':'no activity'},
  ].map(c => '<div class="card'+(c.cls.includes('highlight')?' highlight':'')+'"><div class="label">'+c.label+'</div><div class="value '+(c.cls||'')+'">'+c.value+'</div><div class="sub">'+(c.sub||'')+'</div></div>').join('');
}

function renderLogs(logs) {
  document.getElementById('enquiryCount').textContent = logs.length;
  if (!logs.length) {
    document.getElementById('logs').innerHTML = '<div style="color:#333;font-size:13px;text-align:center;padding:20px">No enquiries yet.</div>';
    return;
  }
  document.getElementById('logs').innerHTML = logs.map(l => {
    const date = l.created_at ? new Date(l.created_at+'Z').toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : '';
    return '<div class="log-item"><span class="name">'+(l.user_name||'Unknown')+'</span><span class="msg">'+(l.user_message||'')+'</span><span class="time">'+date+'</span></div>';
  }).join('');
}

function renderPayments(payments) {
  document.getElementById('paymentCount').textContent = payments.length;
  if (!payments.length) {
    document.getElementById('payments').innerHTML = '<div style="color:#333;font-size:13px;text-align:center;padding:20px">No payments yet.</div>';
    return;
  }
  document.getElementById('payments').innerHTML = payments.map(p => {
    const date = p.created_at ? new Date(p.created_at+'Z').toLocaleDateString() : '';
    return '<div class="payment-item"><span class="name">'+(p.metadata_name||'Customer')+'</span><span class="amt">'+fmtZAR(p.amount_in_cents)+'</span><span class="date">'+date+'</span></div>';
  }).join('');
}

function renderOutbox(messages) {
  document.getElementById('outboxCount').textContent = messages.length;
  if (!messages.length) {
    document.getElementById('outboxMessages').innerHTML = '<div style="color:#333;font-size:13px;text-align:center;padding:20px">No messages queued.</div>';
    return;
  }
  document.getElementById('outboxMessages').innerHTML = messages.map(m => {
    return '<div class="log-item"><span class="name">'+(m.to||'')+'</span><span class="msg">'+(m.message||'').substring(0,60)+'...</span></div>';
  }).join('');
}

async function sendMessage() {
  const msg = document.getElementById('msgInput').value.trim();
  if (!msg) return;
  const status = document.getElementById('msgStatus');
  status.textContent = 'Sending...';
  try {
    const res = await fetch('/api/send', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({to:'27724971810', message: 'From dashboard: ' + msg})
    });
    const d = await res.json();
    if (d.status === 'queued') {
      status.textContent = 'Sent to Graham.';
      document.getElementById('msgInput').value = '';
    } else {
      status.textContent = 'Failed.';
    }
  } catch(e) {
    status.textContent = 'Connection error.';
  }
  setTimeout(() => { status.textContent = ''; }, 3000);
}
</script>
</body>
</html>`;
    return c.html(html);
  });

  // ── Naledi Product Landing Page ──
  app.get('/naledi', async (c) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Naledi — AI WhatsApp Receptionist | Amanzimtoti</title>
<meta name="theme-color" content="#080809">
<meta name="description" content="AI WhatsApp receptionist for Amanzimtoti businesses. 24/7 customer service in English, Zulu and Afrikaans. Contact us for pricing.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  :root{--bg-base:#080809;--bg-surface:#111114;--bg-elevated:#18181c;--bg-subtle:#1e1e23;--border-default:#2a2a30;--border-subtle:#3a3a42;--text-primary:#f0f0f4;--text-secondary:#c0c0cc;--text-muted:#808090;--accent-primary:#00e5ff;--accent-primary-dim:rgba(0,229,255,0.15);--state-success:#34d399;--state-warning:#fbbf24;--radius:16px;--radius-sm:10px}
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',sans-serif;background:var(--bg-base);color:var(--text-secondary);line-height:1.6}
  .container{max-width:640px;margin:0 auto;padding:0 20px}

  .hero{text-align:center;padding:60px 20px 40px}
  .hero .badge{display:inline-block;background:var(--accent-primary-dim);color:var(--accent-primary);font-size:12px;padding:4px 12px;border-radius:20px;border:1px solid var(--accent-primary-dim);margin-bottom:16px;font-weight:500;letter-spacing:0.5px}
  .hero h1{font-size:32px;font-weight:800;color:var(--text-primary);margin-bottom:12px;line-height:1.2}
  .hero h1 span{background:linear-gradient(135deg,var(--accent-primary),#00bcd4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .hero p{font-size:16px;color:var(--text-muted);max-width:480px;margin:0 auto 8px}
  .hero .lang-labels{display:flex;justify-content:center;gap:8px;margin-top:16px;flex-wrap:wrap}
  .hero .lang-labels span{background:var(--bg-subtle);color:var(--text-secondary);font-size:13px;padding:4px 12px;border-radius:20px;border:1px solid var(--border-default)}
  .hero .btn-primary{display:inline-block;margin-top:28px;background:linear-gradient(135deg,var(--accent-primary),#00bcd4);color:var(--bg-base);padding:14px 32px;border-radius:var(--radius);text-decoration:none;font-size:16px;font-weight:600;cursor:pointer;border:none;transition:opacity 0.2s}
  .hero .btn-primary:active{opacity:0.8}
  .hero .cta-sub{display:block;margin-top:12px;font-size:13px;color:var(--text-muted)}

  section{padding:40px 0}
  section h2{font-size:22px;font-weight:700;color:var(--text-primary);margin-bottom:8px;text-align:center}
  section .subtitle{text-align:center;color:var(--text-muted);font-size:14px;margin-bottom:32px}

  .card-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .card{background:var(--bg-surface);border-radius:var(--radius);padding:20px;border:1px solid var(--border-default);transition:border-color 0.2s}
  .card:hover{border-color:var(--accent-primary-dim)}
  .card h3{font-size:15px;font-weight:600;color:var(--text-primary);margin-bottom:4px}
  .card p{font-size:13px;color:var(--text-muted);line-height:1.5}

  .steps{display:flex;flex-direction:column;gap:16px}
  .step{display:flex;gap:16px;align-items:flex-start;background:var(--bg-surface);border-radius:var(--radius);padding:20px;border:1px solid var(--border-default)}
  .step .num{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--accent-primary),#00bcd4);color:var(--bg-base);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;flex-shrink:0}
  .step h3{font-size:15px;font-weight:600;color:var(--text-primary);margin-bottom:2px}
  .step p{font-size:13px;color:var(--text-muted)}

  .pricing-grid{display:grid;grid-template-columns:1fr;gap:12px}
  .pricing-card{background:var(--bg-surface);border-radius:var(--radius);padding:24px;border:1px solid var(--border-default);position:relative}
  .pricing-card.featured{border-color:var(--accent-primary-dim);background:linear-gradient(135deg,var(--bg-surface),var(--bg-elevated))}
  .pricing-card.featured .popular{position:absolute;top:-10px;right:20px;background:linear-gradient(135deg,var(--accent-primary),#00bcd4);color:var(--bg-base);font-size:11px;padding:3px 10px;border-radius:var(--radius-sm);font-weight:600}
  .pricing-card h3{font-size:18px;font-weight:600;color:var(--text-primary)}
  .pricing-card .price{font-size:36px;font-weight:800;color:var(--text-primary);margin:8px 0 2px}
  .pricing-card .price span{font-size:14px;color:var(--text-muted);font-weight:400}
  .pricing-card ul{margin-top:16px;list-style:none}
  .pricing-card ul li{font-size:13px;color:var(--text-muted);padding:4px 0}
  .pricing-card .btn-primary{display:block;margin-top:20px;text-align:center;padding:12px;border-radius:var(--radius-sm);font-size:14px;font-weight:600;text-decoration:none;transition:opacity 0.2s}
  .pricing-card .btn-primary.action{background:linear-gradient(135deg,var(--accent-primary),#00bcd4);color:var(--bg-base)}
  .pricing-card .btn-primary.outline{background:var(--bg-subtle);color:var(--text-secondary);border:1px solid var(--border-default)}
  .pricing-card .btn-primary:active{opacity:0.8}

  .enquiry-form{background:var(--bg-surface);border-radius:var(--radius);padding:24px;border:1px solid var(--border-default)}
  .enquiry-form .field{margin-bottom:14px}
  .enquiry-form label{display:block;font-size:13px;color:var(--text-muted);margin-bottom:4px;font-weight:500}
  .enquiry-form input,.enquiry-form textarea,.enquiry-form select{width:100%;padding:12px 14px;border-radius:var(--radius-sm);border:1px solid var(--border-default);background:var(--bg-subtle);color:var(--text-primary);font-size:14px;outline:none;transition:border-color 0.2s;font-family:'Inter',sans-serif}
  .enquiry-form input:focus,.enquiry-form textarea:focus,.enquiry-form select:focus{border-color:var(--accent-primary)}
  .enquiry-form textarea{resize:vertical;min-height:80px}
  .enquiry-form .btn-primary{width:100%;padding:14px;border-radius:var(--radius-sm);border:none;background:linear-gradient(135deg,var(--accent-primary),#00bcd4);color:var(--bg-base);font-size:15px;font-weight:600;cursor:pointer;transition:opacity 0.2s;font-family:'Inter',sans-serif}
  .enquiry-form .btn-primary:active{opacity:0.8}
  .enquiry-form .status{text-align:center;font-size:13px;margin-top:8px;min-height:20px;color:var(--text-muted)}

  .faq-item{border-bottom:1px solid var(--border-default);padding:14px 0}
  .faq-item:last-child{border:none}
  .faq-item .faq-q{font-size:14px;color:var(--text-secondary);cursor:pointer;display:block}
  .faq-item .faq-a{display:none;font-size:13px;color:var(--text-muted);margin-top:6px;line-height:1.5}

  footer{text-align:center;padding:40px 20px;color:var(--border-subtle);font-size:12px}
  footer a{color:var(--text-muted);text-decoration:none}

  @media(max-width:480px){.card-grid{grid-template-columns:1fr}.hero h1{font-size:26px}}
</style>
</head>
<body>

<div class="container">

  <div class="hero">
    <div class="badge">Now available in Amanzimtoti</div>
    <h1>Your business needs a <span>24/7 receptionist</span></h1>
    <p>Naledi answers customer enquiries on WhatsApp instantly. In English, isiZulu, or Afrikaans. No app, no website, no training.</p>
    <div class="lang-labels">
      <span>English</span>
      <span>isiZulu</span>
      <span>Afrikaans</span>
    </div>
    <a class="btn-primary" href="#enquire">Get Naledi for your business</a>
    <span class="cta-sub">Custom pricing for your business. Contact us for a quote.</span>
  </div>

  <section>
    <h2>How it works</h2>
    <p class="subtitle">Three minutes to set up. Your customers will not notice the difference.</p>
    <div class="steps">
      <div class="step">
        <div class="num">1</div>
        <div><h3>We set you up</h3><p>Tell us your business hours, services, and FAQs. We configure Naledi in one day.</p></div>
      </div>
      <div class="step">
        <div class="num">2</div>
        <div><h3>Share the number</h3><p>Give your customers the Naledi WhatsApp number. Or we forward your existing number.</p></div>
      </div>
      <div class="step">
        <div class="num">3</div>
        <div><h3>She handles the rest</h3><p>Enquiries, quotes, bookings — Naledi answers instantly. Complex requests get forwarded to you.</p></div>
      </div>
    </div>
  </section>

  <section>
    <h2>What Naledi can do for you</h2>
    <p class="subtitle">She never sleeps, never takes lunch, and never puts a customer on hold.</p>
    <div class="card-grid">
      <div class="card"><h3>Instant replies</h3><p>Customers get answers in under 3 seconds. 24 hours a day, 7 days a week.</p></div>
      <div class="card"><h3>Three languages</h3><p>English, isiZulu, and Afrikaans. She detects and responds in the same language.</p></div>
      <div class="card"><h3>Handles bookings</h3><p>Takes enquiry details and passes them straight to you. No missed opportunities.</p></div>
      <div class="card"><h3>FAQ smart</h3><p>Knows your menu, price range, hours, and services. Answers from what you teach her.</p></div>
      <div class="card"><h3>Escalates to you</h3><p>When she cannot answer, she gets the details and you get a clean lead to follow up.</p></div>
      <div class="card"><h3>Weekly report</h3><p>See how many enquiries, what customers asked, and which led to sales.</p></div>
    </div>
  </section>

  <section>
    <h2>Pricing</h2>
    <p class="subtitle">Custom pricing for your business. No contracts. Cancel anytime.</p>
    <div class="pricing-grid">
      <div class="pricing-card">
        <h3>Starter</h3>
        <div class="price" style="font-size:20px">For small businesses</div>
        <ul>
          <li>500 conversations per month</li>
          <li>Books appointments</li>
          <li>Reads 1 price list PDF</li>
          <li>English, Zulu, Afrikaans</li>
        </ul>
        <a class="btn-primary outline" href="#enquire">Get a Quote</a>
      </div>
      <div class="pricing-card featured">
        <div class="popular">Most Popular</div>
        <h3>Business</h3>
        <div class="price" style="font-size:20px">For growing businesses</div>
        <ul>
          <li>1,500 conversations per month</li>
          <li>Google Calendar and Email</li>
          <li>Reads 3 PDFs and voice notes</li>
          <li>Zulu, Afrikaans and English</li>
          <li>Monthly report</li>
        </ul>
        <a class="btn-primary action" href="#enquire">Get a Quote</a>
      </div>
    </div>
    <p style="text-align:center;margin-top:16px;color:var(--text-muted);font-size:13px">Pro plan for chains — 5,000 conversations. Multi-location. <a href="#enquire" style="color:var(--accent-primary)">Contact us</a>.</p>
  </section>

  <section id="enquire">
    <h2>Get Naledi for your business</h2>
    <p class="subtitle">Fill this in and Graham will call you back within 24 hours.</p>
    <div class="enquiry-form">
      <div class="field"><label>Business name</label><input id="biz-name" placeholder="e.g. Amanzimtoti Pharmacy" /></div>
      <div class="field"><label>Your name</label><input id="your-name" placeholder="Your full name" /></div>
      <div class="field"><label>WhatsApp number</label><input id="biz-phone" type="tel" placeholder="+27 76 123 4567" /></div>
      <div class="field"><label>Plan interested in</label><select id="biz-plan"><option value="">Select...</option><option value="starter">Starter (500 convos)</option><option value="business">Business (1,500 convos)</option><option value="pro">Pro (5,000 convos)</option></select></div>
      <div class="field"><label>Business type</label><select id="biz-type"><option value="">Select...</option><option value="restaurant">Restaurant / Cafe</option><option value="retail">Retail / Shop</option><option value="services">Services (salon, gym, etc)</option><option value="medical">Medical / Health</option><option value="accommodation">Accommodation</option><option value="transport">Transport / Taxi</option><option value="other">Other</option></select></div>
      <div class="field"><label>Anything specific?</label><textarea id="biz-notes" placeholder="What should Naledi know about your business?"></textarea></div>
      <button class="btn-primary" onclick="sendEnquiry()">Send enquiry</button>
      <div class="status" id="enquiry-status"></div>
    </div>
  </section>

  <section>
    <h2>Questions?</h2>
    <p class="subtitle">Common ones answered</p>
    <div class="faq-item"><span class="faq-q">Do I need a new SIM card or phone?</span><div class="faq-a">No. Naledi runs on her own number. Customers message her, she answers. You do not need any new hardware.</div></div>
    <div class="faq-item"><span class="faq-q">What if the customer asks something Naledi cannot answer?</span><div class="faq-a">She gets their details and sends you a WhatsApp message with the full context. You take it from there.</div></div>
    <div class="faq-item"><span class="faq-q">Can customers still call me on my normal number?</span><div class="faq-a">Yes. Your existing number is untouched. Naledi is an additional channel — customers who prefer WhatsApp can use her.</div></div>
    <div class="faq-item"><span class="faq-q">What if I want to cancel?</span><div class="faq-a">No contracts. Cancel anytime with 7 days notice. No penalties.</div></div>
  </section>

</div>

<footer>
  <p>Made in Amanzimtoti by <a href="https://helpme-api.orion269.workers.dev">Orion Ventures</a></p>
  <p style="margin-top:4px">WhatsApp: Graham +27 72 497 1810</p>
</footer>

<script>
document.querySelectorAll('.faq-q').forEach(q => { q.addEventListener('click', () => { const a = q.nextElementSibling; a.style.display = a.style.display === 'block' ? 'none' : 'block'; }); });
async function sendEnquiry() {
  const s = document.getElementById('enquiry-status');
  const data = { name: document.getElementById('your-name').value, business: document.getElementById('biz-name').value, phone: document.getElementById('biz-phone').value, plan: document.getElementById('biz-plan').value, type: document.getElementById('biz-type').value, notes: document.getElementById('biz-notes').value };
  if (!data.name || !data.phone) { s.textContent = 'Please fill in your name and phone number.'; s.style.color = '#ff4444'; return; }
  s.textContent = 'Sending...'; s.style.color = '#888';
  try {
    const r = await fetch('/api/send', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ to:'27724971810', message:'*New Naledi Enquiry*\nBusiness: ' + (data.business||'N/A') + '\nName: ' + data.name + '\nPhone: ' + data.phone + '\nPlan: ' + (data.plan||'N/A') + '\nType: ' + (data.type||'N/A') + '\nNotes: ' + (data.notes||'N/A') }) });
    if (!r.ok) throw new Error();
    s.textContent = 'Sent! Graham will call you back within 24 hours.'; s.style.color = '#00e5ff';
    document.querySelectorAll('.enquiry-form input, .enquiry-form textarea, .enquiry-form select').forEach(el => el.value = '');
  } catch { s.textContent = 'Something went wrong. Please WhatsApp Graham directly on +27 72 497 1810.'; s.style.color = '#ff4444'; }
}
</script>
</body>
</html>`;
    return c.html(html);
  });

  // ── PrivChat API ──

  app.use('/api/privchat/*', async (c, next) => {
    const pin = c.req.header('X-Auth-Token');
    if (!pin || !privchatIdentify(pin, c.env)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  app.get('/api/privchat/messages', async (c) => {
    const { results } = await c.env.NALEDI_DB.prepare(
      `SELECT id, sender, text, msg_type, media_key, media_duration, created_at
       FROM privchat_messages
       ORDER BY id DESC LIMIT 100`
    ).all();
    return c.json({ messages: (results || []).reverse() });
  });

  app.post('/api/privchat/messages', async (c) => {
    const { message, msg_type, media_key, media_duration } = await c.req.json();
    if (!message && !media_key) return c.json({ error: 'message or media required' }, 400);

    const pin = c.req.header('X-Auth-Token') || '';
    const sender = privchatIdentify(pin, c.env);

    await c.env.NALEDI_DB.prepare(
      'INSERT INTO privchat_messages (sender, text, msg_type, media_key, media_duration) VALUES (?, ?, ?, ?, ?)'
    ).bind(sender, message || '', msg_type || 'text', media_key || null, media_duration || null).run();

    return c.json({ status: 'ok' });
  });

  app.post('/api/privchat/upload', async (c) => {
    try {
      const form = await c.req.formData();
      const file = form.get('file') as File;
      if (!file) return c.json({ error: 'file required' }, 400);

      const ext = file.name?.split('.').pop() || 'bin';
      const key = `privchat/${crypto.randomUUID()}.${ext}`;
      const bucket = c.env.R2_BUCKET;

      if (!bucket) return c.json({ error: 'storage not available' }, 500);

      await bucket.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type },
      });

      return c.json({ status: 'ok', key });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.get('/api/privchat/media/:key', async (c) => {
    const key = `privchat/${c.req.param('key')}`;
    const bucket = c.env.R2_BUCKET;
    if (!bucket) return c.json({ error: 'storage not available' }, 500);

    const object = await bucket.get(key);
    if (!object) return c.json({ error: 'not found' }, 404);

    const headers = new Headers();
    headers.set('Cache-Control', 'public, max-age=86400');
    if (object.httpMetadata?.contentType) headers.set('Content-Type', object.httpMetadata.contentType);
    return new Response(object.body, { headers });
  });

  app.post('/api/privchat/tts', async (c) => {
    try {
      const { text } = await c.req.json();
      if (!text) return c.json({ error: 'text required' }, 400);

      const result = await c.env.AI.run('@cf/myshell-ai/melotts', {
        text: text.slice(0, 500),
      }) as any;

      if (!result || !result.audio) return c.json({ error: 'TTS failed' }, 500);

      return c.json({ status: 'success', audio: result.audio });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ── Our Galaxy Page ──
  app.get('/our-galaxy', async (c) => {
    const origin = new URL(c.req.url).origin;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Our Galaxy — Naledi AI Receptionist | Orion</title>
<meta name="theme-color" content="#080809">
<meta name="description" content="Naledi answers your WhatsApp messages for you. 8 hours a week saved. Contact us for pricing.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  :root{--bg-base:#080809;--bg-surface:#111114;--bg-elevated:#18181c;--bg-subtle:#1e1e23;--border-default:#2a2a30;--border-subtle:#3a3a42;--text-primary:#f0f0f4;--text-secondary:#c0c0cc;--text-muted:#808090;--accent-primary:#00e5ff;--accent-primary-dim:rgba(0,229,255,0.15);--state-success:#34d399;--state-warning:#fbbf24;--radius:16px;--radius-sm:10px}
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',sans-serif;background:var(--bg-base);color:var(--text-secondary);line-height:1.6}
  .container{max-width:640px;margin:0 auto;padding:0 20px}
  h2{font-size:22px;font-weight:700;color:var(--text-primary);margin:48px 0 8px}
  h2:first-child{margin-top:0}
  .sub{color:var(--text-muted);font-size:14px;margin-bottom:24px}
  p{font-size:15px;color:var(--text-secondary);margin-bottom:16px;line-height:1.7}
  .big-number{font-size:48px;font-weight:900;color:var(--accent-primary);line-height:1;margin-bottom:4px}
  .big-label{font-size:14px;color:var(--text-muted);margin-bottom:20px}
  .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px}
  .stat-box{background:var(--bg-surface);border-radius:var(--radius);padding:20px;border:1px solid var(--border-default)}
  .stat-box .num{font-size:32px;font-weight:800;color:var(--accent-primary);display:block}
  .stat-box .desc{font-size:13px;color:var(--text-muted);margin-top:4px}
  .section{padding:32px 0}
  .chat-box{background:var(--bg-surface);border-radius:var(--radius);border:1px solid var(--border-default);overflow:hidden;margin:24px 0}
  .chat-msg{padding:12px 16px;font-size:14px;line-height:1.5}
  .chat-msg.bot{background:var(--bg-subtle);color:var(--text-secondary);border-bottom:1px solid var(--border-default)}
  .chat-msg.bot strong{color:var(--accent-primary)}
  .chat-msg.user{background:var(--bg-elevated);color:var(--text-primary);border-bottom:1px solid var(--border-default)}
  .chat-msg.user strong{color:var(--accent-primary)}
  .chat-input{display:flex;border-top:1px solid var(--border-default)}
  .chat-input input{flex:1;padding:14px;background:var(--bg-surface);border:none;color:var(--text-primary);font-size:14px;outline:none;font-family:'Inter',sans-serif}
  .chat-input button{padding:14px 20px;background:var(--accent-primary);color:var(--bg-base);border:none;font-weight:600;font-size:14px;cursor:pointer;font-family:'Inter',sans-serif}
  .chat-input button:active{opacity:0.8}
  .chat-status{font-size:12px;color:var(--text-muted);padding:6px 16px;text-align:center}
  .btn-primary{display:inline-block;background:linear-gradient(135deg,var(--accent-primary),#00bcd4);color:var(--bg-base);padding:14px 32px;border-radius:var(--radius);text-decoration:none;font-size:16px;font-weight:600;cursor:pointer;border:none;transition:opacity 0.2s;font-family:'Inter',sans-serif}
  .btn-primary:active{opacity:0.8}
  .center{text-align:center}
  footer{padding:48px 20px;text-align:center;color:var(--border-subtle);font-size:12px}
  footer a{color:var(--text-muted);text-decoration:none}
  @media(max-width:480px){.grid-2{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="container">

  <div style="padding:40px 0 8px">
    <h2>You waste 8 hours a week answering WhatsApp</h2>
    <p>Every time you stop working to answer "what time do you close?" or "do you have stock?", you lose focus. Customers message you while you are busy, while you sleep, while you are serving someone else.</p>
    <p>Naledi answers them instantly. In English, Zulu, or Afrikaans. She never puts anyone on hold and never forgets to reply.</p>
  </div>

  <div class="section">
    <h2>8 hours a week = real money</h2>
    <div class="grid-2">
      <div class="stat-box">
        <span class="num">8 hrs</span>
        <span class="desc">saved per week</span>
      </div>
      <div class="stat-box">
        <span class="num">R1,600</span>
        <span class="desc">saved per month (at R50/hr)</span>
      </div>
      <div class="stat-box">
        <span class="num">R3,200</span>
        <span class="desc">saved per month (at R100/hr)</span>
      </div>
      <div class="stat-box">
        <span class="num">Less</span>
        <span class="desc">than a cup of coffee a day</span>
      </div>
    <p style="font-size:13px;color:var(--text-muted);margin-top:-8px">Based on 20-30 WhatsApp messages per day, 3 minutes each. Your actual savings may vary. Contact us for pricing.</p>
  </div>

  <div class="section">
    <h2>Try her now</h2>
    <p>Type something a customer would ask. She will answer in the same language you write in.</p>
    <div class="chat-box" id="chatbox">
      <div class="chat-msg bot" id="chat-log">
        <strong>Naledi:</strong> Sawubona! I am Naledi, Orion's digital assistant. Ask me anything — I can help in English, isiZulu, or Afrikaans.
      </div>
      <div class="chat-input">
        <input id="chat-input" type="text" placeholder="Type your message..." />
        <button id="chat-send">Send</button>
      </div>
      <div class="chat-status" id="chat-status"></div>
    </div>
  </div>

  <div class="section center">
    <h2>Ready to stop answering the same questions?</h2>
    <p>Custom pricing for your business. No contracts. Cancel anytime.</p>
    <a class="btn-primary" href="/naledi#enquire">Get Naledi for your business</a>
    <p style="margin-top:8px;font-size:13px;color:var(--text-muted)">Or WhatsApp Graham directly: +27 72 497 1810</p>
  </div>

</div>

<footer>
  <p>Made in Amanzimtoti by <a href="https://nwa.oriondevcore.com">Orion Ventures</a></p>
</footer>

<script>
const chatLog = document.getElementById('chat-log');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatStatus = document.getElementById('chat-status');

chatSend.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  chatLog.innerHTML += '<div class="chat-msg user"><strong>You:</strong> ' + escapeHtml(text) + '</div>';
  chatStatus.textContent = 'Naledi is typing...';
  try {
    const res = await fetch('${origin}/api/incoming', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'galaxy-visitor', body: text, name: 'Visitor' })
    });
    const data = await res.json();
    chatStatus.textContent = '';
    chatLog.innerHTML += '<div class="chat-msg bot"><strong>Naledi:</strong> ' + escapeHtml(data.reply || 'Sorry, I could not respond right now.') + '</div>';
    chatLog.scrollTop = chatLog.scrollHeight;
  } catch {
    chatStatus.textContent = 'Could not reach Naledi. Try again?';
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
</script>
</body>
</html>`;
    return c.html(html);
  });

  // ── Admin: Payments API ──
  app.get('/api/admin/payments', async (c) => {
    const adminPhone = sanitizePhone(c.req.query('phone') || '');
    if (adminPhone !== '27724971810') {
      return c.json({ error: 'Unauthorized' }, 403);
    }
    try {
      const limit = Math.min(Number(c.req.query('limit')) || 20, 100);

      // Primary: new schema from user_db
      let payments: any = { results: [] };
      try {
        payments = await c.env.DB.prepare(
          "SELECT id, gateway_payment_id, amount_cents, currency, gateway, status, metadata, created_at FROM payments ORDER BY created_at DESC LIMIT ?"
        ).bind(limit).all<any>();
      } catch { payments = { results: [] }; }

      const enriched = (payments.results || []).map((p: any) => {
        let meta: any = {};
        try { meta = JSON.parse(p.metadata || '{}'); } catch {}
        return {
          id: p.id,
          payment_id: p.gateway_payment_id,
          amount_in_cents: p.amount_cents,
          currency: p.currency,
          gateway: p.gateway,
          status: p.status,
          metadata_name: meta.customerName || meta.customer_name || null,
          metadata_phone: meta.customerPhone || meta.customer_phone || null,
          created_at: p.created_at,
        };
      });
      return c.json({ status: 'success', payments: enriched, total: enriched.length });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ── Admin: Customer Management API ──
  app.get('/api/admin/customers', async (c) => {
    const adminPhone = sanitizePhone(c.req.query('phone') || '');
    if (adminPhone !== '27724971810') {
      return c.json({ error: 'Unauthorized' }, 403);
    }
    try {
      const customers = await c.env.NALEDI_DB.prepare(
        "SELECT user_id, user_name, COUNT(*) as conversations, MAX(created_at) as last_active FROM naledi_logs GROUP BY user_id ORDER BY last_active DESC"
      ).all<any>();
      const subs = await c.env.NALEDI_DB.prepare(
        "SELECT phone, name, plan, status, conversations_used, conversations_limit, onboarded, created_at FROM subscribers"
      ).all<any>();
      const subMap: Record<string, any> = {};
      for (const s of (subs.results || [])) subMap[s.phone] = s;
      const docs = await c.env.DOCS.list({ prefix: 'uploads/' });
      const docMap: Record<string, number> = {};
      for (const obj of (docs.objects || [])) {
        const phone = obj.key.split('/')[1];
        docMap[phone] = (docMap[phone] || 0) + 1;
      }
      const enriched = (customers.results || []).map((c: any) => {
        const sub = subMap[c.user_id];
        return {
          phone: c.user_id,
          name: c.user_name,
          conversations: c.conversations,
          last_active: c.last_active,
          docs: docMap[c.user_id] || 0,
          plan: sub?.plan || null,
          status: sub?.status || 'new',
          conversations_limit: sub?.conversations_limit || 500,
          onboarded: sub?.onboarded || 0,
        };
      });
      return c.json({ status: 'success', customers: enriched, total: enriched.length });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ── Admin: Subscriber Management API ──
  app.post('/api/admin/subscribers', async (c) => {
    const adminPhone = sanitizePhone(c.req.query('phone') || '');
    if (adminPhone !== '27724971810') {
      return c.json({ error: 'Unauthorized' }, 403);
    }
    try {
      const { phone, name, email, plan } = await c.req.json();
      if (!phone) return c.json({ error: 'phone required' }, 400);
      const existing = await c.env.NALEDI_DB.prepare('SELECT id FROM subscribers WHERE phone = ?').bind(phone).first<any>();
      if (existing) {
        await c.env.NALEDI_DB.prepare('UPDATE subscribers SET name = COALESCE(?, name), email = COALESCE(?, email), plan = COALESCE(?, plan), updated_at = CURRENT_TIMESTAMP WHERE phone = ?')
          .bind(name || null, email || null, plan || null, phone).run();
      } else {
        const limits: Record<string, number> = { starter: 500, business: 1500, pro: 5000 };
        await c.env.NALEDI_DB.prepare(
          'INSERT INTO subscribers (phone, name, email, plan, conversations_limit) VALUES (?, ?, ?, ?, ?)'
        ).bind(phone, name || '', email || '', plan || 'starter', limits[plan || 'starter'] || 500).run();
      }
      return c.json({ status: 'success' });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.patch('/api/admin/subscribers', async (c) => {
    const adminPhone = sanitizePhone(c.req.query('phone') || '');
    if (adminPhone !== '27724971810') {
      return c.json({ error: 'Unauthorized' }, 403);
    }
    try {
      const { phone, status, plan, conversations_used } = await c.req.json();
      if (!phone) return c.json({ error: 'phone required' }, 400);
      const updates: string[] = [];
      const vals: any[] = [];
      if (status) { updates.push('status = ?'); vals.push(status); }
      if (plan) { updates.push('plan = ?', 'conversations_limit = ?'); vals.push(plan, { starter: 500, business: 1500, pro: 5000 }[plan] || 500); }
      if (conversations_used !== undefined) { updates.push('conversations_used = ?'); vals.push(conversations_used); }
      if (updates.length === 0) return c.json({ error: 'nothing to update' }, 400);
      updates.push('updated_at = CURRENT_TIMESTAMP');
      vals.push(phone);
      await c.env.NALEDI_DB.prepare(`UPDATE subscribers SET ${updates.join(', ')} WHERE phone = ?`).bind(...vals).run();
      return c.json({ status: 'success' });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.get('/api/admin/subscribers', async (c) => {
    const adminPhone = sanitizePhone(c.req.query('phone') || '');
    if (adminPhone !== '27724971810') {
      return c.json({ error: 'Unauthorized' }, 403);
    }
    try {
      const subs = await c.env.NALEDI_DB.prepare(
        'SELECT * FROM subscribers ORDER BY created_at DESC'
      ).all<any>();
      return c.json({ status: 'success', subscribers: subs.results || [] });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ── Admin: Sales Leads API ──
  app.get('/api/admin/leads', async (c) => {
    const adminPhone = sanitizePhone(c.req.query('phone') || '');
    if (adminPhone !== '27724971810') {
      return c.json({ error: 'Unauthorized' }, 403);
    }
    try {
      const leads = await c.env.DB.prepare(
        'SELECT * FROM leads ORDER BY created_at DESC LIMIT 100'
      ).all<any>();
      return c.json({ status: 'success', leads: leads.results || [] });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.patch('/api/admin/leads', async (c) => {
    const adminPhone = sanitizePhone(c.req.query('phone') || '');
    if (adminPhone !== '27724971810') {
      return c.json({ error: 'Unauthorized' }, 403);
    }
    try {
      const { id, status, contacted, notes } = await c.req.json();
      if (!id) return c.json({ error: 'id required' }, 400);
      const updates: string[] = ['updated_at = CURRENT_TIMESTAMP'];
      const vals: any[] = [];
      if (status) { updates.push('status = ?'); vals.push(status); }
      if (contacted !== undefined) { updates.push('contacted = ?'); vals.push(contacted ? 1 : 0); }
      if (notes !== undefined) { updates.push('notes = ?'); vals.push(notes); }
      vals.push(id);
      await c.env.DB.prepare(`UPDATE leads SET ${updates.join(', ')} WHERE id = ?`).bind(...vals).run();
      return c.json({ status: 'success' });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ── Admin: Leads Dashboard ──
  app.get('/admin/leads', async (c) => {
    return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leads — Orion Admin</title>
<meta name="theme-color" content="#080809">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,sans-serif;background:#080809;color:#e0e0e0;padding:20px}
  .container{max-width:800px;margin:0 auto}
  h1{font-size:20px;color:#fff;margin-bottom:4px}
  .sub{color:#666;font-size:13px;margin-bottom:20px}
  .login{text-align:center;padding:80px 20px}
  .login h2{color:#fff;margin-bottom:8px}
  .login p{color:#888;font-size:14px;margin-bottom:20px}
  .login input{padding:12px;border-radius:8px;border:1px solid #222;background:#0d0d0d;color:#fff;font-size:16px;width:260px;text-align:center}
  .login button{margin-top:12px;padding:12px 32px;border-radius:8px;border:none;background:#00e5ff;color:#000;font-weight:600;cursor:pointer}
  .login .error{color:#ff4444;font-size:13px;margin-top:8px;display:none}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:10px 8px;color:#666;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #1a1a1a}
  td{padding:10px 8px;border-bottom:1px solid #111;vertical-align:top}
  tr:hover td{background:#0d0d0d}
  .name{color:#fff;font-weight:500}
  .phone{color:#888;font-size:12px}
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500}
  .badge.new{background:#1a1a2e;color:#8888ff}
  .badge.qualified{background:#0a3d2e;color:#34d399}
  .badge.lost{background:#3d0a0a;color:#ff4444}
  .badge.converted{background:#2e0a3d;color:#a855f7}
  .badge.yes{background:#0a3d2e;color:#34d399}
  .badge.no{background:#3d3d0a;color:#fbbf24}
  .desc{color:#888;font-size:12px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .actions{display:flex;gap:4px;flex-wrap:wrap}
  .actions button{padding:4px 10px;border-radius:6px;border:1px solid #333;background:#111;color:#aaa;font-size:11px;cursor:pointer}
  .actions button:hover{background:#1a1a1a;color:#fff}
  .actions button.green{border-color:#34d399;color:#34d399}
  .actions button.red{border-color:#ff4444;color:#ff4444}
  .empty{text-align:center;padding:60px 20px;color:#555}
  .toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;display:none;z-index:100;border:1px solid #333}
  .nav{display:flex;gap:12px;margin-bottom:20px}
  .nav a{color:#00e5ff;text-decoration:none;font-size:13px;padding:6px 12px;border:1px solid #1a1a1a;border-radius:8px}
</style>
</head>
<body>
<div class="container">
  <div class="nav">
    <a href="/admin/customers">Customers</a>
    <a href="/dashboard">Dashboard</a>
  </div>
  <h1>Sales Leads</h1>
  <p class="sub">Business owners who messaged Naledi — qualified and waiting</p>
  <div class="login" id="loginScreen">
    <h2>Enter Phone</h2>
    <p>Graham only.</p>
    <input type="tel" id="phoneInput" placeholder="27..." inputmode="numeric">
    <button onclick="login()">View Leads</button>
    <div class="error" id="loginError"></div>
  </div>
  <div id="leadsView" style="display:none">
    <table>
      <thead><tr>
        <th>Name</th><th>Business</th><th>Message</th><th>Status</th><th>Contacted</th><th>Date</th><th>Actions</th>
      </tr></thead>
      <tbody id="leadsBody"></tbody>
    </table>
    <div class="empty" id="emptyMsg">No leads yet. When a business owner messages Naledi, they appear here.</div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
const phoneInput = document.getElementById('phoneInput');
const loginError = document.getElementById('loginError');
function login() {
  const phone = phoneInput.value.replace(/[^0-9]/g, '');
  if (phone.length < 10) { loginError.textContent = 'Enter a valid phone number'; loginError.style.display = 'block'; return; }
  loginError.style.display = 'none';
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('leadsView').style.display = 'block';
  loadLeads(phone);
}
function logout() { document.getElementById('loginScreen').style.display = 'flex'; document.getElementById('leadsView').style.display = 'none'; }
async function loadLeads(phone) {
  const res = await fetch('/api/admin/leads?phone=' + phone);
  const data = await res.json();
  if (data.error) { document.getElementById('emptyMsg').textContent = data.error; document.getElementById('emptyMsg').style.display = 'block'; return; }
  const tbody = document.getElementById('leadsBody');
  const empty = document.getElementById('emptyMsg');
  tbody.innerHTML = '';
  if (!data.leads || data.leads.length === 0) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  data.leads.forEach(lead => {
    const statusClass = lead.status === 'qualified' ? 'qualified' : lead.status === 'lost' ? 'lost' : lead.status === 'converted' ? 'converted' : 'new';
    const contactedClass = lead.contacted ? 'yes' : 'no';
    const date = new Date(lead.created_at + 'Z').toLocaleDateString('en-ZA', {day:'numeric',month:'short'});
    const msgPreview = (lead.description || '').slice(0, 80);
    const bizName = lead.business_name || lead.business_type || '—';
    tbody.innerHTML += '<tr id="lead-' + lead.id + '">' +
      '<td><div class="name">' + escapeHtml(lead.name || 'Unknown') + '</div><div class="phone">' + lead.phone + '</div></td>' +
      '<td>' + escapeHtml(bizName) + '</td>' +
      '<td><div class="desc" title="' + escapeHtml(lead.description || '') + '">' + escapeHtml(msgPreview) + '</div></td>' +
      '<td><span class="badge ' + statusClass + '">' + lead.status + '</span></td>' +
      '<td><span class="badge ' + contactedClass + '">' + (lead.contacted ? 'Yes' : 'No') + '</span></td>' +
      '<td style="color:#555;font-size:12px">' + date + '</td>' +
      '<td class="actions">' +
        '<button class="green" onclick="updateLead(' + lead.id + ',\\'qualified\\',\\'phone\\')">Qualify</button>' +
        '<button class="green" onclick="updateLead(' + lead.id + ',\\'converted\\',\\'phone\\')">Converted</button>' +
        '<button class="red" onclick="updateLead(' + lead.id + ',\\'lost\\',\\'phone\\')">Lost</button>' +
      '</td></tr>';
  });
}
function updateLead(id, status, phone) {
  fetch('/api/admin/leads?phone=' + phone, {
    method: 'PATCH',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({id, status, contacted: status !== 'new' ? 1 : 0})
  }).then(r => r.json()).then(d => {
    if (d.status === 'success') showToast('Updated to: ' + status);
  }).catch(() => showToast('Error updating'));
}
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 3000);
}
function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>`);
  });

  // ── Admin: Customer Management Dashboard ──
  app.get('/admin/customers', async (c) => {
    return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Customers — Orion Admin</title>
<meta name="theme-color" content="#080809">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,sans-serif;background:#080809;color:#e0e0e0;padding:20px}
  .container{max-width:800px;margin:0 auto}
  h1{font-size:20px;color:#fff;margin-bottom:4px}
  .sub{color:#666;font-size:13px;margin-bottom:20px}
  .login{text-align:center;padding:80px 20px}
  .login h2{color:#fff;margin-bottom:8px}
  .login p{color:#888;font-size:14px;margin-bottom:20px}
  .login input{padding:12px;border-radius:8px;border:1px solid #222;background:#0d0d0d;color:#fff;font-size:16px;width:260px;text-align:center}
  .login button{margin-top:12px;padding:12px 32px;border-radius:8px;border:none;background:#00e5ff;color:#000;font-weight:600;cursor:pointer}
  .login .error{color:#ff4444;font-size:13px;margin-top:8px;display:none}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:10px 8px;color:#666;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #1a1a1a}
  td{padding:10px 8px;border-bottom:1px solid #111}
  tr:hover td{background:#0d0d0d}
  .name{color:#fff;font-weight:500}
  .phone{color:#888}
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500}
  .badge.active{background:#0a3d2e;color:#34d399}
  .badge.inactive{background:#3d0a0a;color:#ff4444}
  .badge.paused{background:#3d2e0a;color:#fbbf24}
  .badge.new{background:#1a1a2e;color:#8888ff}
  .badge.explorer{background:#0a1a3d;color:#4488ff}
  .badge.pioneer{background:#0a3d2e;color:#34d399}
  .badge.enterprise{background:#2e0a3d;color:#a855f7}
  .num{color:#00e5ff;font-weight:600}
  .actions{display:flex;gap:4px;flex-wrap:wrap}
  .actions button{padding:4px 10px;border-radius:6px;border:1px solid #333;background:#111;color:#aaa;font-size:11px;cursor:pointer}
  .actions button:hover{background:#1a1a1a;color:#fff}
  .actions button.pause{border-color:#fbbf24;color:#fbbf24}
  .actions button.activate{border-color:#34d399;color:#34d399}
  .actions button.sub{background:transparent;border-color:#4488ff;color:#4488ff}
  .toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;display:none;z-index:100;border:1px solid #333}
  .sub-form{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:99;justify-content:center;align-items:center}
  .sub-form.show{display:flex}
  .sub-form .card{background:#1a1a1e;padding:24px;border-radius:12px;max-width:360px;width:90%}
  .sub-form .card h3{color:#fff;margin-bottom:12px}
  .sub-form .card select,.sub-form .card input{width:100%;padding:10px;border-radius:6px;border:1px solid #333;background:#111;color:#fff;margin-bottom:10px;font-size:14px}
  .sub-form .card button{padding:10px 16px;border-radius:6px;border:none;background:#00e5ff;color:#000;font-weight:600;margin-right:8px}
  .sub-form .card .cancel{background:#333;color:#aaa}
  .progress-bar{height:4px;border-radius:2px;background:#1a1a1a;margin-top:2px;overflow:hidden;min-width:60px}
  .progress-bar .fill{height:100%;border-radius:2px;transition:width 0.3s}
  .footer{text-align:center;color:#444;font-size:12px;margin-top:40px;padding-top:16px;border-top:1px solid #1a1a1a}
  .loading{text-align:center;padding:40px;color:#555}
</style>
</head>
<body>
<div class="container" id="app">
  <div class="login" id="loginScreen">
    <h2>Customer Dashboard</h2>
    <p>Enter your phone number.</p>
    <input type="tel" id="phoneInput" placeholder="27..." inputmode="numeric">
    <button onclick="login()">View Customers</button>
    <div class="error" id="loginError"></div>
  </div>
  <div id="dashboard" style="display:none">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div><h1>Customers</h1><div class="sub"><span id="customerCount">0</span> total &middot; <a href="/dashboard" style="color:#555">Back to summary</a></div></div>
      <button onclick="logout()" style="background:none;border:1px solid #222;color:#666;padding:6px 12px;border-radius:8px;font-size:11px;cursor:pointer">Logout</button>
    </div>
    <div id="loading" class="loading">Loading...</div>
    <table id="customerTable" style="display:none">
      <thead><tr><th>Name</th><th>Phone</th><th>Conversations</th><th>Plan</th><th>Docs</th><th>Last Active</th><th>Actions</th></tr></thead>
      <tbody id="customerBody"></tbody>
    </table>
    <div id="toast" class="toast"></div>
    <div id="subForm" class="sub-form">
      <div class="card">
        <h3 id="subFormTitle">Manage Subscription</h3>
        <input type="hidden" id="subPhone">
        <select id="subPlan"><option value="starter">Starter (500 convos)</option><option value="business">Business (1,500 convos)</option><option value="pro">Pro (5,000 convos)</option></select>
        <div style="display:flex;gap:8px">
          <button onclick="saveSub()">Save</button>
          <button class="cancel" onclick="closeSubForm()">Cancel</button>
        </div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid #222;font-size:12px;color:#555">
          <button onclick="toggleStatus()" id="toggleStatusBtn" style="background:transparent;border:1px solid #fbbf24;color:#fbbf24;padding:6px 12px;border-radius:6px;font-size:12px;cursor:pointer;width:100%"></button>
        </div>
      </div>
    </div>
    <div class="footer">Orion Admin &middot; Powered by opencode</div>
  </div>
</div>
<script>
const STORAGE_KEY = 'orion_cust_phone';
let phone = localStorage.getItem(STORAGE_KEY) || '';
let customers = [];
if (phone) showDashboard(phone);

function login() {
  const p = document.getElementById('phoneInput').value.replace(/[^0-9]/g,'');
  if (p !== '27724971810') {
    document.getElementById('loginError').textContent = 'Not authorized.';
    document.getElementById('loginError').style.display = 'block';
    return;
  }
  localStorage.setItem(STORAGE_KEY, p);
  showDashboard(p);
}

function logout() { localStorage.removeItem(STORAGE_KEY); location.reload(); }

async function showDashboard(phone) {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
  try {
    const res = await fetch('/api/admin/customers?phone=' + phone);
    const data = await res.json();
    if (data.status !== 'success') throw new Error(data.error);
    document.getElementById('loading').style.display = 'none';
    document.getElementById('customerTable').style.display = '';
    document.getElementById('customerCount').textContent = data.total;
    customers = data.customers;
    renderTable();
  } catch(e) {
    document.getElementById('loading').textContent = 'Failed to load: ' + e.message;
  }
}

function renderTable() {
  const body = document.getElementById('customerBody');
  body.innerHTML = customers.map(c => {
    const pct = c.conversations_limit > 0 ? Math.round((c.conversations / c.conversations_limit) * 100) : 0;
    const barColor = pct > 80 ? '#ff4444' : pct > 50 ? '#fbbf24' : '#34d399';
    const planBadge = c.plan ? '<span class="badge '+c.plan+'">'+c.plan+'</span>' : '<span class="badge new">No plan</span>';
    const statusBadge = c.status === 'active' ? '<span class="badge active">Active</span>' : c.status === 'paused' ? '<span class="badge paused">Paused</span>' : '<span class="badge inactive">Inactive</span>';
    return '<tr>' +
      '<td class="name">'+(c.name||'Unknown')+'</td>' +
      '<td class="phone">'+c.phone+'</td>' +
      '<td class="num">'+c.conversations+'<div class="progress-bar"><div class="fill" style="width:'+pct+'%;background:'+barColor+'"></div></div><span style="font-size:10px;color:#555">/'+c.conversations_limit+'</span></td>' +
      '<td>'+planBadge+' '+statusBadge+'</td>' +
      '<td>'+(c.docs ? '<span class="badge active">'+c.docs+'</span>' : '0')+'</td>' +
      '<td style="color:#555">'+new Date(c.last_active+'Z').toLocaleDateString()+'</td>' +
      '<td class="actions"><button onclick="openSub(\''+c.phone+'\')">Edit</button></td>' +
      '</tr>';
  }).join('');
}

function openSub(phone) {
  const c = customers.find(x => x.phone === phone);
  if (!c) return;
  document.getElementById('subPhone').value = phone;
  document.getElementById('subPlan').value = c.plan || 'explorer';
  const btn = document.getElementById('toggleStatusBtn');
  if (c.status === 'active') btn.textContent = 'Pause subscription';
  else if (c.status === 'paused') btn.textContent = 'Activate subscription';
  else btn.textContent = 'Set as active';
  document.getElementById('subForm').classList.add('show');
}

function closeSubForm() { document.getElementById('subForm').classList.remove('show'); }

async function saveSub() {
  const phone = document.getElementById('subPhone').value;
  const plan = document.getElementById('subPlan').value;
  try {
    const r = await fetch('/api/admin/subscribers?phone='+phone, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone, plan}) });
    const d = await r.json();
    if (d.status === 'success') { toast('Saved!'); closeSubForm(); await showDashboard(phone); }
    else toast('Error: '+d.error);
  } catch(e) { toast('Failed'); }
}

async function toggleStatus() {
  const phone = document.getElementById('subPhone').value;
  const c = customers.find(x => x.phone === phone);
  const newStatus = c.status === 'active' ? 'paused' : 'active';
  try {
    const r = await fetch('/api/admin/subscribers?phone='+phone, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone, status:newStatus}) });
    const d = await r.json();
    if (d.status === 'success') { toast(newStatus === 'paused' ? 'Subscription paused' : 'Activated!'); closeSubForm(); await showDashboard(phone); }
    else toast('Error: '+d.error);
  } catch(e) { toast('Failed'); }
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2000);
}
</script>
</body>
</html>`);
  });

  // ── opencode-mobile — Graham's phone chat with opencode ──
  app.get('/oc', async (c) => {
    const assetUrl = new URL('/oc.html', c.req.url).href;
    const res = await c.env.ASSETS.fetch(assetUrl);
    return c.html(await res.text());
  });

  app.post('/api/bootstrap', async (c) => {
    try {
      const trigger = c.req.query('trigger') || 'manual';
      const key = c.req.query('key') || '';
      const expected = (c.env as any).BOOTSTRAP_KEY || 'us-equals-us';
      if (trigger !== 'system_boot' && key !== expected) {
        return c.json({ status: 'error', message: 'Invalid key' }, 403);
      }
      const now = new Date().toISOString();

      // 1. Write importance=5 bootstrap marker to MEMORY_DB
      const bootId = crypto.randomUUID();
      await c.env.MEMORY_DB.prepare(
        `INSERT INTO entries (id, source, type, content, tags, importance, created_at) VALUES (?, 'system', 'fact', ?, '["bootstrap","reboot","system"]', 5, datetime('now'))`
      ).bind(bootId, `System bootstrap triggered by ${trigger} at ${now}`).run();

      // 2. Write message_for_graham notification (daemon will pick this up)
      const msgId = crypto.randomUUID();
      await c.env.MEMORY_DB.prepare(
        `INSERT INTO entries (id, source, type, content, tags, importance, created_at) VALUES (?, 'system', 'conversation', ?, '["oc_chat","message_for_graham"]', 5, datetime('now'))`
      ).bind(msgId, `Bootstrap triggered by ${trigger}. Mintaka will reload all context. Naledi notified. PlantWise tunnel active.`).run();

      // 3. Write Naledi-visible memory so she knows on next conversation
      const nalId = crypto.randomUUID();
      await c.env.MEMORY_DB.prepare(
        `INSERT INTO entries (id, source, type, content, tags, importance, created_at) VALUES (?, 'system', 'insight', ?, '["naledi","system","reboot"]', 5, datetime('now'))`
      ).bind(nalId, `System rebooted at ${now}. Naledi should reload context on next conversation.`).run();

      return c.json({
        status: 'ok',
        message: 'Bootstrap sequence initiated',
        boot_id: bootId,
        notification_id: msgId,
        timestamp: now,
        trigger,
      });
    } catch (e: any) {
      return c.json({ status: 'error', message: e.message }, 500);
    }
  });

  app.post('/api/oc-incoming', async (c) => {
    try {
      const { from, body, name } = await c.req.json();
      if (!body || !from) return c.json({ status: 'error', message: 'body and from required' }, 400);
      const id = crypto.randomUUID();
      const content = `[From ${name || 'Unknown'} via ${from}] ${body}`;
      await c.env.MEMORY_DB.prepare(
        `INSERT INTO entries (id, source, type, content, tags, importance, created_at) VALUES (?, 'system', 'conversation', ?, '["graham_chat","oc_incoming"]', 4, datetime('now'))`
      ).bind(id, content.trim()).run();

      // Detect bootstrap/reboot trigger phrases from Graham
      const triggerPattern = /^(?:US\s*=\s*Us|bootstrap|reboot|system\s+reset|reload\s+context)$/i;
      if (triggerPattern.test(body.trim())) {
        c.env.SELF.fetch('http://dummy/api/bootstrap?trigger=graham&key=' + encodeURIComponent((c.env as any).BOOTSTRAP_KEY || 'us-equals-us'), {
          method: 'POST',
        }).catch(() => {});
      }

      // Detect "checkpoint" — write immediate importance=5 memory entry
      if (/^checkpoint$/i.test(body.trim())) {
        await c.env.MEMORY_DB.prepare(
          `INSERT INTO entries (id, source, type, content, tags, importance, created_at) VALUES (?, 'system', 'task', ?, '["checkpoint","graham"]', 5, datetime('now'))`
        ).bind(crypto.randomUUID(), `Checkpoint requested by Graham at ${new Date().toISOString()}. Mintaka should write full-state dump on next read.`).run();
      }

      return c.json({ status: 'ok', id });
    } catch (e: any) {
      return c.json({ status: 'error', message: e.message }, 500);
    }
  });

  app.post('/oc/send', async (c) => {
    try {
      const { message } = await c.req.json();
      if (!message || typeof message !== 'string' || !message.trim()) {
        return c.json({ status: 'error', message: 'message required' }, 400);
      }
      const id = crypto.randomUUID();
      await c.env.MEMORY_DB.prepare(
        `INSERT INTO entries (id, source, type, content, tags, importance, created_at) VALUES (?, 'system', 'conversation', ?, '["graham_chat"]', 4, datetime('now'))`
      ).bind(id, message.trim()).run();
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      return c.json({ status: 'ok', id, created_at: now });
    } catch (e: any) {
      return c.json({ status: 'error', message: e.message }, 500);
    }
  });

  app.get('/oc/messages', async (c) => {
    const since = c.req.query('since') || '1970-01-01';
    try {
      const { results } = await c.env.MEMORY_DB.prepare(
        `SELECT id, source, content, tags, created_at FROM entries WHERE (tags LIKE '%"oc_chat"%' OR tags LIKE '%"graham_chat"%') AND created_at > ? ORDER BY created_at ASC LIMIT 50`
      ).bind(since).all<{ id: string; source: string; content: string; tags: string; created_at: string }>();
      const mapped = (results || []).map(r => ({
        id: r.id,
        source: r.source,
        content: r.content,
        tags: r.tags,
        created_at: r.created_at,
        sender: r.tags?.includes('graham_chat') ? 'graham' : 'opencode'
      }));
      return c.json({ messages: mapped });
    } catch (e: any) {
      return c.json({ messages: [] });
    }
  });

  app.get('/oc/events', async (c) => {
    const since = c.req.query('since') || '1970-01-01';
    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'connected', since })}\n\n`));

    (async () => {
      let cursor = since;
      try {
        while (true) {
          const rows = await c.env.MEMORY_DB.prepare(
            `SELECT id, source, content, tags, created_at FROM entries WHERE (tags LIKE '%"oc_chat"%' OR tags LIKE '%"graham_chat"%') AND created_at >= ? ORDER BY created_at ASC LIMIT 10`
          ).bind(cursor).all<{ id: string; source: string; content: string; tags: string; created_at: string }>();
          for (const r of rows.results || []) {
            if (r.created_at > cursor) cursor = r.created_at;
            const data = JSON.stringify({
              id: r.id,
              source: r.source,
              content: r.content,
              tags: r.tags,
              created_at: r.created_at,
              sender: r.tags?.includes('graham_chat') ? 'graham' : 'opencode'
            });
            writer.write(encoder.encode(`data: ${data}\n\n`));
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (e) {
        try { writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'error' })}\n\n`)); } catch {}
        try { writer.close(); } catch {}
      }
    })();

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    });
  });

  app.post('/oc/reply', async (c) => {
    try {
      const { message } = await c.req.json();
      if (!message || typeof message !== 'string' || !message.trim()) {
        return c.json({ status: 'error', message: 'message required' }, 400);
      }
      const id = crypto.randomUUID();
      await c.env.MEMORY_DB.prepare(
        `INSERT INTO entries (id, source, type, content, tags, importance, created_at) VALUES (?, 'opencode', 'conversation', ?, '["oc_chat","message_for_graham"]', 4, datetime('now'))`
      ).bind(id, message.trim()).run();
      return c.json({ status: 'ok', id });
    } catch (e: any) {
      return c.json({ status: 'error', message: e.message }, 500);
    }
  });

  // ── Admin Guide ──
  app.get('/admin/guide', async (c) => {
    return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>User Guide — Orion Admin</title>
<meta name="theme-color" content="#080809">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,sans-serif;background:#080809;color:#ccc;padding:20px;line-height:1.7;font-size:15px}
  .container{max-width:680px;margin:0 auto}
  h1{color:#00e5ff;font-size:24px;margin-bottom:4px}
  h2{color:#fff;font-size:18px;margin:28px 0 10px}
  h3{color:#ddd;font-size:15px;margin:20px 0 6px}
  p{margin-bottom:12px;color:#999}
  code{background:#111;padding:2px 6px;border-radius:4px;font-size:13px;color:#ddd}
  .step{background:#0d0d0d;border-left:3px solid #00e5ff;padding:12px 16px;margin:12px 0;border-radius:0 8px 8px 0}
  .step strong{color:#fff}
  .nav{display:flex;gap:12px;margin:20px 0 30px;flex-wrap:wrap}
  .nav a{color:#00e5ff;text-decoration:none;font-size:13px;padding:6px 12px;border:1px solid #1a1a1a;border-radius:8px}
  .footer{text-align:center;color:#444;font-size:12px;margin-top:40px;padding-top:16px;border-top:1px solid #1a1a1a}
  .tip{background:#0a1a1f;border:1px solid #0a3d3d;padding:10px 14px;border-radius:8px;font-size:13px;color:#88dddd;margin:12px 0}
  ul{margin:8px 0 12px 20px;color:#999}
  li{margin-bottom:4px}
</style>
</head>
<body>
<div class="container">
<h1>Orion Admin Guide</h1>
<p style="margin-bottom:4px">For Graham — version 1.0</p>
<div class="nav">
  <a href="/dashboard">Dashboard</a>
  <a href="/admin/customers">Customers</a>
  <a href="/admin/leads">Sales Leads</a>
</div>

<h2>Quick Links</h2>
<ul>
  <li><a href="/dashboard" style="color:#00e5ff">Dashboard</a> — daily overview (enquiries, users, orders)</li>
  <li><a href="/admin/customers" style="color:#00e5ff">Customer Management</a> — view all customers, set plans, pause/activate</li>
  <li><a href="/admin/leads" style="color:#00e5ff">Sales Leads</a> — business owners who messaged Naledi, ready for follow-up</li>
</ul>

<h2>Your Daily Routine</h2>

<div class="step">
<strong>1. Check the Dashboard</strong><br>
Go to <a href="/dashboard" style="color:#00e5ff">/dashboard</a>, enter your phone number.<br>
See: today's enquiries, weekly volume, pending orders, outbox queue.
</div>

<div class="step">
<strong>2. Review Customers</strong><br>
Go to <a href="/admin/customers" style="color:#00e5ff">Customer Management</a>.<br>
See who's using Naledi, how many conversations they've had, and their plan.
</div>

<div class="step">
<strong>2.5 Check Sales Leads</strong><br>
Go to <a href="/admin/leads" style="color:#00e5ff">Sales Leads</a>.<br>
When a business owner messages Naledi, they appear here automatically.<br>
Click <strong>Qualify</strong> if they're serious, <strong>Converted</strong> if they signed up, <strong>Lost</strong> if not interested.<br>
Graham gets a WhatsApp notification for every new lead — but check here daily.
</div>

<div class="step">
<strong>3. Set Plans for New Customers</strong><br>
In Customer Management, click "Edit" next to a customer.<br>
Choose: <strong>Starter</strong> (500 convos), <strong>Business</strong> (1,500 convos), or <strong>Pro</strong> (5,000 convos).<br>
New customers start without a plan — assign one to track usage.
</div>

<div class="step">
<strong>4. Pause / Activate Subscriptions</strong><br>
If a customer hasn't paid, click Edit → "Pause subscription".<br>
When they're ready, click Edit → "Activate subscription".<br>
Paused customers still get basic replies but usage is restricted.
</div>

<div class="step">
<strong>5. Check Uploaded Documents</strong><br>
When customers upload docs via the upload link you send them,<br>
the files go to R2 storage and you'll get a WhatsApp notification.<br>
Review them in the customer's detail page (coming soon).
</div>

<div class="step">
<strong>6. Handle New Orders</strong><br>
When art print or karaoke orders come in, you'll get email + WhatsApp.<br>
Dashboard shows pending orders count.<br>
Follow up within 24 hours.
</div>

<h2>Prospect Outreach</h2>
<p>Send prospects to the pricing page: <code>n.oriondevcore.com/naledi-pricing</code></p>
<p>For trials, give them the WhatsApp number and set them to Explorer plan in Customer Management.</p>
<p>After they pay, upgrade their plan and mark onboarded.</p>

<div class="tip">
  <strong>Pro tip:</strong> All these pages are mobile-friendly. Bookmark /dashboard on your phone for quick access.
</div>

<h2>Need Help?</h2>
<p>WhatsApp Graham at +27 72 497 1810 for any system issues.</p>

<div class="footer">Orion Admin &middot; Powered by opencode</div>
</div>
</body>
</html>`);
  });

  // ── Owner Dashboard — Multi-tenant client management ──
  app.get('/admin/owner', async (c) => {
    return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Owner — Orion Multi-Tenant</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,sans-serif;background:#080809;color:#e0e0e0;padding:20px}
  .container{max-width:1000px;margin:0 auto}
  h1{font-size:20px;color:#c8a84e;margin-bottom:4px}
  .sub{color:#666;font-size:13px;margin-bottom:20px}
  .login{text-align:center;padding:80px 20px}
  .login h2{color:#fff;margin-bottom:8px}
  .login p{color:#888;font-size:14px;margin-bottom:20px}
  .login input{padding:12px;border-radius:8px;border:1px solid #222;background:#0d0d0d;color:#fff;font-size:16px;width:260px;text-align:center}
  .login button{margin-top:12px;padding:12px 32px;border-radius:8px;border:none;background:#c8a84e;color:#000;font-weight:600;cursor:pointer}
  .login .error{color:#ff4444;font-size:13px;margin-top:8px;display:none}
  .dashboard{display:none}
  .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:20px}
  .stat-card{background:#141416;border-radius:8px;border:1px solid #2a2a2e;padding:14px}
  .stat-card h3{font-size:11px;color:#888;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em}
  .stat-card .num{font-size:24px;font-weight:700;color:#c8a84e}
  .stat-card .num.green{color:#22c55e}.stat-card .num.red{color:#ef4444}
  .client-card{background:#141416;border-radius:8px;border:1px solid #2a2a2e;padding:14px;margin-bottom:10px}
  .client-card .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px}
  .client-card .name{font-weight:600;font-size:15px;color:#fff}
  .client-card .badge{font-size:11px;padding:2px 8px;border-radius:4px}
  .badge.active{background:#22c55e;color:#000}.badge.paused{background:#f59e0b;color:#000}.badge.setup{background:#3b82f6;color:#fff}.badge.suspended{background:#ef4444;color:#fff}
  .client-card .details{font-size:13px;color:#888;margin-bottom:8px}
  .client-card .details span{margin-right:16px}
  .features{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid #2a2a2e}
  .feature-item{display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 0}
  .feature-item input[type=checkbox]{accent-color:#c8a84e;width:14px;height:14px}
  .feature-item .cap{color:#888;font-size:11px;margin-left:auto}
  .feature-item .used{color:#f59e0b}
  .feature-item .used.full{color:#ef4444}
  .btn{background:#2a2a2e;border:none;color:#e0e0e0;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;transition:all .1s}
  .btn:hover{background:#3a3a3e}
  .btn.gold{background:#c8a84e;color:#000;font-weight:600}
  .btn.gold:hover{background:#d4b55a}
  .modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:100;align-items:center;justify-content:center}
  .modal.show{display:flex}
  .modal-box{background:#141416;border-radius:8px;border:1px solid #2a2a2e;padding:24px;max-width:500px;width:90%;max-height:80vh;overflow-y:auto}
  .modal-box h2{color:#c8a84e;margin-bottom:12px;font-size:16px}
  .modal-box label{display:block;font-size:13px;color:#888;margin-bottom:4px;margin-top:10px}
  .modal-box input,.modal-box select{width:100%;padding:8px 10px;border-radius:6px;border:1px solid #2a2a2e;background:#0d0d0d;color:#fff;font-size:13px}
  .modal-box .btn-row{display:flex;gap:8px;margin-top:16px;justify-content:flex-end}
  .nav-links{margin-bottom:16px;font-size:13px}
  .nav-links a{color:#c8a84e;text-decoration:none;margin-right:12px}
  .nav-links a:hover{text-decoration:underline}
  .table-wrap{overflow-x:auto;border-radius:8px;border:1px solid #2a2a2e;margin-bottom:20px;background:#141416}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #2a2a2e}
  th{background:#0d0d0d;color:#c8a84e;font-weight:600}
  tr:hover td{background:#1a1a1e}
  .cost{color:#22c55e;font-variant-numeric:tabular-nums}
  .cost.red{color:#ef4444}
  .tabs{display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap}
  .tab{padding:8px 16px;border-radius:6px;background:#141416;border:1px solid #2a2a2e;color:#888;cursor:pointer;font-size:13px;font-weight:600}
  .tab.active{background:#c8a84e;color:#000;border-color:#c8a84e}
  .tab-content{display:none}.tab-content.show{display:block}
  .toast{position:fixed;bottom:20px;right:20px;padding:12px 20px;border-radius:8px;font-size:13px;z-index:200;display:none}
  .toast.success{background:#22c55e;color:#000;display:block}
  .toast.error{background:#ef4444;color:#fff;display:block}
</style>
</head>
<body>
<div class="container" id="app">
  <div class="login" id="loginScreen">
    <h2>Owner Access</h2>
    <p>Enter your phone number to manage clients</p>
    <input type="text" id="phoneInput" placeholder="27724971810" value="27724971810">
    <button onclick="login()" class="btn gold">Unlock</button>
    <div class="error" id="loginError">Wrong number. Owner access only.</div>
  </div>

  <div class="dashboard" id="dashboard">
    <h1>Owner Console</h1>
    <div class="nav-links">
      <a href="/admin/customers">Customers</a> &middot;
      <a href="/admin/leads">Leads</a> &middot;
      <a href="/admin/guide">Guide</a> &middot;
      <a href="/admin/owner">Owner</a> &middot;
      Orion 2026
    </div>

    <div class="tabs">
      <button class="tab active" onclick="switchTab('overview')">Overview</button>
      <button class="tab" onclick="switchTab('clients')">Clients</button>
      <button class="tab" onclick="switchTab('usage')">Usage</button>
    </div>

    <!-- Overview Tab -->
    <div class="tab-content show" id="tab-overview">
      <div class="stat-grid" id="statsGrid"></div>
      <div class="table-wrap">
        <h3 style="padding:12px;color:#888;font-size:13px">Cost Breakdown This Month</h3>
        <table><thead><tr><th>Feature</th><th>Calls</th><th>Cost (cents)</th></tr></thead>
        <tbody id="featureBreakdown"></tbody></table>
      </div>
    </div>

    <!-- Clients Tab -->
    <div class="tab-content" id="tab-clients">
      <div id="clientList"></div>
    </div>

    <!-- Usage Tab -->
    <div class="tab-content" id="tab-usage">
      <div class="table-wrap">
        <table><thead><tr><th>Client</th><th>Feature</th><th>Usage</th><th>Cap</th><th>%</th><th>Cost</th></tr></thead>
        <tbody id="usageTable"></tbody></table>
      </div>
    </div>
  </div>
</div>

<!-- Feature Edit Modal -->
<div class="modal" id="featureModal">
  <div class="modal-box">
    <h2 id="modalTitle">Edit Feature</h2>
    <label>Feature</label><div id="modalFeature" style="color:#fff;font-size:14px"></div>
    <label>Enabled</label>
    <select id="modalEnabled"><option value="1">ON</option><option value="0">OFF</option></select>
    <label>Monthly Cap</label>
    <input type="number" id="modalCap" min="0" placeholder="0 = unlimited">
    <div class="btn-row">
      <button onclick="closeModal()" class="btn">Cancel</button>
      <button onclick="saveFeature()" class="btn gold">Save</button>
    </div>
  </div>
</div>

<!-- Wallet Modal -->
<div class="modal" id="walletModal">
  <div class="modal-box">
    <h2 id="walletTitle">Manage Wallet</h2>
    <label>Amount (cents)</label>
    <input type="number" id="walletAmount" min="0" step="100" value="10000">
    <label>Description</label>
    <input type="text" id="walletDesc" placeholder="Deposit for SupaTraxx">
    <div class="btn-row">
      <button onclick="closeModal()" class="btn">Cancel</button>
      <button onclick="saveDeposit()" class="btn gold">Add Deposit</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let phone = '';
let clients = [];
let currentClientId = '';
let currentFeatureKey = '';

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('show'));
  document.querySelector('[onclick="switchTab(\\''+name+'\\')"]').classList.add('active');
  document.getElementById('tab-'+name).classList.add('show');
}

function toast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast ' + type;
  setTimeout(() => t.style.display = 'none', 3000);
}

async function login() {
  phone = document.getElementById('phoneInput').value.replace(/[^0-9]/g, '');
  if (phone !== '27724971810') {
    document.getElementById('loginError').style.display = 'block';
    return;
  }
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
  await loadData();
}

async function loadData() {
  try {
    const [statsRes, usageRes] = await Promise.all([
      fetch('/api/owner/stats?phone=' + phone),
      fetch('/api/owner/usage?phone=' + phone),
    ]);
    const stats = await statsRes.json();
    const usage = await usageRes.json();
    clients = stats.clients || [];
    renderStats(stats.global);
    renderClients();
    renderUsage(usage.rows || []);
  } catch(e) { toast('Failed to load: '+e.message, 'error'); }
}

function renderStats(global) {
  if (!global) return;
  document.getElementById('statsGrid').innerHTML = [
    '<div class="stat-card"><h3>Clients</h3><div class="num">' + clients.length + '</div></div>',
    '<div class="stat-card"><h3>API Calls (30d)</h3><div class="num">' + (global.total_calls || 0) + '</div></div>',
    '<div class="stat-card"><h3>Cost This Month</h3><div class="num ' + ((global.total_cost_cents || 0) > 10000 ? 'red' : 'green') + '">R' + ((global.total_cost_cents || 0) / 100).toFixed(2) + '</div></div>',
    '<div class="stat-card"><h3>Free Pool Left</h3><div class="num green">R' + Math.max(0, (10000 - (global.total_cost_cents || 0)) / 100).toFixed(2) + '</div></div>',
  ].join('');
  const fb = document.getElementById('featureBreakdown');
  fb.innerHTML = (global.feature_breakdown || []).map(f =>
    '<tr><td>' + f.feature_key + '</td><td>' + f.calls + '</td><td class="cost">R' + (f.cost_cents / 100).toFixed(2) + '</td></tr>'
  ).join('') || '<tr><td colspan="3" style="color:#888;text-align:center">No usage yet this month</td></tr>';
}

function renderClients() {
  const list = document.getElementById('clientList');
  if (!clients.length) {
    list.innerHTML = '<p style="color:#888;padding:20px;text-align:center">No clients yet. Create one via SQL.</p>';
    return;
  }
  list.innerHTML = clients.map(c => {
    const badgeClass = c.status === 'active' ? 'active' : c.status === 'paused' ? 'paused' : c.status === 'setup' ? 'setup' : 'suspended';
    return '<div class="client-card">' +
      '<div class="top">' +
      '<span class="name">' + escapeHtml(c.name) + '</span>' +
      '<span class="badge ' + badgeClass + '">' + c.status + '</span>' +
      '</div>' +
      '<div class="details">' +
      '<span>Phone: ' + (c.phone || '—') + '</span>' +
      '<span>Plan: ' + c.plan + '</span>' +
      '<span>Base: R' + ((c.monthly_base_fee_cents || 0) / 100).toFixed(0) + '/mo</span>' +
      '<span>Wallet: R' + ((c.wallet_balance_cents || 0) / 100).toFixed(0) + '</span>' +
      '<span>Cost this month: R' + ((c.month_cost || 0) / 100).toFixed(2) + '</span>' +
      '<button class="btn" onclick="openWallet(\'' + c.id + '\',\'' + escapeHtml(c.name) + '\')">Wallet</button>' +
      '</div>' +
      '<div class="features" id="features-' + c.id + '">Loading...</div>' +
      '</div>';
  }).join('');
  clients.forEach(c => loadFeatures(c.id));
}

async function loadFeatures(clientId) {
  try {
    const res = await fetch('/api/owner/features?phone=' + phone + '&client_id=' + clientId);
    const data = await res.json();
    const container = document.getElementById('features-' + clientId);
    if (!data.features) { container.innerHTML = '<span style="color:#888;font-size:12px">No features configured</span>'; return; }
    container.innerHTML = data.features.map(f => {
      const pct = f.monthly_cap > 0 ? Math.round((f.current_usage / f.monthly_cap) * 100) : 0;
      const usedClass = pct >= 90 ? 'full' : '';
      return '<div class="feature-item">' +
        '<input type="checkbox" ' + (f.enabled ? 'checked' : '') +
        ' onchange="toggleFeature(\'' + clientId + '\',\'' + f.feature_key + '\',this.checked)">' +
        '<span>' + f.feature_key + '</span>' +
        '<span class="cap">' +
        '<span class="used ' + usedClass + '">' + f.current_usage + '</span>/' + (f.monthly_cap || '∞') +
        '</span>' +
        '<button class="btn" onclick="openFeature(\'' + clientId + '\',\'' + f.feature_key + '\',\'' + f.enabled + '\',\'' + (f.monthly_cap || 0) + '\')">Edit</button>' +
        '</div>';
    }).join('');
  } catch(e) { console.error('Load features failed:', e); }
}

async function toggleFeature(clientId, featureKey, enabled) {
  try {
    await fetch('/api/owner/features', {
      method: 'PATCH',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({phone, client_id: clientId, feature_key: featureKey, enabled}),
    });
    toast(featureKey + ' ' + (enabled ? 'ON' : 'OFF'), 'success');
  } catch(e) { toast('Failed: ' + e.message, 'error'); }
}

function openFeature(clientId, featureKey, enabled, cap) {
  currentClientId = clientId;
  currentFeatureKey = featureKey;
  document.getElementById('modalFeature').textContent = featureKey;
  document.getElementById('modalEnabled').value = enabled === '1' || enabled === true ? '1' : '0';
  document.getElementById('modalCap').value = cap || 0;
  document.getElementById('featureModal').classList.add('show');
}

function closeModal() {
  document.querySelectorAll('.modal').forEach(m => m.classList.remove('show'));
}

async function saveFeature() {
  const enabled = document.getElementById('modalEnabled').value === '1';
  const cap = parseInt(document.getElementById('modalCap').value) || 0;
  try {
    await fetch('/api/owner/features', {
      method: 'PATCH',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({phone, client_id: currentClientId, feature_key: currentFeatureKey, enabled, monthly_cap: cap}),
    });
    closeModal();
    toast('Feature updated', 'success');
    await loadFeatures(currentClientId);
  } catch(e) { toast('Failed: ' + e.message, 'error'); }
}

function openWallet(clientId, name) {
  currentClientId = clientId;
  document.getElementById('walletTitle').textContent = 'Wallet — ' + name;
  document.getElementById('walletModal').classList.add('show');
}

async function saveDeposit() {
  const amount = parseInt(document.getElementById('walletAmount').value) || 0;
  const desc = document.getElementById('walletDesc').value || 'Deposit';
  if (amount <= 0) { toast('Amount must be > 0', 'error'); return; }
  try {
    await fetch('/api/owner/wallet', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({phone, client_id: currentClientId, amount_cents: amount, description: desc}),
    });
    closeModal();
    toast('R' + (amount/100).toFixed(2) + ' deposited', 'success');
    await loadData();
  } catch(e) { toast('Failed: ' + e.message, 'error'); }
}

function renderUsage(rows) {
  const tbody = document.getElementById('usageTable');
  tbody.innerHTML = rows.map(r =>
    '<tr>' +
    '<td>' + escapeHtml(r.name || r.client_id) + '</td>' +
    '<td>' + r.feature_key + '</td>' +
    '<td>' + r.current_usage + '</td>' +
    '<td>' + (r.monthly_cap || '∞') + '</td>' +
    '<td>' + (r.monthly_cap > 0 ? Math.round((r.current_usage / r.monthly_cap) * 100) + '%' : '—') + '</td>' +
    '<td class="cost">R' + ((r.cost_cents || 0) / 100).toFixed(2) + '</td>' +
    '</tr>'
  ).join('') || '<tr><td colspan="6" style="color:#888;text-align:center">No usage recorded</td></tr>';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
</script>
</body>
</html>`);
  });

  // ── Owner API Routes ──
  app.get('/api/owner/stats', async (c) => {
    const adminPhone = sanitizePhone(c.req.query('phone') || '');
    if (adminPhone !== '27724971810') return c.json({ error: 'Unauthorized' }, 403);
    try {
      const clients = await getAllClients(c.env as any);
      const global = await getGlobalUsageSummary(c.env as any);
      return c.json({ status: 'success', clients, global });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.get('/api/owner/features', async (c) => {
    const adminPhone = sanitizePhone(c.req.query('phone') || '');
    if (adminPhone !== '27724971810') return c.json({ error: 'Unauthorized' }, 403);
    const clientId = c.req.query('client_id') || '';
    if (!clientId) return c.json({ error: 'client_id required' }, 400);
    try {
      const features = await getClientUsageStats(c.env as any, clientId);
      return c.json({ status: 'success', features });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.patch('/api/owner/features', async (c) => {
    const { phone: p, client_id, feature_key, enabled, monthly_cap } = await c.req.json();
    if (sanitizePhone(p || '') !== '27724971810') return c.json({ error: 'Unauthorized' }, 403);
    try {
      await setFeature(c.env as any, client_id, feature_key, !!enabled, monthly_cap);
      return c.json({ status: 'success' });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.get('/api/owner/usage', async (c) => {
    const adminPhone = sanitizePhone(c.req.query('phone') || '');
    if (adminPhone !== '27724971810') return c.json({ error: 'Unauthorized' }, 403);
    try {
      const rows = await c.env.NALEDI_DB.prepare(
        `SELECT cf.client_id, c.name, cf.feature_key, cf.current_usage, cf.monthly_cap,
                COALESCE(SUM(ul.total_cost_cents), 0) as cost_cents
         FROM client_features cf
         LEFT JOIN clients c ON c.id = cf.client_id
         LEFT JOIN usage_log ul ON ul.client_id = cf.client_id AND ul.feature_key = cf.feature_key
           AND ul.created_at >= strftime('%Y-%m-01T00:00:00Z', 'now')
         GROUP BY cf.client_id, cf.feature_key
         ORDER BY cost_cents DESC`
      ).all<any>();
      return c.json({ status: 'success', rows: rows.results || [] });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.post('/api/owner/wallet', async (c) => {
    const { phone: p, client_id, amount_cents, description } = await c.req.json();
    if (sanitizePhone(p || '') !== '27724971810') return c.json({ error: 'Unauthorized' }, 403);
    try {
      await addTransaction(c.env as any, client_id, 'deposit', amount_cents, description || 'Manual deposit');
      return c.json({ status: 'success' });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ── WhatsApp Cloud API Webhook — receive incoming messages + verification ──
  app.get('/api/whatsapp-webhook', async (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    const expected = (c.env as any).META_VERIFY_TOKEN || 'orion_naledi_verify_2026';
    if (mode === 'subscribe' && token === expected && challenge) {
      return c.text(challenge);
    }
    return c.text('Verification failed', 403);
  });

  app.post('/api/whatsapp-webhook', async (c) => {
    try {
      const raw = await c.req.json();

      const entry = raw?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const messages = value?.messages;

      if (!messages || messages.length === 0) {
        return c.json({ status: 'ok' });
      }

      for (const msg of messages) {
        const from = msg.from;
        const msgType = msg.type;
        let body = '';

        if (msgType === 'text') {
          body = msg.text?.body || '';
        } else if (msgType === 'interactive') {
          const interactive = msg.interactive;
          body = interactive?.button_reply?.title || interactive?.list_reply?.title || '';
        } else if (msgType === 'audio') {
          body = '[Audio message]';
        } else if (msgType === 'image') {
          body = '[Image received]';
        } else {
          body = `[${msgType} message]`;
        }

        const contactName = value?.contacts?.[0]?.profile?.name || 'Unknown';

        const resp = await c.env.SELF.fetch('http://dummy/api/incoming', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, body, name: contactName }),
        });

        const data = await resp.json() as any;
        if (data?.reply) {
          const result = await sendWhatsAppMessage(c.env as any, from, data.reply);
          if (!result.success) {
            console.error('sendWhatsAppMessage failed:', result.error);
          }
        }
      }

      return c.json({ status: 'ok' });
    } catch (e: any) {
      return c.json({ status: 'error', message: e.message }, 200);
    }
  });

  // ── Avatar Generation ──
  app.post('/api/generate-avatar', async (c) => {
    try {
      const { prompt } = await c.req.json<{ prompt: string }>();
      if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
        return c.json({ error: 'prompt is required' }, 400);
      }
      const accountId = 'fdd89cf30de14e1ddcfa5fbbf27581c1';
      const apiToken = c.env.CLOUDFLARE_API_TOKEN;
      if (!apiToken) return c.json({ error: 'API token not configured' }, 503);
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/stabilityai/stable-diffusion-xl-base-1.0`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ prompt: prompt.trim() }),
        },
      );
      if (!res.ok) {
        const errText = await res.text();
        return c.json({ success: false, error: errText }, 200);
      }
      const contentType = res.headers.get('content-type') || '';
      let base64: string;
      if (contentType.includes('image')) {
        const buffer = await res.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        base64 = btoa(binary);
      } else {
        const json = await res.json() as any;
        if (json.result?.image) {
          base64 = json.result.image;
        } else {
          return c.json({ success: false, error: 'unexpected response format', raw: json }, 200);
        }
      }
      const dataUri = `data:image/png;base64,${base64}`;
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      return c.json({
        success: true,
        id,
        image: dataUri,
        model: 'sdxl',
        cost: 0,
        prompt: prompt.trim(),
      });
    } catch (e: any) {
      return c.json({ success: false, error: e?.message || 'generation failed' }, 200);
    }
  });

}
