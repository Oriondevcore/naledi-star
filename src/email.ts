const FROM_EMAIL = { email: 'info@oriondevcore.com', name: 'Orion Dev Core' };
const GRAHAM_EMAIL = 'graham@oriondevcore.com';

export async function sendOrderConfirmation(env: any, to: string, customerName: string, planName: string, amount: string) {
  try {
    await env.EMAIL.send({
      to,
      from: FROM_EMAIL,
      subject: 'Your Orion PRO Order Confirmation',
      html: `<div style="font-family:sans-serif;max-width:600px;margin:auto">
        <h1 style="color:#000">Order Confirmed!</h1>
        <p>Hi ${customerName},</p>
        <p>Your <strong>${planName}</strong> plan (${amount}) has been received.</p>
        <h2>What happens next:</h2>
        <ol>
          <li>We'll WhatsApp you within 2 hours to schedule your setup call</li>
          <li>Send us your business name, logo, and price list PDF</li>
          <li>We train Naledi on your business (1-3 business days)</li>
          <li>You go live!</li>
        </ol>
        <p style="color:#666;font-size:14px">Questions? Reply to the WhatsApp message you'll receive.</p>
        <p>— The Orion Team</p>
      </div>`,
      text: `Order Confirmed!\n\nHi ${customerName},\n\nYour ${planName} plan (${amount}) has been received.\n\nWhat happens next:\n1. We'll WhatsApp you within 2 hours to schedule your setup call\n2. Send us your business name, logo, and price list PDF\n3. We train Naledi on your business (1-3 business days)\n4. You go live!`,
    });
  } catch (e: any) {
    console.error(`Failed to send email to ${to}:`, e.message);
  }
}

export async function sendGrahamNotification(env: any, customerName: string, customerEmail: string, customerPhone: string, planName: string, amount: string) {
  try {
    await env.EMAIL.send({
      to: GRAHAM_EMAIL,
      from: FROM_EMAIL,
      subject: `New Order: ${planName} — ${customerName}`,
      text: `New Naledi order!\n\nCustomer: ${customerName}\nEmail: ${customerEmail}\nPhone: ${customerPhone}\nPlan: ${planName}\nAmount: ${amount}\n\nSetup within 1-3 business days.`,
    });
  } catch (e: any) {
    console.error('Failed to send Graham notification:', e.message);
  }
}

export async function sendLeadNotification(env: any, name: string, phone: string, business: string, source: string) {
  try {
    await env.EMAIL.send({
      to: GRAHAM_EMAIL,
      from: FROM_EMAIL,
      subject: `New Lead: ${name || 'Unknown'} via ${source}`,
      text: `New lead captured\n\nName: ${name || 'Unknown'}\nPhone: ${phone}\nBusiness: ${business || 'N/A'}\nSource: ${source}\nTime: ${new Date().toISOString()}`,
    });
  } catch (e: any) {
    console.error('Failed to send lead notification:', e.message);
  }
}

export async function sendSetupConfirmation(env: any, to: string, customerName: string, dateTime: string) {
  try {
    await env.EMAIL.send({
      to,
      from: FROM_EMAIL,
      subject: 'Setup Call Confirmed — Orion PRO',
      text: `Hi ${customerName},\n\nYour Orion PRO setup call is confirmed for:\n${new Date(dateTime).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}\n\nWe'll send a WhatsApp reminder before the call.\n\nSee you then,\n— The Orion Team`,
    });
  } catch (e: any) {
    console.error('Failed to send setup confirmation:', e.message);
  }
}

export async function sendInvoice(env: any, to: string, customerName: string, planName: string, amount: string, invoiceNumber: string) {
  try {
    await env.EMAIL.send({
      to,
      from: FROM_EMAIL,
      subject: `Invoice ${invoiceNumber} — Orion PRO`,
      text: `Hi ${customerName},\n\nInvoice ${invoiceNumber} for ${planName} (${amount}) is attached.\n\nPayment due within 14 days.\n\nBank details:\nBank: TBA\nAccount: TBA\nReference: ${invoiceNumber}\n\n— Orion Dev Core`,
    });
  } catch (e: any) {
    console.error('Failed to send invoice:', e.message);
  }
}
