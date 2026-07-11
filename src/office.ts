import { Hono } from 'hono';
import type { Bindings } from './helpers';
import { google } from './helpers';

const DEFAULT_SPREADSHEET_ID = '1KRGoxRx3aqhEXcTGX1Lmd9D2CVbQwB7kk2Ft38QW6Pk';

const HEADERS: Record<string, string[]> = {
  Leads: ['Timestamp', 'Name', 'Phone', 'Email', 'Business', 'Source', 'Notes'],
  Orders: ['Timestamp', 'Customer', 'Phone', 'Plan', 'Amount', 'Status'],
  Customers: ['Timestamp', 'Name', 'Phone', 'Email', 'Business', 'Plan', 'Onboarded'],
  Bookings: ['Timestamp', 'Customer', 'Phone', 'Service', 'Date', 'Time'],
  SetupCalls: ['Timestamp', 'Customer', 'Phone', 'Email', 'Plan', 'DateTime'],
};

export function register(app: Hono<{ Bindings: Bindings }>) {
  // ── SHEETS: Add headers to existing spreadsheet ──
  app.post('/api/office/headers', async (c) => {
    try {
      const row = await c.env.NALEDI_DB.prepare('SELECT refresh_token FROM calendar_tokens WHERE id = 1').first<{ refresh_token: string }>();
      if (!row) throw new Error('Google not connected');
      const { access_token } = await google.refreshAccessToken(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, row.refresh_token);
      const sid = DEFAULT_SPREADSHEET_ID;
      for (const [sheet, headers] of Object.entries(HEADERS)) {
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${sheet}!A1:Z1?valueInputOption=USER_ENTERED`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [headers] }),
        });
      }
      return c.json({ status: 'ok', message: 'Headers written to all sheets' });
    } catch (e: any) {
      return c.json({ status: 'error', error: e.message }, 200);
    }
  });

  // ── SHEETS: Auto-create spreadsheet with headers ──
  app.post('/api/office/setup', async (c) => {
    try {
      const row = await c.env.NALEDI_DB.prepare('SELECT refresh_token FROM calendar_tokens WHERE id = 1').first<{ refresh_token: string }>();
      if (!row) throw new Error('Google not connected');
      const { access_token } = await google.refreshAccessToken(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, row.refresh_token);
      const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          properties: { title: 'Orion Office Automation' },
          sheets: [
            { properties: { title: 'Leads' } },
            { properties: { title: 'Orders' } },
            { properties: { title: 'Customers' } },
            { properties: { title: 'Bookings' } },
            { properties: { title: 'SetupCalls' } },
          ],
        }),
      });
      const data: any = await res.json();
      if (!res.ok) return c.json({ status: 'error', error: data.error?.message || 'create failed' }, 200);
      const sid = data.spreadsheetId;
      for (const [sheet, headers] of Object.entries(HEADERS)) {
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${sheet}!A1:Z1?valueInputOption=USER_ENTERED`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [headers] }),
        });
      }
      await c.env.NALEDI_DB.prepare("INSERT OR REPLACE INTO naledi_config (key, value) VALUES ('spreadsheet_id', ?)").bind(sid).run();
      return c.json({ status: 'created', spreadsheetId: sid, url: `https://docs.google.com/spreadsheets/d/${sid}` });
    } catch (e: any) {
      return c.json({ status: 'error', error: e.message }, 200);
    }
  });

  // ── SHEETS: Auto-log a lead ──
  app.post('/api/office/log-lead', async (c) => {
    try {
      const { name, phone, email, business, source, notes } = await c.req.json();
      const now = new Date().toISOString();
      await google.appendSheetRow(c.env, DEFAULT_SPREADSHEET_ID, 'Leads!A:G', [
        now, name || '', phone || '', email || '', business || '', source || 'whatsapp', notes || ''
      ]);
      return c.json({ status: 'logged' });
    } catch (e: any) {
      return c.json({ status: 'error', error: e.message }, 200);
    }
  });

  // ── SHEETS: Auto-log an order ──
  app.post('/api/office/log-order', async (c) => {
    try {
      const { customerName, phone, plan, amount, status } = await c.req.json();
      const now = new Date().toISOString();
      await google.appendSheetRow(c.env, DEFAULT_SPREADSHEET_ID, 'Orders!A:F', [
        now, customerName || '', phone || '', plan || '', amount || '', status || 'pending'
      ]);
      return c.json({ status: 'logged' });
    } catch (e: any) {
      return c.json({ status: 'error', error: e.message }, 200);
    }
  });

  // ── SHEETS: Auto-log a customer signup ──
  app.post('/api/office/log-customer', async (c) => {
    try {
      const { name, phone, email, business, plan, onboarded } = await c.req.json();
      const now = new Date().toISOString();
      await google.appendSheetRow(c.env, DEFAULT_SPREADSHEET_ID, 'Customers!A:G', [
        now, name || '', phone || '', email || '', business || '', plan || '', onboarded ? 'yes' : 'pending'
      ]);
      return c.json({ status: 'logged' });
    } catch (e: any) {
      return c.json({ status: 'error', error: e.message }, 200);
    }
  });

  // ── SHEETS: Log a calendar booking ──
  app.post('/api/office/log-booking', async (c) => {
    try {
      const { customerName, phone, service, date, time } = await c.req.json();
      const now = new Date().toISOString();
      await google.appendSheetRow(c.env, DEFAULT_SPREADSHEET_ID, 'Bookings!A:F', [
        now, customerName || '', phone || '', service || '', date || '', time || ''
      ]);
      return c.json({ status: 'logged' });
    } catch (e: any) {
      return c.json({ status: 'error', error: e.message }, 200);
    }
  });

  // ── SHEETS: Read sheet data ──
  app.get('/api/office/sheet/:range', async (c) => {
    try {
      const range = c.req.param('range');
      const data = await google.readSheetRange(c.env, DEFAULT_SPREADSHEET_ID, range);
      return c.json({ status: 'success', data });
    } catch (e: any) {
      return c.json({ status: 'error', error: e.message }, 200);
    }
  });

  // ── DOCS: Generate quote PDF ──
  app.post('/api/office/generate-quote', async (c) => {
    try {
      const { customerName, business, email, plan, amount, features } = await c.req.json();
      const docId = await google.copyTemplate(c.env, '1_QUOTE_TEMPLATE_ID', `Quote - ${customerName} - ${new Date().toISOString().split('T')[0]}`);
      await google.fillDocTemplate(c.env, docId, {
        CUSTOMER_NAME: customerName || 'Valued Client',
        BUSINESS: business || 'Your Business',
        EMAIL: email || '',
        PLAN: plan || 'Orion PRO',
        AMOUNT: amount || 'R2,690',
        FEATURES: features || 'AI WhatsApp receptionist, Customer management, Business dashboard',
        DATE: new Date().toISOString().split('T')[0],
      });
      const pdf = await google.exportPdf(c.env, docId);
      await google.sendDocAsEmail(
        c.env,
        email || 'graham@oriondevcore.com',
        `Quote: ${plan} — ${customerName}`,
        `Hi ${customerName},\n\nPlease find your quote attached for the ${plan} plan at ${amount}/month.\n\nLet me know if you have any questions.\n\n— Naledi`,
        pdf,
        `Quote-${customerName.replace(/\s+/g, '_')}.pdf`
      );
      return c.json({ status: 'sent', documentId: docId });
    } catch (e: any) {
      return c.json({ status: 'error', error: e.message }, 200);
    }
  });

  // ── DOCS: Generate invoice ──
  app.post('/api/office/generate-invoice', async (c) => {
    try {
      const { customerName, business, email, plan, amount, invoiceNumber } = await c.req.json();
      const docId = await google.copyTemplate(c.env, '1_INVOICE_TEMPLATE_ID', `Invoice ${invoiceNumber} - ${customerName}`);
      await google.fillDocTemplate(c.env, docId, {
        INVOICE_NUMBER: invoiceNumber || 'INV-001',
        CUSTOMER_NAME: customerName || 'Valued Client',
        BUSINESS: business || '',
        PLAN: plan || 'Orion PRO',
        AMOUNT: amount || 'R2,690',
        DATE: new Date().toISOString().split('T')[0],
        DUE_DATE: new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0],
      });
      const pdf = await google.exportPdf(c.env, docId);
      await google.sendDocAsEmail(
        c.env,
        email || 'graham@oriondevcore.com',
        `Invoice ${invoiceNumber} — ${customerName}`,
        `Hi ${customerName},\n\nYour invoice for ${plan} (${amount}) is attached.\n\nPayment due within 14 days.\n\n— Naledi`,
        pdf,
        `Invoice-${invoiceNumber}.pdf`
      );
      return c.json({ status: 'sent', documentId: docId });
    } catch (e: any) {
      return c.json({ status: 'error', error: e.message }, 200);
    }
  });

  // ── CALENDAR: Book a setup call + auto-email + auto-sheet ──
  app.post('/api/office/book-setup-call', async (c) => {
    try {
      const { customerName, phone, email, plan, dateTime } = await c.req.json();
      const endTime = new Date(new Date(dateTime).getTime() + 60 * 60 * 1000).toISOString();
      const event = await google.createEvent(c.env, {
        summary: `Setup Call: ${customerName} — ${plan}`,
        description: `New client setup call\nCustomer: ${customerName}\nPhone: ${phone}\nEmail: ${email}\nPlan: ${plan}`,
        start: { dateTime, timeZone: 'Africa/Johannesburg' },
        end: { dateTime: endTime, timeZone: 'Africa/Johannesburg' },
      });
      await google.appendSheetRow(c.env, DEFAULT_SPREADSHEET_ID, 'SetupCalls!A:F', [
        new Date().toISOString(), customerName, phone || '', email || '', plan || '', dateTime
      ]);
      await c.env.EMAIL.send({
        to: email || 'graham@oriondevcore.com',
        from: { email: 'naledi@oriondevcore.com', name: 'Naledi Star' },
        subject: `Setup Call Confirmed: ${customerName}`,
        text: `Your setup call is confirmed for ${dateTime}.\n\nWe'll WhatsApp you to confirm.\n\n— Naledi`,
      });
      return c.json({ status: 'booked', eventId: event.id });
    } catch (e: any) {
      return c.json({ status: 'error', error: e.message }, 200);
    }
  });

  // ── OFFICE STATUS ──
  app.get('/api/office/status', async (c) => {
    const row = await c.env.NALEDI_DB.prepare(
      'SELECT refresh_token, updated_at FROM calendar_tokens WHERE id = 1'
    ).first<{ refresh_token: string; updated_at: string }>();
    return c.json({
      status: 'success',
      connected: !!row?.refresh_token,
      connected_at: row?.updated_at || null,
      modules: ['sheets', 'docs', 'calendar', 'email'],
      spreadsheet: DEFAULT_SPREADSHEET_ID,
    });
  });

  // ── EMAIL: Send custom email ──
  app.post('/api/office/send-email', async (c) => {
    try {
      const { to, subject, text } = await c.req.json();
      if (!to || !subject || !text) return c.json({ error: 'to, subject, text required' }, 400);
      await c.env.EMAIL.send({
        to,
        from: { email: 'naledi@oriondevcore.com', name: 'Naledi Star' },
        subject,
        text,
      });
      return c.json({ status: 'sent' });
    } catch (e: any) {
      return c.json({ status: 'error', error: e.message }, 200);
    }
  });
}
