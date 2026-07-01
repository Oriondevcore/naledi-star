import { Hono } from 'hono';
import type { Bindings } from './helpers';
import { sanitizePhone } from './helpers';
import { sendOrderConfirmation, sendGrahamNotification } from './email';
import { sendWhatsAppMessage, processOutbox } from './cloud-api';

export function register(app: Hono<{ Bindings: Bindings }>) {
  app.post('/api/orders', async (c) => {
    try {
      const { chargeId, product, amount, currency, customerName, customerEmail, customerPhone, orderType, orderNumber, notes } = await c.req.json();
      if (!chargeId || !product || !amount || !customerName || !customerEmail) {
        return c.json({ error: 'Missing required fields' }, 400);
      }
      const amountInCents = Math.round(amount * 100);
      const result = await c.env.NALEDI_DB.prepare(
        `INSERT INTO orders (charge_id, product, amount_in_cents, currency, customer_name, customer_email, customer_notes, order_type, order_number, status, notified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 0)`
      ).bind(chargeId, product, amountInCents, currency || 'ZAR', customerName, customerEmail, notes || null, orderType || 'print', orderNumber || `OV-${Date.now()}`).run();
      if (!result.success) {
        return c.json({ error: 'Failed to save order' }, 500);
      }

      // Create invoice in new schema
      const invId = crypto.randomUUID();
      const invNumber = `INV-${Date.now().toString(36).toUpperCase()}`;
      await c.env.DB.prepare(
        `INSERT INTO invoices (id, invoice_number, description, amount_cents, currency, status, due_date, issued_at, gateway, customer_name, customer_email, customer_phone)
         VALUES (?, ?, ?, ?, ?, 'paid', ?, ?, 'on-site', ?, ?, ?)`
      ).bind(invId, invNumber, product, amountInCents, currency || 'ZAR', new Date().toISOString(), new Date().toISOString(), customerName, customerEmail, customerPhone || null).run().catch(() => {});
      await c.env.DB.prepare(
        `INSERT INTO invoice_items (id, invoice_id, description, amount_cents, quantity)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), invId, product, amountInCents, 1).run().catch(() => {});

      // If this is a Naledi plan order with a phone — send welcome + notify Graham
      if (customerPhone && (product || '').toLowerCase().includes('naledi')) {
        const phone = sanitizePhone(customerPhone);
        // Welcome message to the buyer
        await c.env.NALEDI_DB.prepare(
          "INSERT INTO outbox_messages (recipient, message, sender) VALUES (?, ?, 'naledi')"
        ).bind(phone,
          'Hi ' + customerName + '! Welcome to Naledi 🎉\n\n' +
          'We got your payment. Here is what happens next:\n' +
          '1. We will WhatsApp you within 2 hours to schedule your setup call\n' +
          '2. Send us your business name, logo, and price list PDF\n' +
          '3. We train Naledi on your business and get you live\n\n' +
          'Need help now? Reply to this message or ask on WhatsApp.\n' +
          '— The Orion Team'
        ).run().catch(() => {});
      }

      // Always notify Graham
      if (customerPhone) {
        await c.env.NALEDI_DB.prepare(
          "INSERT INTO outbox_messages (recipient, message, sender) VALUES (?, ?, 'naledi')"
        ).bind('27724971810',
          'New Naledi order: ' + product + '\n' +
          'Customer: ' + customerName + ' (' + customerEmail + ')\n' +
          'Phone: ' + customerPhone + '\n' +
          'Amount: R' + (amountInCents / 100).toFixed(2) + '\n' +
          'Order: ' + (orderNumber || 'N/A') + '\n' +
          'Setup within 1-3 business days!'
        ).run().catch(() => {});
      }

      // Send email confirmation (non-blocking)
      const amt = 'R' + (amountInCents / 100).toFixed(2);
      sendOrderConfirmation(c.env, customerEmail, customerName, product, amt).catch(() => {});
      if (customerEmail !== 'graham@oriondevcore.com') {
        sendGrahamNotification(c.env, customerName, customerEmail, customerPhone || 'none', product, amt).catch(() => {});
      }

      return c.json({ status: 'ok', orderId: result.meta.last_row_id });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.get('/api/outbox', async (c) => {
    try {
      const sender = c.req.query('sender') || 'naledi';
      const [orders, messages] = await Promise.all([
        c.env.NALEDI_DB.prepare(
          "SELECT id, order_number, customer_name, customer_email, product, amount_in_cents, currency, order_type, created_at FROM orders WHERE notified = 0 ORDER BY created_at ASC LIMIT 10"
        ).all<any>(),
        c.env.NALEDI_DB.prepare(
          "SELECT id, recipient, message, created_at FROM outbox_messages WHERE status = 'pending' AND sender = ? ORDER BY created_at ASC LIMIT 10"
        ).bind(sender).all<any>(),
      ]);
      const result = [
        ...(orders.results || []).map((o: any) => ({
          id: `order:${o.id}`,
          to: '27724971810',
          message: `New Order — Orion\n${o.order_type === 'karaoke' ? 'Custom Karaoke Track' : 'Art Print'}: ${o.product}\nCustomer: ${o.customer_name} (${o.customer_email})\nAmount: R${(o.amount_in_cents / 100).toFixed(2)}\nOrder: ${o.order_number}\nDate: ${o.created_at}`,
        })),
        ...(messages.results || []).map((m: any) => ({
          id: `msg:${m.id}`,
          to: m.recipient,
          message: m.message,
        })),
      ];
      return c.json({ messages: result });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.post('/api/outbox/confirm', async (c) => {
    try {
      const { ids, status, error } = await c.req.json();
      if (!Array.isArray(ids) || ids.length === 0) return c.json({ error: 'ids array required' }, 400);
      const newStatus = status === 'failed' ? 'failed' : 'sent';
      for (const id of ids) {
        if (id.startsWith('order:')) {
          await c.env.NALEDI_DB.prepare('UPDATE orders SET notified = 1 WHERE id = ?').bind(Number(id.slice(6))).run();
        } else if (id.startsWith('msg:')) {
          const numId = Number(id.slice(4));
          if (newStatus === 'failed') {
            await c.env.NALEDI_DB.prepare("UPDATE outbox_messages SET status = 'failed', notes = ? WHERE id = ?").bind(error || 'Send failed', numId).run();
          } else {
            await c.env.NALEDI_DB.prepare("UPDATE outbox_messages SET status = 'sent' WHERE id = ?").bind(numId).run();
          }
        }
      }
      return c.json({ status: 'ok', confirmed: ids.length });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.post('/api/send', async (c) => {
    try {
      const { to, message, sender } = await c.req.json();
      if (!to || !message) return c.json({ error: 'to and message required' }, 400);

      // Try Cloud API first
      const apiResult = await sendWhatsAppMessage(c.env, to, message);
      if (apiResult.success) {
        return c.json({ status: 'sent', provider: 'cloud-api' });
      }

      // Fallback to queue for Puppeteer daemon
      const result = await c.env.NALEDI_DB.prepare(
        'INSERT INTO outbox_messages (recipient, message, sender) VALUES (?, ?, ?) RETURNING id'
      ).bind(to, message, sender || 'naledi').first<{ id: number }>();
      return c.json({ status: 'queued', id: result?.id, fallback: true });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.post('/api/outbox/process', async (c) => {
    try {
      const result = await processOutbox(c.env);
      return c.json(result);
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ── DOCS UPLOAD ──
  app.get('/docs-upload', async (c) => {
    const phone = c.req.query('phone') || '';
    return c.html(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Upload Docs — Naledi</title>
<style>*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,sans-serif}body{background:#080809;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px}.card{background:#1a1a1e;padding:40px;border-radius:16px;max-width:500px;width:100%;text-align:center}h1{color:#00e5ff;margin-bottom:8px;font-size:24px}p{color:#888;margin-bottom:24px;font-size:14px;line-height:1.5}input{width:100%;padding:14px;border-radius:8px;border:1px solid #333;background:#111;color:#fff;font-size:16px;margin-bottom:16px}input[type=file]{padding:10px;border:2px dashed #333;background:transparent}button{width:100%;padding:16px;background:#00e5ff;border:none;border-radius:8px;color:#000;font-weight:700;font-size:16px;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}.status{margin-top:16px;padding:12px;border-radius:8px;display:none}.status.success{display:block;background:#0a3d2e;color:#25D366}.status.error{display:block;background:#3d0a0a;color:#ff4444}.hint{color:#555;font-size:12px;margin-top:8px}</style></head>
<body><div class="card">
<h1>Upload Your Documents</h1>
<p>Send us your business logo, price list, menu, or any other documents Naledi needs to learn.</p>
<form id="uploadForm" enctype="multipart/form-data">
<input type="hidden" name="phone" value="${phone}">
<input type="text" name="name" placeholder="Your business name" required>
<input type="file" name="file" required>
<button type="submit" id="submitBtn">Upload</button>
</form>
<div id="status" class="status"></div>
<div class="hint">Accepted: PDF, Word, Excel, images (max 20MB)</div>
</div>
<script>
document.getElementById('uploadForm').onsubmit = async function(e) {
  e.preventDefault(); const btn=document.getElementById('submitBtn'); btn.disabled=true; btn.textContent='Uploading...';
  const fd = new FormData(this); const st=document.getElementById('status');
  try {
    const r=await fetch('/api/docs/upload',{method:'POST',body:fd}); const d=await r.json();
    if(d.status==='ok'){st.className='status success';st.textContent='Uploaded! We\'ll review your documents.';this.reset()}
    else{st.className='status error';st.textContent='Error: '+d.error}
  }catch(e){st.className='status error';st.textContent='Upload failed. Try again.'}
  btn.disabled=false; btn.textContent='Upload';
};
</script></body></html>`);
  });

  app.post('/api/docs/upload', async (c) => {
    try {
      const fd = await c.req.formData();
      const file = fd.get('file') as File | null;
      const phone = fd.get('phone') as string || 'unknown';
      const name = fd.get('name') as string || 'unknown';
      if (!file) return c.json({ error: 'File required' }, 400);
      if (file.size > 20_000_000) return c.json({ error: 'File too large (max 20MB)' }, 400);

      const key = `uploads/${phone}/${Date.now()}-${file.name}`;
      await c.env.DOCS.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type || 'application/octet-stream' },
        customMetadata: { businessName: name, phone, originalName: file.name }
      });

      await c.env.NALEDI_DB.prepare(
        "INSERT INTO outbox_messages (recipient, message, sender) VALUES (?, ?, 'naledi')"
      ).bind('27724971810',
        '📄 Docs uploaded by ' + name + ' (' + phone + ')\nFile: ' + file.name + '\nSize: ' + (file.size / 1024).toFixed(0) + 'KB'
      ).run().catch(() => {});

      return c.json({ status: 'ok', key });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.get('/api/docs/list', async (c) => {
    try {
      const phone = c.req.query('phone') || '';
      const prefix = phone ? `uploads/${phone}/` : 'uploads/';
      const objects = await c.env.DOCS.list({ prefix });
      const files = await Promise.all((objects.objects || []).map(async (o: any) => {
        const meta = o.customMetadata || {};
        return { key: o.key, size: o.size, uploaded: o.uploaded, name: meta.originalName || o.key.split('/').pop(), businessName: meta.businessName || '', phone: meta.phone || '' };
      }));
      return c.json({ status: 'ok', files });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });
}
