import type { Bindings } from './helpers';

export async function sendWhatsAppMessage(
  env: Bindings,
  to: string,
  text: string
): Promise<{ success: boolean; error?: string }> {
  const token = (env as any).META_CLOUD_API_TOKEN;
  const phoneNumberId = (env as any).META_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    return { success: false, error: 'META_CLOUD_API_TOKEN or META_PHONE_NUMBER_ID not set' };
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: to.replace('+', ''),
          type: 'text',
          text: { body: text },
        }),
      }
    );

    const data = await res.json();

    if (res.ok) {
      return { success: true };
    }

    return { success: false, error: data.error?.message || 'Meta API error' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function processOutbox(env: Bindings): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  const messages = await env.NALEDI_DB.prepare(
    "SELECT id, recipient, message FROM outbox_messages WHERE status = 'pending' ORDER BY created_at ASC LIMIT 10"
  ).all<any>();

  for (const msg of messages.results || []) {
    const result = await sendWhatsAppMessage(env, msg.recipient, msg.message);
    if (result.success) {
      await env.NALEDI_DB.prepare("UPDATE outbox_messages SET status = 'sent' WHERE id = ?").bind(msg.id).run();
      sent++;
    } else {
      await env.NALEDI_DB.prepare("UPDATE outbox_messages SET status = 'failed', notes = ? WHERE id = ?").bind(result.error || 'Send failed', msg.id).run();
      failed++;
    }
  }

  return { sent, failed };
}
