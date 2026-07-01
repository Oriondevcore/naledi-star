export async function sendOrderConfirmation(env: any, to: string, customerName: string, planName: string, amount: string) {
  try {
    await env.EMAIL.send({
      to,
      from: { email: "naledi@oriondevcore.com", name: "Naledi Star" },
      subject: "Your Naledi Order Confirmation",
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
    console.log(`Email sent to ${to}: ${planName}`);
  } catch (e: any) {
    console.error(`Failed to send email to ${to}:`, e.message);
  }
}

export async function sendGrahamNotification(env: any, customerName: string, customerEmail: string, customerPhone: string, planName: string, amount: string) {
  try {
    await env.EMAIL.send({
      to: "graham@oriondevcore.com",
      from: { email: "naledi@oriondevcore.com", name: "Naledi Star Orders" },
      subject: `New Naledi Order: ${planName}`,
      text: `New Naledi order!\n\nCustomer: ${customerName}\nEmail: ${customerEmail}\nPhone: ${customerPhone}\nPlan: ${planName}\nAmount: ${amount}\n\nSetup within 1-3 business days.`,
    });
  } catch (e: any) {
    console.error("Failed to send Graham notification:", e.message);
  }
}
