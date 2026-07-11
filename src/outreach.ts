import { Hono } from 'hono';
import type { Bindings } from './helpers';
import { sanitizePhone } from './helpers';
import { sendWhatsAppMessage } from './cloud-api';

export const DAILY_LIMIT = 25;
const BIZ_START = 8;
const BIZ_END = 19;

function isMobile(phone: string): boolean {
  return /^0[678]/.test(phone.replace(/[^0-9]/g, ''));
}

const SEED_LEADS = [
  { business_name: "Amanzimtoti Fisheries", phone: "0319036067", category: "restaurant", address: "Shop 29, Arbour Crossing" },
  { business_name: "Blue Lagoon Restaurant", phone: "0319033320", category: "restaurant", address: "King Shaka Ave" },
  { business_name: "Ciao Baby Fusion", phone: "0319037777", category: "restaurant", address: "Arbour Crossing" },
  { business_name: "Nello's Pizza Amanzimtoti", phone: "0319035495", category: "restaurant", address: "Shop 6, San Michele Centre" },
  { business_name: "Spur Amanzimtoti", phone: "0319036053", category: "restaurant", address: "Arbour Crossing" },
  { business_name: "Ocean Basket Amanzimtoti", phone: "0319034433", category: "restaurant", address: "Arbour Crossing" },
  { business_name: "Body @ Peace Day Spa", phone: "0319035241", category: "salon", address: "45 Beach Road" },
  { business_name: "Cut Above The Rest", phone: "0319044445", category: "salon", address: "15 Ipahla Road" },
  { business_name: "Amanzimtoti Pharmacy", phone: "0319033316", category: "pharmacy", address: "Shop 14, Seadoone Mall" },
  { business_name: "Alpha Pharmacy Toti", phone: "0319031692", category: "pharmacy", address: "Arbour Crossing" },
  { business_name: "Toti Gardens Medical Centre", phone: "0319034022", category: "doctor", address: "Ipahla Road" },
  { business_name: "Dr R Reddy", phone: "0319032784", category: "doctor", address: "12 Andrew Zondo Road" },
  { business_name: "Amanzimtoti Dental", phone: "0319036045", category: "doctor", address: "Ipahla Road" },
  { business_name: "Ocean Hideaway B&B", phone: "0319041994", category: "accommodation", address: "337 Ipahla Road" },
  { business_name: "Mermaids Gardens", phone: "0319033439", category: "accommodation", address: "135 Beach Road" },
  { business_name: "Africa Conservation Tours", phone: "0718876905", category: "tours", address: "86 Vasco de Gama Street" },
  { business_name: "Buyisa Security and Cleaning", phone: "0861222725", category: "services", address: "390 Andrew Zondo Road" },
  { business_name: "Worldwide Tech Solutions", phone: "0663092938", category: "services", address: "Office G04A Arbour Grove" },
  { business_name: "Scaffold Training Group", phone: "0745358133", category: "services", address: "Lewis Dr" },
  { business_name: "Chad's Roofing", phone: "0832259201", category: "construction", address: "9 Denne Av" },
  { business_name: "RenoNation (Pty) Ltd", phone: "0713221090", category: "construction", address: "45 Burne Road" },
  { business_name: "ET Rapid Response Security", phone: "0861031111", category: "security", address: "20 Lewis Drive" },
  { business_name: "Spy Shop Amanzimtoti", phone: "0319415383", category: "retail", address: "407 Andrew Zondo Road" },
  { business_name: "Amanzimtoti Homes", phone: "0814499395", category: "property", address: "Amanzimtoti" },
  { business_name: "Baileys Estates", phone: "0319032085", category: "property", address: "Shop D4 Seadoone Mall" },
];

async function ensureTables(db: D1Database) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS outreach_leads (id INTEGER PRIMARY KEY AUTOINCREMENT, business_name TEXT NOT NULL, phone TEXT NOT NULL, category TEXT NOT NULL, address TEXT, status TEXT NOT NULL DEFAULT 'pending', pitch TEXT, last_contacted_at TEXT, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)"
  ).run();
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS outreach_config (key TEXT PRIMARY KEY, value TEXT)"
  ).run();
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS outreach_log (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, message TEXT, status TEXT DEFAULT 'pending', sent_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)"
  ).run();
  await db.prepare("ALTER TABLE outbox_messages ADD COLUMN sender TEXT DEFAULT 'naledi'").run().catch(() => {});
}

function isBusinessHours(): boolean {
  const sa = new Date().toLocaleString('en-US', { timeZone: 'Africa/Johannesburg', hour: 'numeric', hour12: false });
  const hour = parseInt(sa);
  return hour >= BIZ_START && hour < BIZ_END;
}

async function dailySentCount(db: D1Database): Promise<number> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
  const row = await db.prepare(
    "SELECT COUNT(*) as c FROM outreach_log WHERE date(sent_at) = ? AND status = 'sent'"
  ).bind(today).first<{ c: number }>();
  return row?.c || 0;
}

export function register(app: Hono<{ Bindings: Bindings }>) {
  app.post('/api/outreach/add-leads', async (c) => {
    try {
      await ensureTables(c.env.NALEDI_DB);
      const { leads } = await c.req.json();
      if (!Array.isArray(leads) || !leads.length) return c.json({ error: 'leads array required' }, 400);
      let added = 0;
      for (const lead of leads) {
        if (!lead.business_name || !lead.phone) continue;
        const existing = await c.env.NALEDI_DB.prepare(
          'SELECT id FROM outreach_leads WHERE phone = ? AND business_name = ?'
        ).bind(lead.phone, lead.business_name).first();
        if (!existing) {
          await c.env.NALEDI_DB.prepare(
            'INSERT INTO outreach_leads (business_name, phone, category, address, notes) VALUES (?, ?, ?, ?, ?)'
          ).bind(lead.business_name, lead.phone, lead.category || 'general', lead.address || null, lead.notes || 'english').run();
          added++;
        }
      }
      return c.json({ status: 'success', added, total: await c.env.NALEDI_DB.prepare('SELECT COUNT(*) as c FROM outreach_leads').first<{ c: number }>().then(r => r?.c) });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.post('/api/outreach/seed', async (c) => {
    try {
      await ensureTables(c.env.NALEDI_DB);
      let count = 0;
      for (const lead of SEED_LEADS) {
        if (!isMobile(lead.phone)) continue;
        const existing = await c.env.NALEDI_DB.prepare(
          'SELECT id FROM outreach_leads WHERE phone = ? AND business_name = ?'
        ).bind(lead.phone, lead.business_name).first();
        if (!existing) {
          await c.env.NALEDI_DB.prepare(
            'INSERT INTO outreach_leads (business_name, phone, category, address) VALUES (?, ?, ?, ?)'
          ).bind(lead.phone, lead.business_name, lead.category, lead.address || null).run();
          count++;
        }
      }
      return c.json({ status: 'success', seeded: count });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.get('/api/outreach/stats', async (c) => {
    try {
      await ensureTables(c.env.NALEDI_DB);
      const [total, pending, contacted, today] = await Promise.all([
        c.env.NALEDI_DB.prepare('SELECT COUNT(*) as c FROM outreach_leads').first<{ c: number }>(),
        c.env.NALEDI_DB.prepare("SELECT COUNT(*) as c FROM outreach_leads WHERE status = 'pending'").first<{ c: number }>(),
        c.env.NALEDI_DB.prepare("SELECT COUNT(*) as c FROM outreach_leads WHERE status = 'contacted'").first<{ c: number }>(),
        dailySentCount(c.env.NALEDI_DB),
      ]);
      const breakdown = await c.env.NALEDI_DB.prepare(
        'SELECT status, COUNT(*) as c FROM outreach_leads GROUP BY status'
      ).all<{ status: string; c: number }>();
      const categories = await c.env.NALEDI_DB.prepare(
        'SELECT category, COUNT(*) as c FROM outreach_leads GROUP BY category ORDER BY c DESC'
      ).all<{ category: string; c: number }>();
      return c.json({
        status: 'success',
        breakdown: breakdown.results,
        total: total?.c || 0,
        pending: pending?.c || 0,
        contacted: contacted?.c || 0,
        sent_today: today,
        daily_limit: DAILY_LIMIT,
        categories: categories.results || [],
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.get('/api/outreach/next', async (c) => {
    try {
      await ensureTables(c.env.NALEDI_DB);
      const category = c.req.query('category') || '';
      if (!category) return c.json({ error: 'category required' }, 400);

      const lead = await c.env.NALEDI_DB.prepare(
        "SELECT * FROM outreach_leads WHERE category = ? AND status = 'pending' ORDER BY id ASC LIMIT 1"
      ).bind(category).first<any>();
      if (!lead) return c.json({ status: 'empty', message: 'No more leads in that category' });

      const generated = `Howzit, Graham here from Pipeline to Winkle News. Have you heard of South African's ONLY WhatsApp agent that is basically you and can speak in English, Afrikaans, and Zulu? No? Well, it's designed just for you guys. That tuff right? I dare you to reply to be the first to try her out. Have a blessed day!`;

      return c.json({
        status: 'success',
        lead: { id: lead.id, business_name: lead.business_name, phone: lead.phone, category: lead.category },
        message: generated,
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.post('/api/outreach/send', async (c) => {
    try {
      await ensureTables(c.env.NALEDI_DB);

      if (!isBusinessHours()) {
        return c.json({ status: 'blocked', message: 'Outside business hours (8am-7pm SAST)' });
      }

      const sent = await dailySentCount(c.env.NALEDI_DB);
      if (sent >= DAILY_LIMIT) {
        return c.json({ status: 'blocked', message: `Daily limit of ${DAILY_LIMIT} reached. ${sent} sent today.` });
      }

      const { lead_id, message } = await c.req.json();
      if (!lead_id || !message) return c.json({ error: 'lead_id and message required' }, 400);

      const lead = await c.env.NALEDI_DB.prepare(
        'SELECT * FROM outreach_leads WHERE id = ?'
      ).bind(lead_id).first<any>();
      if (!lead) return c.json({ error: 'Lead not found' }, 404);
      if (lead.status !== 'pending') return c.json({ error: 'Lead already contacted' }, 409);

      const phone = sanitizePhone(lead.phone);
      if (!phone || phone.length < 9) return c.json({ error: 'Invalid phone number' }, 400);

      await sendWhatsAppMessage(c.env, phone, message).catch(() => {});

      await c.env.NALEDI_DB.prepare(
        "UPDATE outreach_leads SET status = 'contacted', last_contacted_at = CURRENT_TIMESTAMP, notes = ? WHERE id = ?"
      ).bind(message.slice(0, 200), lead_id).run();

      await c.env.NALEDI_DB.prepare(
        "INSERT INTO outreach_log (lead_id, message, status) VALUES (?, ?, 'sent')"
      ).bind(lead_id, message).run();

      return c.json({
        status: 'sent',
        business: lead.business_name,
        phone,
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.post('/api/outreach/generate', async (c) => {
    try {
      await ensureTables(c.env.NALEDI_DB);
      const category = c.req.query('category') || '';
      if (!category) return c.json({ error: 'category required' }, 400);

      const rows = await c.env.NALEDI_DB.prepare(
        "SELECT * FROM outreach_leads WHERE category = ? AND status = 'pending' AND pitch IS NULL ORDER BY id ASC"
      ).bind(category).all<any>();
      if (!rows.results?.length) return c.json({ status: 'empty', message: 'All leads in that category already have pitches or are contacted.' });

      let generated = 0;
      for (const lead of rows.results) {
        try {
          const msg = `Howzit, Graham here from Pipeline to Winkle News. Have you heard of South African's ONLY WhatsApp agent that is basically you and can speak in English, Afrikaans, and Zulu? No? Well, it's designed just for you guys. That tuff right? I dare you to reply to be the first to try her out. Have a blessed day!`;
          await c.env.NALEDI_DB.prepare('UPDATE outreach_leads SET pitch = ? WHERE id = ?').bind(msg, lead.id).run();
          generated++;
        } catch (e: any) {
          console.error(`Failed generating pitch for lead ${lead.id}:`, e.message);
        }
      }

      return c.json({ status: 'success', generated, total: rows.results.length });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.get('/api/outreach/csv', async (c) => {
    try {
      await ensureTables(c.env.NALEDI_DB);
      const category = c.req.query('category') || '';
      let rows: any[];
      if (category) {
        const res = await c.env.NALEDI_DB.prepare(
          "SELECT * FROM outreach_leads WHERE category = ? AND status = 'pending' AND pitch IS NOT NULL ORDER BY id ASC"
        ).bind(category).all<any>();
        rows = res.results || [];
      } else {
        const res = await c.env.NALEDI_DB.prepare(
          "SELECT * FROM outreach_leads WHERE status = 'pending' AND pitch IS NOT NULL ORDER BY category, id ASC"
        ).all<any>();
        rows = res.results || [];
      }

      if (!rows.length) return c.json({ status: 'empty', message: 'No pitches ready. First run /api/outreach/generate?category=X to create pitches.' });

      const csvRows = ['id,business_name,phone,category,pitch,status'];
      for (const l of rows) {
        const pitch = (l.pitch || '').replace(/"/g, '""');
        csvRows.push(`${l.id},"${l.business_name}","${l.phone}","${l.category}","${pitch}",pending`);
      }

      return c.newResponse(csvRows.join('\n'), 200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="naledi-outreach-${category || 'all'}.csv"`,
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.post('/api/outreach/csv', async (c) => {
    try {
      await ensureTables(c.env.NALEDI_DB);

      if (!isBusinessHours()) {
        return c.json({ status: 'blocked', message: 'Outside business hours (8am-7pm SAST)' });
      }

      const sentToday = await dailySentCount(c.env.NALEDI_DB);
      const remaining = Math.max(0, DAILY_LIMIT - sentToday);

      const { rows, sender } = await c.req.json();
      if (!Array.isArray(rows) || !rows.length) return c.json({ error: 'rows array required' }, 400);

      let approved = 0;
      let skipped = 0;
      let queued = 0;

      for (const row of rows) {
        if (row.status !== 'approve') {
          skipped++;
          await c.env.NALEDI_DB.prepare('UPDATE outreach_leads SET status = ?, notes = ? WHERE id = ?')
            .bind(row.status === 'skip' ? 'skipped' : 'pending', row.notes || null, row.id).run();
          continue;
        }

        approved++;
        if (queued >= remaining) continue;

        const lead = await c.env.NALEDI_DB.prepare('SELECT * FROM outreach_leads WHERE id = ? AND status = ?')
          .bind(row.id, 'pending').first<any>();
        if (!lead || !lead.pitch) { skipped++; continue; }

        const phone = sanitizePhone(lead.phone);
        if (!phone || phone.length < 9) { skipped++; continue; }

        await sendWhatsAppMessage(c.env, phone, lead.pitch).catch(() => {});

        await c.env.NALEDI_DB.prepare(
          "UPDATE outreach_leads SET status = 'contacted', last_contacted_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(row.id).run();

        await c.env.NALEDI_DB.prepare(
          "INSERT INTO outreach_log (lead_id, message, status) VALUES (?, ?, 'sent')"
        ).bind(row.id, lead.pitch).run();

        queued++;
      }

      return c.json({
        status: 'success',
        approved,
        queued,
        skipped,
        daily_remaining: remaining - queued,
        will_queue_tomorrow: approved - queued,
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.post('/api/outreach/apply-template', async (c) => {
    try {
      await ensureTables(c.env.NALEDI_DB);
      const { template, language } = await c.req.json();
      if (!template) return c.json({ error: 'template required (use {name} and {category} placeholders)' }, 400);

      const leads = await c.env.NALEDI_DB.prepare(
        "SELECT id, business_name, category FROM outreach_leads WHERE status = 'pending' AND (? IS NULL OR notes = ?)"
      ).bind(language || null, language || null).all<{ id: number; business_name: string; category: string }>();

      let updated = 0;
      for (const lead of leads.results || []) {
        const pitch = template
          .replace(/\{name\}/g, lead.business_name)
          .replace(/\{category\}/g, lead.category);
        await c.env.NALEDI_DB.prepare('UPDATE outreach_leads SET pitch = ?, notes = ? WHERE id = ?')
          .bind(pitch, language || 'english', lead.id).run();
        updated++;
      }
      return c.json({ status: 'success', updated, total: leads.results?.length || 0 });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.post('/api/outreach/clear-pitches', async (c) => {
    try {
      await ensureTables(c.env.NALEDI_DB);
      const result = await c.env.NALEDI_DB.prepare(
        "UPDATE outreach_leads SET pitch = NULL WHERE status = 'pending'"
      ).run();
      return c.json({ status: 'success', cleared: result.meta.changes });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.post('/api/outreach/set-pitch', async (c) => {
    try {
      await ensureTables(c.env.NALEDI_DB);
      const { message } = await c.req.json();
      if (!message) return c.json({ error: 'message required' }, 400);
      const result = await c.env.NALEDI_DB.prepare(
        "UPDATE outreach_leads SET pitch = ? WHERE status = 'pending'"
      ).bind(message).run();
      return c.json({ status: 'success', updated: result.meta.changes });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.post('/api/outreach/skip-landlines', async (c) => {
    try {
      await ensureTables(c.env.NALEDI_DB);
      const result = await c.env.NALEDI_DB.prepare(
        "UPDATE outreach_leads SET status = 'skipped', notes = 'landline' WHERE status = 'pending' AND (phone LIKE '031%' OR phone LIKE '086%')"
      ).run();
      const remaining = await c.env.NALEDI_DB.prepare(
        "SELECT COUNT(*) as c FROM outreach_leads WHERE status = 'pending'"
      ).first<{ c: number }>();
      return c.json({ status: 'success', skipped: result.meta.changes, remaining: remaining?.c || 0 });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.post('/api/outreach/fix-phones', async (c) => {
    try {
      await ensureTables(c.env.NALEDI_DB);
      const leads = await c.env.NALEDI_DB.prepare(
        "SELECT id, phone FROM outreach_leads WHERE status = 'pending'"
      ).all<{ id: number; phone: string }>();
      let fixed = 0;
      for (const lead of leads.results || []) {
        const cleaned = lead.phone.replace(/[^0-9]/g, '');
        let formatted = cleaned;
        if (cleaned.startsWith('0')) formatted = '27' + cleaned.slice(1);
        if (cleaned.startsWith('27') && cleaned.length === 11) formatted = cleaned;
        if (cleaned.startsWith('+27')) formatted = cleaned.replace('+', '');
        if (formatted !== cleaned) {
          await c.env.NALEDI_DB.prepare('UPDATE outreach_leads SET phone = ? WHERE id = ?').bind(formatted, lead.id).run();
          fixed++;
        }
      }
      return c.json({ status: 'success', fixed, checked: leads.results?.length || 0 });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.post('/api/outreach/reset', async (c) => {
    try {
      await ensureTables(c.env.NALEDI_DB);
      const { ids } = await c.req.json();
      if (!Array.isArray(ids) || !ids.length) return c.json({ error: 'ids array required' }, 400);
      const r = await c.env.NALEDI_DB.prepare(
        `UPDATE outreach_leads SET status = 'pending', last_contacted_at = NULL WHERE id IN (${ids.map(() => '?').join(',')})`
      ).bind(...ids).run();
      return c.json({ status: 'ok', updated: r.meta.changes });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.post('/api/outreach/add', async (c) => {
    try {
      await ensureTables(c.env.NALEDI_DB);
      const { business_name, phone, category, address } = await c.req.json();
      if (!business_name || !phone || !category) return c.json({ error: 'business_name, phone, category required' }, 400);

      const existing = await c.env.NALEDI_DB.prepare(
        'SELECT id FROM outreach_leads WHERE phone = ?'
      ).bind(sanitizePhone(phone)).first();
      if (existing) return c.json({ status: 'duplicate', id: existing.id });

      const result = await c.env.NALEDI_DB.prepare(
        'INSERT INTO outreach_leads (business_name, phone, category, address) VALUES (?, ?, ?, ?) RETURNING id'
      ).bind(business_name, sanitizePhone(phone), category, address || null).first<{ id: number }>();

      return c.json({ status: 'added', id: result?.id });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });
}
