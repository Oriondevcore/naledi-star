import type { Bindings, Env } from './helpers';

export interface ClientInfo {
  id: string;
  name: string;
  phone: string;
  plan: string;
  status: string;
  monthly_base_fee_cents: number;
  wallet_balance_cents: number;
  system_prompt: string | null;
}

export interface FeatureStatus {
  ok: boolean;
  enabled: boolean;
  current: number;
  cap: number;
  feature_key: string;
  reason?: string;
}

export interface UsageCost {
  input_units: number;
  output_units: number;
  input_cost_cents: number;
  output_cost_cents: number;
  total_cost_cents: number;
}

export async function lookupClientByPhone(
  env: Bindings,
  phone: string
): Promise<ClientInfo | null> {
  try {
    const client = await env.NALEDI_DB.prepare(
      `SELECT id, name, phone, plan, status, monthly_base_fee_cents, wallet_balance_cents, system_prompt
       FROM clients WHERE (phone = ? OR test_number = ?) AND status = 'active'`
    ).bind(phone, phone).first<ClientInfo>();
    return client || null;
  } catch {
    return null;
  }
}

export async function checkFeatureCap(
  env: Bindings,
  clientId: string,
  featureKey: string
): Promise<FeatureStatus> {
  try {
    const billingPeriod = getBillingPeriod();
    const row = await env.NALEDI_DB.prepare(
      `SELECT enabled, current_usage, monthly_cap, feature_key
       FROM client_features
       WHERE client_id = ? AND feature_key = ? AND billing_period = ?`
    ).bind(clientId, featureKey, billingPeriod).first<{ enabled: number; current_usage: number; monthly_cap: number; feature_key: string }>();

    if (!row || !row.enabled) {
      return { ok: false, enabled: false, current: 0, cap: 0, feature_key: featureKey, reason: 'feature_disabled' };
    }

    if (row.current_usage >= row.monthly_cap) {
      return { ok: false, enabled: true, current: row.current_usage, cap: row.monthly_cap, feature_key: featureKey, reason: 'cap_reached' };
    }

    return { ok: true, enabled: true, current: row.current_usage, cap: row.monthly_cap, feature_key: featureKey };
  } catch {
    return { ok: false, enabled: false, current: 0, cap: 0, feature_key: featureKey, reason: 'error' };
  }
}

export async function logUsage(
  env: Bindings,
  clientId: string,
  featureKey: string,
  model: string,
  costs: UsageCost,
  requestPhone?: string,
  responseText?: string
): Promise<void> {
  try {
    const id = crypto.randomUUID();
    const billingPeriod = getBillingPeriod();

    await env.NALEDI_DB.prepare(
      `INSERT INTO usage_log (id, client_id, feature_key, model, input_units, output_units, input_cost_cents, output_cost_cents, total_cost_cents, request_phone, response_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, clientId, featureKey, model,
      costs.input_units, costs.output_units,
      costs.input_cost_cents, costs.output_cost_cents,
      costs.total_cost_cents,
      requestPhone || null, responseText || null
    ).run();

    await env.NALEDI_DB.prepare(
      `UPDATE client_features
       SET current_usage = current_usage + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE client_id = ? AND feature_key = ? AND billing_period = ?`
    ).bind(costs.total_cost_cents > 0 ? 1 : 0, clientId, featureKey, billingPeriod).run();
  } catch (e) {
    console.error('Usage logging failed:', e);
  }
}

export async function incrementClientUsage(
  env: Bindings,
  clientId: string,
  featureKey: string
): Promise<void> {
  try {
    const billingPeriod = getBillingPeriod();
    await env.NALEDI_DB.prepare(
      `UPDATE client_features
       SET current_usage = current_usage + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE client_id = ? AND feature_key = ? AND billing_period = ?`
    ).bind(clientId, featureKey, billingPeriod).run();
  } catch {}
}

export async function getClientUsageStats(
  env: Bindings,
  clientId: string,
  billingPeriod?: string
): Promise<any[]> {
  try {
    const period = billingPeriod || getBillingPeriod();
    const rows = await env.NALEDI_DB.prepare(
      `SELECT feature_key, enabled, current_usage, monthly_cap
       FROM client_features
       WHERE client_id = ? AND billing_period = ?
       ORDER BY feature_key`
    ).bind(clientId, period).all<any>();
    return rows.results || [];
  } catch {
    return [];
  }
}

export async function getAllClients(env: Bindings): Promise<any[]> {
  try {
    const rows = await env.NALEDI_DB.prepare(
      `SELECT c.id, c.name, c.phone, c.plan, c.status, c.monthly_base_fee_cents, c.wallet_balance_cents, c.created_at,
              COALESCE(SUM(ul.total_cost_cents), 0) as month_cost
       FROM clients c
       LEFT JOIN usage_log ul ON ul.client_id = c.id AND ul.created_at >= strftime('%Y-%m-01T00:00:00Z', 'now')
       GROUP BY c.id
       ORDER BY c.created_at DESC`
    ).all<any>();
    return rows.results || [];
  } catch {
    return [];
  }
}

export async function getGlobalUsageSummary(env: Bindings): Promise<any> {
  try {
    const totalUsage = await env.NALEDI_DB.prepare(
      `SELECT COUNT(*) as total_calls, COALESCE(SUM(total_cost_cents), 0) as total_cost_cents
       FROM usage_log WHERE created_at >= strftime('%Y-%m-01T00:00:00Z', 'now')`
    ).first<any>();

    const featureBreakdown = await env.NALEDI_DB.prepare(
      `SELECT feature_key, COUNT(*) as calls, COALESCE(SUM(total_cost_cents), 0) as cost_cents
       FROM usage_log WHERE created_at >= strftime('%Y-%m-01T00:00:00Z', 'now')
       GROUP BY feature_key ORDER BY cost_cents DESC`
    ).all<any>();

    return {
      total_calls: totalUsage?.total_calls || 0,
      total_cost_cents: totalUsage?.total_cost_cents || 0,
      feature_breakdown: featureBreakdown.results || [],
    };
  } catch {
    return { total_calls: 0, total_cost_cents: 0, feature_breakdown: [] };
  }
}

export async function setFeature(
  env: Bindings,
  clientId: string,
  featureKey: string,
  enabled: boolean,
  monthlyCap?: number
): Promise<boolean> {
  try {
    const billingPeriod = getBillingPeriod();
    const existing = await env.NALEDI_DB.prepare(
      `SELECT id FROM client_features WHERE client_id = ? AND feature_key = ? AND billing_period = ?`
    ).bind(clientId, featureKey, billingPeriod).first<any>();

    if (existing) {
      await env.NALEDI_DB.prepare(
        `UPDATE client_features SET enabled = ?, monthly_cap = COALESCE(?, monthly_cap), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE client_id = ? AND feature_key = ? AND billing_period = ?`
      ).bind(enabled ? 1 : 0, monthlyCap || null, clientId, featureKey, billingPeriod).run();
    } else {
      await env.NALEDI_DB.prepare(
        `INSERT INTO client_features (id, client_id, feature_key, enabled, monthly_cap, current_usage, billing_period)
         VALUES (?, ?, ?, ?, ?, 0, ?)`
      ).bind(crypto.randomUUID(), clientId, featureKey, enabled ? 1 : 0, monthlyCap || 0, billingPeriod).run();
    }
    return true;
  } catch {
    return false;
  }
}

export async function addTransaction(
  env: Bindings,
  clientId: string,
  type: string,
  amountCents: number,
  description: string,
  reference?: string
): Promise<boolean> {
  try {
    const id = crypto.randomUUID();
    await env.NALEDI_DB.prepare(
      `INSERT INTO transactions (id, client_id, type, amount_cents, description, reference)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, clientId, type, amountCents, description, reference || null).run();

    if (type === 'deposit') {
      await env.NALEDI_DB.prepare(
        `UPDATE clients SET wallet_balance_cents = wallet_balance_cents + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`
      ).bind(amountCents, clientId).run();
    }
    return true;
  } catch {
    return false;
  }
}

function getBillingPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
