import { Hono } from 'hono';
import type { Bindings } from './helpers';
import { sanitizePhone } from './helpers';
import { sendWhatsAppMessage } from './cloud-api';

function md5hex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  return crypto.subtle.digest('MD5', encoder.encode(data)).then(buf => {
    const hash = Array.from(new Uint8Array(buf));
    return hash.map(b => b.toString(16).padStart(2, '0')).join('');
  });
}

async function verifyYocoSignature(rawBody: string, signature: string, secret: string): Promise<boolean> {
  if (!secret || !signature) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  try {
    const sigBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
    return await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(rawBody));
  } catch {
    return false;
  }
}

async function verifyStripeSignature(rawBody: string, signature: string, secret: string): Promise<boolean> {
  if (!secret || !signature) return false;
  const parts = signature.split(',');
  const tsPart = parts.find(p => p.startsWith('t='));
  const sigPart = parts.find(p => p.startsWith('v1='));
  if (!tsPart || !sigPart) return false;
  const timestamp = tsPart.slice(2);
  const expectedSig = sigPart.slice(3);
  const payload = `${timestamp}.${rawBody}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const computed = Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2, '0')).join('');
  return computed === expectedSig;
}

async function getOrCreateCustomer(db: D1Database, email: string | null, phone: string | null, name: string): Promise<{ id: number }> {
  if (email) {
    const existing = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: number }>();
    if (existing) return existing;
  }
  if (phone) {
    const existing = await db.prepare("SELECT id FROM users WHERE phone = ?").bind(phone).first<{ id: number }>();
    if (existing) return existing;
  }
  const newUser = await db.prepare(
    "INSERT INTO users (uuid, name, phone, email, auth_provider, is_active) VALUES (?, ?, ?, ?, 'checkout', 1) RETURNING id"
  ).bind(crypto.randomUUID(), name, phone || null, email || null).first<{ id: number }>();
  if (!newUser) throw new Error('Failed to create user');
  return newUser;
}

async function createPayment(
  db: D1Database,
  data: {
    customerId: number;
    invoiceId: string | null;
    subscriptionId: string | null;
    amountCents: number;
    currency: string;
    provider: string;
    providerPaymentId: string | null;
    providerChargeId: string | null;
    status: string;
    description: string;
    metadata: Record<string, unknown>;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO payments (id, invoice_id, customer_id, subscription_id, provider, provider_payment_id, provider_charge_id, amount_cents, currency, status, description, metadata_json, paid_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, data.invoiceId, data.customerId, data.subscriptionId,
    data.provider, data.providerPaymentId, data.providerChargeId,
    data.amountCents, data.currency, data.status,
    data.description, JSON.stringify(data.metadata),
    data.status === 'succeeded' ? now : null,
    now, now
  ).run();
  return id;
}

async function createInvoice(
  db: D1Database,
  data: {
    customerId: number;
    subscriptionId: string | null;
    totalCents: number;
    currency: string;
    billingReason: string;
    description: string;
    provider: string;
    providerPaymentId: string | null;
    status: string;
  }
): Promise<{ id: string; invoiceNumber: string; isNew: boolean }> {
  if (data.providerPaymentId) {
    const existing = await db.prepare(
      "SELECT id, status FROM invoices WHERE id IN (SELECT invoice_id FROM payments WHERE provider_payment_id = ? AND provider = ?)"
    ).bind(data.providerPaymentId, data.provider).first<{ id: string; status: string }>();
    if (existing) {
      if (existing.status !== data.status) {
        await db.prepare("UPDATE invoices SET status = ?, updated_at = ? WHERE id = ?").bind(data.status, new Date().toISOString(), existing.id).run();
      }
      return { id: existing.id, invoiceNumber: '', isNew: false };
    }
  }

  const id = crypto.randomUUID();
  const invNumber = `INV-${Date.now().toString(36).toUpperCase()}`;
  const taxCents = Math.round(data.totalCents * 15 / 115); // SA VAT 15% included
  const subtotalCents = data.totalCents - taxCents;
  const now = new Date().toISOString();

  await db.prepare(
    `INSERT INTO invoices (id, subscription_id, customer_id, invoice_number, status, subtotal_cents, tax_cents, total_cents, amount_paid_cents, amount_remaining_cents, currency, billing_reason, metadata_json, paid_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, data.subscriptionId, data.customerId, invNumber,
    data.status, subtotalCents, taxCents, data.totalCents,
    data.status === 'paid' ? data.totalCents : 0,
    data.status === 'paid' ? 0 : data.totalCents,
    data.currency || 'ZAR', data.billingReason,
    JSON.stringify({ description: data.description }),
    data.status === 'paid' ? now : null,
    now, now
  ).run();

  await db.prepare(
    `INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price_cents, total_cents, type)
     VALUES (?, ?, ?, 1, ?, ?, 'plan')`
  ).bind(crypto.randomUUID(), id, data.description, data.totalCents, data.totalCents).run();

  return { id, invoiceNumber: invNumber, isNew: true };
}

async function recordLedger(
  db: D1Database,
  data: {
    customerId: number;
    invoiceId: string | null;
    paymentId: string | null;
    amountCents: number;
    currency: string;
    description: string;
    reference: string;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO transaction_ledger (id, customer_id, entry_type, amount_cents, currency, balance_after_cents, invoice_id, payment_id, description, reference, metadata_json, created_at)
     VALUES (?, ?, 'credit', ?, ?, ?, ?, ?, ?, ?, '{}', ?)`
  ).bind(
    id, data.customerId, data.amountCents, data.currency, data.amountCents,
    data.invoiceId, data.paymentId, data.description, data.reference,
    new Date().toISOString()
  ).run();
  return id;
}

async function notifyGraham(env: Bindings, message: string): Promise<void> {
  await sendWhatsAppMessage(env, '27724971810', message).catch(() => {});
}

async function notifyCustomer(env: Bindings, phone: string, message: string): Promise<void> {
  await sendWhatsAppMessage(env, sanitizePhone(phone), message).catch(() => {});
}

export function register(app: Hono<{ Bindings: Bindings }>) {

  // ── Pricing Plans ──
  app.get('/api/plans', async (c) => {
    try {
      const rows = await c.env.DB.prepare(
        "SELECT id, name, description, amount_cents, currency, billing_interval, trial_days, is_active, features_json, metadata_json, created_at FROM pricing_plans WHERE is_active = 1 ORDER BY sort_order ASC"
      ).all<any>();
      return c.json({ status: 'success', plans: rows.results || [] });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ── Create Checkout Session ──
  app.post('/api/checkout/session', async (c) => {
    try {
      const { planId, customerName, customerEmail, customerPhone } = await c.req.json();
      if (!planId || !customerName) {
        return c.json({ error: 'planId and customerName required' }, 400);
      }

      const plan = await c.env.DB.prepare(
        "SELECT * FROM pricing_plans WHERE id = ? AND is_active = 1"
      ).bind(planId).first<any>();
      if (!plan) return c.json({ error: 'Plan not found' }, 404);

      const customer = await getOrCreateCustomer(c.env.DB, customerEmail || null, customerPhone || null, customerName);

      const subscriptionId = crypto.randomUUID();
      const now = new Date();
      const periodEnd = new Date(now);
      periodEnd.setMonth(periodEnd.getMonth() + 1);

      await c.env.DB.prepare(
        `INSERT INTO subscriptions (id, customer_id, plan_id, status, current_period_start, current_period_end, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, 'trialing', ?, ?, ?, ?, ?)`
      ).bind(
        subscriptionId, customer.id, plan.id,
        now.toISOString(), periodEnd.toISOString(),
        JSON.stringify({ customer_name: customerName }),
        now.toISOString(), now.toISOString()
      ).run();

      return c.json({
        status: 'success',
        subscriptionId,
        plan: { id: plan.id, name: plan.name, amount_cents: plan.amount_cents, currency: plan.currency },
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ── Get Subscription ──
  app.get('/api/subscriptions/:id', async (c) => {
    try {
      const sub = await c.env.DB.prepare(
        `SELECT s.*, p.name as plan_name, p.description as plan_description, p.amount_cents as plan_amount_cents, u.name as customer_name, u.email as customer_email
         FROM subscriptions s
         LEFT JOIN pricing_plans p ON s.plan_id = p.id
         LEFT JOIN users u ON s.customer_id = u.id
         WHERE s.id = ?`
      ).bind(c.req.param('id')).first();
      if (!sub) return c.json({ error: 'Not found' }, 404);
      return c.json({ status: 'success', subscription: sub });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ── List Subscriptions ──
  app.get('/api/subscriptions', async (c) => {
    try {
      const email = c.req.query('email');
      const phone = c.req.query('phone');
      const customerId = c.req.query('customer_id');
      let query = `SELECT s.*, p.name as plan_name, u.name as customer_name, u.email as customer_email
                   FROM subscriptions s
                   LEFT JOIN pricing_plans p ON s.plan_id = p.id
                   LEFT JOIN users u ON s.customer_id = u.id
                   WHERE 1=1`;
      const params: any[] = [];
      if (email) { query += " AND u.email = ?"; params.push(email); }
      if (phone) { query += " AND u.phone = ?"; params.push(phone); }
      if (customerId) { query += " AND s.customer_id = ?"; params.push(parseInt(customerId)); }
      query += " ORDER BY s.created_at DESC LIMIT 50";
      const rows = await c.env.DB.prepare(query).bind(...params).all<any>();
      return c.json({ status: 'success', subscriptions: rows.results || [] });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ── Update Subscription (cancel/pause/resume) ──
  app.patch('/api/subscriptions/:id', async (c) => {
    try {
      const { status, cancelAtPeriodEnd } = await c.req.json();
      const subId = c.req.param('id');
      const updates: string[] = [];
      const vals: any[] = [];
      const now = new Date().toISOString();
      if (status) { updates.push('status = ?'); vals.push(status); }
      if (cancelAtPeriodEnd !== undefined) { updates.push('cancel_at_period_end = ?'); vals.push(cancelAtPeriodEnd ? 1 : 0); }
      if (updates.length === 0) return c.json({ error: 'Nothing to update' }, 400);
      updates.push('updated_at = ?');
      vals.push(now);
      vals.push(subId);
      await c.env.DB.prepare(`UPDATE subscriptions SET ${updates.join(', ')} WHERE id = ?`).bind(...vals).run();

      // Write to history
      await c.env.DB.prepare(
        `INSERT INTO subscription_history (id, subscription_id, previous_status, new_status, change_reason, changed_by, metadata_json, created_at)
         VALUES (?, ?, (SELECT status FROM subscriptions WHERE id = ?), ?, 'api_update', 'system', '{}', ?)`
      ).bind(crypto.randomUUID(), subId, subId, status || 'updated', now).run().catch(() => {});

      if (status === 'cancelled') {
        await notifyGraham(c.env, `Subscription ${subId.slice(0, 8)}... cancelled.`);
      }
      return c.json({ status: 'success' });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ── Get Invoice ──
  app.get('/api/invoices/:id', async (c) => {
    try {
      const invoice = await c.env.DB.prepare(
        `SELECT i.*, u.name as customer_name, u.email as customer_email
         FROM invoices i LEFT JOIN users u ON i.customer_id = u.id WHERE i.id = ?`
      ).bind(c.req.param('id')).first();
      if (!invoice) return c.json({ error: 'Not found' }, 404);
      const items = await c.env.DB.prepare("SELECT * FROM invoice_items WHERE invoice_id = ?").bind(c.req.param('id')).all<any>();
      const payments = await c.env.DB.prepare(
        "SELECT * FROM payments WHERE invoice_id = ? ORDER BY created_at DESC"
      ).bind(c.req.param('id')).all<any>();
      return c.json({ status: 'success', invoice, items: items.results || [], payments: payments.results || [] });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ── List Invoices ──
  app.get('/api/invoices', async (c) => {
    try {
      const subId = c.req.query('subscription_id');
      const email = c.req.query('email');
      const customerId = c.req.query('customer_id');
      let query = `SELECT i.*, u.name as customer_name, u.email as customer_email
                   FROM invoices i LEFT JOIN users u ON i.customer_id = u.id WHERE 1=1`;
      const params: any[] = [];
      if (subId) { query += " AND i.subscription_id = ?"; params.push(subId); }
      if (email) { query += " AND u.email = ?"; params.push(email); }
      if (customerId) { query += " AND i.customer_id = ?"; params.push(parseInt(customerId)); }
      query += " ORDER BY i.created_at DESC LIMIT 50";
      const rows = await c.env.DB.prepare(query).bind(...params).all<any>();
      return c.json({ status: 'success', invoices: rows.results || [] });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ── Yoco Webhook ──
  app.post('/api/yoco-webhook', async (c) => {
    try {
      const rawBody = await c.req.raw.clone().text();
      const signature = c.req.header('webhook-signature') || '';
      const secret = c.env.YOCO_LIVE_SK || '';

      if (!(await verifyYocoSignature(rawBody, signature, secret))) {
        console.error('Yoco webhook: invalid signature');
        return c.json({ error: 'Invalid signature' }, 401);
      }

      const payload = JSON.parse(rawBody);
      if (payload.event_type !== 'payment.created') {
        return c.json({ status: 'ignored', event: payload.event_type });
      }

      // Dedup
      const dupCheck = await c.env.DB.prepare(
        "SELECT id FROM processed_webhook_events WHERE provider = 'yoco' AND provider_event_id = ?"
      ).bind(payload.id || payload.payment_id).first();
      if (dupCheck) return c.json({ status: 'duplicate' });
      await c.env.DB.prepare(
        "INSERT INTO processed_webhook_events (id, provider, provider_event_id, event_type, status, processed_at) VALUES (?, 'yoco', ?, ?, 'processed', ?)"
      ).bind(crypto.randomUUID(), payload.id || payload.payment_id, payload.event_type, new Date().toISOString()).run();

      const checkoutRes = await fetch(`https://payments.yoco.com/api/checkouts/${payload.order_id}`, {
        headers: { 'Authorization': `Bearer ${secret}` }
      });
      const checkout = await checkoutRes.json() as any;
      const amountCents = checkout.amount || 0;
      const meta = checkout.metadata || {};
      const customerName = meta.customerName || meta.customer_name || 'Customer';
      const customerEmail = meta.customerEmail || meta.customer_email || null;
      const customerPhone = meta.customerPhone || meta.customer_phone || null;

      const customer = await getOrCreateCustomer(c.env.DB, customerEmail, customerPhone, customerName);

      const inv = await createInvoice(c.env.DB, {
        customerId: customer.id,
        subscriptionId: null,
        totalCents: amountCents,
        currency: checkout.currency || 'ZAR',
        billingReason: 'upfront',
        description: `Yoco payment — ${checkout.name || 'Naledi'}`,
        provider: 'yoco',
        providerPaymentId: payload.payment_id,
        status: 'paid',
      });

      const paymentId = await createPayment(c.env.DB, {
        customerId: customer.id,
        invoiceId: inv.id,
        subscriptionId: null,
        amountCents,
        currency: checkout.currency || 'ZAR',
        provider: 'yoco',
        providerPaymentId: payload.payment_id,
        providerChargeId: payload.order_id,
        status: 'succeeded',
        description: `Yoco payment: ${customerName}`,
        metadata: meta,
      });

      await recordLedger(c.env.DB, {
        customerId: customer.id,
        invoiceId: inv.id,
        paymentId,
        amountCents,
        currency: 'ZAR',
        description: `Yoco payment: ${customerName}`,
        reference: payload.payment_id,
      });

      // WhatsApp notifications
      if (customerPhone) {
        await notifyCustomer(c.env, customerPhone,
          `Hi ${customerName}! Welcome to Naledi.\n\nWe received your payment.\n1. We will WhatsApp you within 1 hour\n2. We configure your practice\n3. Naledi goes live within 48 hours\n\n— The Orion Team`
        );
      }
      await notifyGraham(c.env,
        `New payment received!\nCustomer: ${customerName}\nPhone: ${customerPhone || 'none'}\nAmount: R${(amountCents / 100).toFixed(2)}\nYoco Order: ${payload.order_id}\nSetup Naledi now!`
      );

      // Legacy backward compat
      await c.env.NALEDI_DB.prepare(
        `INSERT INTO payments (yoco_payment_id, yoco_order_id, business_id, amount_in_cents, currency, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(payload.payment_id, payload.order_id, payload.business_id, amountCents, checkout.currency || 'ZAR', JSON.stringify(meta)).run().catch(() => {});

      return c.json({ status: 'ok' }, 200);
    } catch (err: any) {
      console.error('Yoco webhook error:', err);
      return c.json({ status: 'error' }, 500);
    }
  });

  // ── PayFast ITN ──
  app.post('/api/payfast/itn', async (c) => {
    try {
      const formData = await c.req.parseBody<Record<string, string>>();
      const pfData: Record<string, string> = {};
      const receivedSignature = formData['signature'] || '';
      for (const [key, value] of Object.entries(formData)) {
        if (key !== 'signature') pfData[key] = typeof value === 'string' ? value : '';
      }

      const sortedKeys = Object.keys(pfData).sort();
      let sigString = sortedKeys.map(key => `${key}=${pfData[key]}`).join('&');
      const passphrase = c.env.PAYFAST_PASSPHRASE || '';
      if (passphrase) sigString += `&passphrase=${passphrase}`;
      const calculatedSignature = await md5hex(sigString);
      if (calculatedSignature !== receivedSignature) {
        console.error('PayFast ITN signature mismatch');
        return c.text('INVALID SIGNATURE', 403);
      }

      const isSandbox = (c.env.PAYFAST_SANDBOX || 'true') === 'true';
      const validateUrl = isSandbox ? 'https://sandbox.payfast.co.za/itr?test=1' : 'https://www.payfast.co.za/itr';
      const postBody = [...Object.entries(formData)].map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
      const validateResponse = await fetch(validateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: postBody,
      });
      const validateText = await validateResponse.text();
      if (!validateText.includes('VALID')) {
        console.error('PayFast ITN validation failed:', validateText);
        return c.text('INVALID', 403);
      }

      const paymentStatus = pfData['payment_status'] || '';
      if (paymentStatus !== 'COMPLETE') {
        return c.text('OK');
      }

      const amountGross = pfData['amount_gross'] ? parseFloat(pfData['amount_gross']) : 0;
      const amountCents = Math.round(amountGross * 100);
      const name = `${pfData['name_first'] || ''} ${pfData['name_last'] || ''}`.trim() || 'Customer';
      const email = pfData['email_address'] || null;
      const phone = pfData['custom_str1'] || null;
      const pfPaymentId = pfData['pf_payment_id'] || null;

      // Dedup
      if (pfPaymentId) {
        const dupCheck = await c.env.DB.prepare(
          "SELECT id FROM processed_webhook_events WHERE provider = 'payfast' AND provider_event_id = ?"
        ).bind(pfPaymentId).first();
        if (dupCheck) return c.text('OK');
        await c.env.DB.prepare(
          "INSERT INTO processed_webhook_events (id, provider, provider_event_id, event_type, status, processed_at) VALUES (?, 'payfast', ?, 'payment.complete', 'processed', ?)"
        ).bind(crypto.randomUUID(), pfPaymentId, new Date().toISOString()).run();
      }

      const customer = await getOrCreateCustomer(c.env.DB, email, phone, name);

      const inv = await createInvoice(c.env.DB, {
        customerId: customer.id,
        subscriptionId: null,
        totalCents: amountCents,
        currency: 'ZAR',
        billingReason: 'upfront',
        description: `PayFast payment — ${pfData['item_name'] || 'Naledi'}`,
        provider: 'payfast',
        providerPaymentId: pfPaymentId,
        status: 'paid',
      });

      const paymentId = await createPayment(c.env.DB, {
        customerId: customer.id,
        invoiceId: inv.id,
        subscriptionId: null,
        amountCents,
        currency: 'ZAR',
        provider: 'payfast',
        providerPaymentId: pfPaymentId,
        providerChargeId: null,
        status: 'succeeded',
        description: `PayFast payment: ${name}`,
        metadata: pfData,
      });

      await recordLedger(c.env.DB, {
        customerId: customer.id,
        invoiceId: inv.id,
        paymentId,
        amountCents,
        currency: 'ZAR',
        description: `PayFast payment: ${name}`,
        reference: pfPaymentId || '',
      });

      // Legacy backward compat
      await c.env.NALEDI_DB.prepare(
        `INSERT INTO payfast_transactions (pf_payment_id, payment_status, amount_gross, amount_fee, amount_net, name_first, name_last, email_address, merchant_id, item_name, item_description, custom_str1, custom_str2, custom_str3, raw_data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        pfPaymentId, paymentStatus, amountGross,
        pfData['amount_fee'] ? parseFloat(pfData['amount_fee']) : null,
        pfData['amount_net'] ? parseFloat(pfData['amount_net']) : null,
        pfData['name_first'] || null, pfData['name_last'] || null,
        pfData['email_address'] || null, pfData['merchant_id'] || null,
        pfData['item_name'] || null, pfData['item_description'] || null,
        pfData['custom_str1'] || null, pfData['custom_str2'] || null, pfData['custom_str3'] || null,
        JSON.stringify(pfData)
      ).run().catch(() => {});

      return c.text('OK');
    } catch (err: any) {
      console.error('PayFast ITN error:', err);
      return c.text('ERROR', 500);
    }
  });

  // ── PayFast Health ──
  app.get('/api/payfast/test', (c) => {
    return c.json({ status: 'PayFast ITN handler active' });
  });

  // ── Stripe Webhook ──
  app.post('/api/stripe/webhook', async (c) => {
    try {
      const rawBody = await c.req.raw.clone().text();
      const signature = c.req.header('stripe-signature') || '';
      const secret = c.env.STRIPE_WEBHOOK_SECRET || '';
      if (!secret) return c.json({ error: 'Stripe not configured' }, 503);

      if (!(await verifyStripeSignature(rawBody, signature, secret))) {
        return c.json({ error: 'Invalid signature' }, 401);
      }

      const event = JSON.parse(rawBody);
      const eventType = event.type;

      const existing = await c.env.DB.prepare(
        "SELECT id FROM processed_webhook_events WHERE provider = 'stripe' AND provider_event_id = ?"
      ).bind(event.id).first();
      if (existing) return c.json({ status: 'duplicate' });
      await c.env.DB.prepare(
        "INSERT INTO processed_webhook_events (id, provider, provider_event_id, event_type, status, processed_at) VALUES (?, 'stripe', ?, ?, 'processed', ?)"
      ).bind(crypto.randomUUID(), event.id, eventType, new Date().toISOString()).run();

      const data = event.data?.object || {};

      if (eventType === 'checkout.session.completed') {
        const session = data;
        const customerName = session.customer_details?.name || session.customer_email?.split('@')[0] || 'Customer';
        const customerEmail = session.customer_details?.email || session.customer_email || null;
        const customerPhone = session.customer_details?.phone || null;
        const amountCents = session.amount_total || 0;

        const customer = await getOrCreateCustomer(c.env.DB, customerEmail, customerPhone, customerName);

        const inv = await createInvoice(c.env.DB, {
          customerId: customer.id,
          subscriptionId: session.subscription || null,
          totalCents: amountCents,
          currency: (session.currency || 'zar').toUpperCase(),
          billingReason: 'upfront',
          description: 'Stripe checkout',
          provider: 'stripe',
          providerPaymentId: session.payment_intent,
          status: 'paid',
        });

        await createPayment(c.env.DB, {
          customerId: customer.id,
          invoiceId: inv.id,
          subscriptionId: session.subscription || null,
          amountCents,
          currency: (session.currency || 'zar').toUpperCase(),
          provider: 'stripe',
          providerPaymentId: session.payment_intent,
          providerChargeId: session.id,
          status: 'succeeded',
          description: `Stripe payment: ${customerName}`,
          metadata: { stripe_session_id: session.id },
        });

        await recordLedger(c.env.DB, {
          customerId: customer.id,
          invoiceId: inv.id,
          paymentId: null,
          amountCents,
          currency: 'ZAR',
          description: `Stripe payment: ${customerName}`,
          reference: session.payment_intent || '',
        });

        if (customerPhone) {
          await notifyCustomer(c.env, customerPhone,
            `Hi ${customerName}! Welcome to Naledi.\n\nWe received your payment. We'll be in touch within 1 hour.`
          );
        }
        await notifyGraham(c.env,
          `New Stripe payment!\nCustomer: ${customerName}\nEmail: ${customerEmail || 'none'}\nAmount: R${(amountCents / 100).toFixed(2)}`
        );
      }

      if (eventType === 'invoice.paid') {
        const inv = data;
        if (inv.payment_intent) {
          await c.env.DB.prepare("UPDATE invoices SET status = 'paid', paid_at = ?, updated_at = ? WHERE invoice_number = ?")
            .bind(new Date().toISOString(), new Date().toISOString(), inv.number || inv.id).run();
        }
      }

      if (eventType === 'invoice.payment_failed') {
        const inv = data;
        const subId = inv.subscription;
        if (subId) {
          await c.env.DB.prepare("UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), subId).run();
          await c.env.DB.prepare(
            `INSERT INTO dunning_attempts (id, subscription_id, invoice_id, attempt_number, status, response_json)
             VALUES (?, ?, (SELECT id FROM invoices WHERE gateway_payment_id = ? OR id = ? LIMIT 1), 1, 'failed', ?)`
          ).bind(crypto.randomUUID(), subId, inv.payment_intent || '', inv.id || '', JSON.stringify(inv)).run().catch(() => {});
        }
      }

      return c.json({ status: 'ok' });
    } catch (err: any) {
      console.error('Stripe webhook error:', err);
      return c.json({ status: 'error' }, 500);
    }
  });

  // ── Yoco Inline Payment ──
  app.post('/api/yoco/pay', async (c) => {
    try {
      const { token, amount_cents, currency, metadata } = await c.req.json();
      if (!token || !amount_cents) return c.json({ error: 'token and amount_cents required' }, 400);

      const amtCents = typeof amount_cents === 'number' ? amount_cents : parseInt(amount_cents, 10);
      const secret = c.env.YOCO_LIVE_SK || '';
      const chargeRes = await fetch('https://payments.yoco.com/api/charges', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token, amountInCents: amtCents, currency: currency || 'ZAR', metadata: metadata || {} }),
      });

      const charge = await chargeRes.json() as any;
      if (!chargeRes.ok) {
        return c.json({ success: false, error: charge.displayMessage || charge.message || 'Charge failed' }, 200);
      }

      const customerName = metadata?.customerName || 'Customer';
      const customerEmail = metadata?.customerEmail || null;
      const customerPhone = metadata?.customerPhone || null;
      const customer = await getOrCreateCustomer(c.env.DB, customerEmail, customerPhone, customerName);

      const inv = await createInvoice(c.env.DB, {
        customerId: customer.id,
        subscriptionId: null,
        totalCents: amtCents,
        currency: 'ZAR',
        billingReason: 'upfront',
        description: 'Yoco inline payment',
        provider: 'yoco',
        providerPaymentId: charge.id,
        status: 'paid',
      });

      await createPayment(c.env.DB, {
        customerId: customer.id,
        invoiceId: inv.id,
        subscriptionId: null,
        amountCents: amtCents,
        currency: 'ZAR',
        provider: 'yoco',
        providerPaymentId: charge.id,
        providerChargeId: charge.id,
        status: 'succeeded',
        description: `Yoco inline: ${customerName}`,
        metadata: metadata || {},
      });

      await recordLedger(c.env.DB, {
        customerId: customer.id,
        invoiceId: inv.id,
        paymentId: null,
        amountCents: amtCents,
        currency: 'ZAR',
        description: `Yoco inline: ${customerName}`,
        reference: charge.id,
      });

      return c.json({ success: true, chargeId: charge.id, invoiceId: inv.id });
    } catch (e: any) {
      return c.json({ success: false, error: e.message }, 200);
    }
  });

  // ── Billing Cron ──
  app.post('/api/billing/cron', async (c) => {
    try {
      const key = c.req.query('key') || '';
      const expected = (c.env as any).BILLING_CRON_KEY || '';
      if (expected && key !== expected) return c.json({ error: 'Unauthorized' }, 403);

      const results = { generated: 0, dunning: 0, expired: 0 };
      const now = new Date();
      const nowStr = now.toISOString();
      const yesterdayStr = new Date(now.getTime() - 86400000).toISOString();

      // Find subscriptions renewing today
      const renewing = await c.env.DB.prepare(
        "SELECT s.*, p.amount_cents, p.currency, p.name as plan_name FROM subscriptions s LEFT JOIN pricing_plans p ON s.plan_id = p.id WHERE s.status = 'active' AND s.current_period_end <= ? AND s.current_period_end > ?"
      ).bind(nowStr, yesterdayStr).all<any>();

      for (const sub of renewing.results || []) {
        const periodStart = new Date(sub.current_period_end);
        const periodEnd = new Date(periodStart);
        periodEnd.setMonth(periodEnd.getMonth() + 1);

        const invId = crypto.randomUUID();
        const invNumber = `INV-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        const totalCents = sub.amount_cents || 0;
        const taxCents = Math.round(totalCents * 15 / 115);
        const subtotalCents = totalCents - taxCents;

        await c.env.DB.prepare(
          `INSERT INTO invoices (id, subscription_id, customer_id, invoice_number, status, subtotal_cents, tax_cents, total_cents, amount_paid_cents, amount_remaining_cents, currency, billing_reason, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'open', ?, ?, ?, 0, ?, ?, 'subscription_cycle', '{}', ?, ?)`
        ).bind(
          invId, sub.id, sub.customer_id, invNumber,
          subtotalCents, taxCents, totalCents, totalCents,
          sub.currency || 'ZAR', nowStr, nowStr
        ).run();

        await c.env.DB.prepare(
          `INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price_cents, total_cents, type)
           VALUES (?, ?, ?, 1, ?, ?, 'plan')`
        ).bind(crypto.randomUUID(), invId, `${sub.plan_name || sub.plan_id} — renewal`, totalCents, totalCents).run();

        results.generated++;
      }

      // Dunning
      const pastDue = await c.env.DB.prepare(
        "SELECT * FROM subscriptions WHERE status = 'past_due'"
      ).all<any>();

      for (const sub of pastDue.results || []) {
        const attempts = await c.env.DB.prepare(
          "SELECT COUNT(*) as count FROM dunning_attempts WHERE subscription_id = ?"
        ).bind(sub.id).first<{ count: number }>();

        const attemptCount = attempts?.count || 0;
        if (attemptCount >= 5) {
          await c.env.DB.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE id = ?")
            .bind(nowStr, sub.id).run();
          results.expired++;
        }
        // In real cron, we'd retry payment here
        results.dunning++;
      }

      return c.json({ status: 'ok', results, as_of: nowStr });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });
}
