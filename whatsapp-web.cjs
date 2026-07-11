const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');

const WORKER_URL = process.env.WORKER_URL || 'https://helpme-api.orion269.workers.dev';
const API_ENDPOINT = `${WORKER_URL}/api/incoming`;
const OC_INCOMING_ENDPOINT = `${WORKER_URL}/api/oc-incoming`;
const OUTBOX_ENDPOINT = `${WORKER_URL}/api/outbox`;
const OUTBOX_CONFIRM = `${WORKER_URL}/api/outbox/confirm`;
const TRANSCRIBE_ENDPOINT = `${WORKER_URL}/api/transcribe`;
const DOCUMENT_ENDPOINT = `${WORKER_URL}/api/incoming-document`;
const HEARTBEAT_ENDPOINT = `${WORKER_URL}/api/gateway/heartbeat`;

const clients = {};
const retryCounts = new Map();
const MAX_RETRIES = 3;
const MEMORY_LIMIT = 700 * 1024 * 1024;
const QR_DIR = '/home/graham/projects/naledi-star';
const RECONNECT_DELAY = 10000;

function log(msg) {
  const ts = new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' });
  console.log(`[${ts}] ${msg}`);
}

function makeClient(name, authFolder, qrFile, dyingRef) {
  dyingRef.current = false;
  let reconnectTimer = null;

  function clearReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  const c = new Client({
    authStrategy: new LocalAuth({ clientId: name }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--single-process',
        '--no-zygote',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-breakpad',
        '--memory-pressure-off',
        '--js-flags=--max-old-space-size=256',
      ],
      executablePath: '/home/graham/.cache/puppeteer/chrome/linux-146.0.7680.153/chrome-linux64/chrome'
    }
  });

  c.on('qr', (qr) => {
    log(`[${name}] SCAN QR CODE`);
    qrcodeTerminal.generate(qr, { small: true });
    QRCode.toFile(`${QR_DIR}/${qrFile}`, qr, { type: 'png', width: 400 }, (err) => {
      if (err) console.error(`[${name}] Failed to save QR:`, err);
    });
  });

  c.on('authenticated', () => log(`[${name}] WhatsApp authenticated`));
  c.on('ready', () => {
    log(`[${name}] WhatsApp client is ready!`);
    sendHeartbeat(name, 'connected').catch(() => {});
  });

  c.on('disconnected', async (reason) => {
    log(`[${name}] WhatsApp disconnected: ${reason}`);
    sendHeartbeat(name, 'disconnected', reason).catch(() => {});
    if (dyingRef.current) return;
    log(`[${name}] Reconnecting in ${RECONNECT_DELAY / 1000}s...`);
    clearReconnect();
    reconnectTimer = setTimeout(async () => {
      if (dyingRef.current) return;
      try {
        log(`[${name}] Reconnecting...`);
        await c.initialize().catch(() => {});
      } catch (e) {
        log(`[${name}] Reconnect failed: ${e.message}`);
      }
    }, RECONNECT_DELAY);
  });

  return c;
}

async function sendHeartbeat(name, status, detail) {
  try {
    await fetch(HEARTBEAT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gateway: name,
        status,
        detail: detail || null,
        uptime: process.uptime(),
        memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch {}
}

function makeNalediClient() {
  const dying = { current: false };
  const c = makeClient('naledi', 'naledi', 'qr-naledi.png', dying);

  c.on('message', async (msg) => {
    if (dying.current) return;
    try {
      const contact = await msg.getContact();
      const name = contact.name || contact.pushname || contact.shortName || 'Unknown';

      if (msg.type === 'ptt' || msg.type === 'audio') {
        log(`[Naledi] ${name}: [Voice note]`);
        const media = await msg.downloadMedia();
        if (!media) { await msg.reply('Sorry, I could not process your voice note.'); return; }
        const transcribed = await transcribeAudio(media.data, media.mimetype);
        if (!transcribed) { await msg.reply('Sorry, I could not understand your voice note.'); return; }
        await processTextMessage(msg, transcribed, contact, name, API_ENDPOINT);
        return;
      }

      if (msg.type === 'image' || msg.type === 'document') {
        log(`[Naledi] ${name}: [${msg.type}]`);
        const media = await msg.downloadMedia();
        if (!media) { await msg.reply('Sorry, I could not process that file.'); return; }
        await processDocumentMessage(msg, media.data, media.mimetype, contact, name);
        return;
      }

      if (msg.type !== 'chat') return;
      await processTextMessage(msg, msg.body, contact, name, API_ENDPOINT);
    } catch (e) {
      if (dying.current) return;
      log(`[Naledi] Handler error: ${e.message}`);
    }
  });

  return { client: c, dying };
}

function makeOpencodeClient() {
  const dying = { current: false };
  const c = makeClient('opencode', 'opencode', 'qr-opencode.png', dying);

  c.on('message', async (msg) => {
    if (dying.current) return;
    try {
      const contact = await msg.getContact();
      const name = contact.name || contact.pushname || contact.shortName || 'Unknown';

      if (msg.type !== 'chat') return;
      log(`[Opencode] ${name}: ${msg.body.slice(0, 100)}`);

      // Store in MEMORY_DB for opencode/Mintaka to read (fire-and-forget)
      fetch(OC_INCOMING_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: msg.from, body: msg.body, name }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});

      // Get AI reply from Naledi pipeline (same as naledi client)
      await processTextMessage(msg, msg.body, contact, name, API_ENDPOINT);
    } catch (e) {
      if (dying.current) return;
      log(`[Opencode] Handler error: ${e.message}`);
      await msg.reply("Naledi's offline — I'll check in when I'm back.").catch(() => {});
    }
  });

  return { client: c, dying };
}

function makeCellCClient() {
  const dying = { current: false };
  const c = makeClient('naledi-cellc', 'naledi-cellc', 'qr-naledi-cellc.png', dying);

  c.on('message', async (msg) => {
    if (dying.current) return;
    try {
      const contact = await msg.getContact();
      const name = contact.name || contact.pushname || contact.shortName || 'Unknown';

      if (msg.type === 'ptt' || msg.type === 'audio') {
        log(`[CellC] ${name}: [Voice note]`);
        const media = await msg.downloadMedia();
        if (!media) { await msg.reply('Sorry, I could not process your voice note.'); return; }
        const transcribed = await transcribeAudio(media.data, media.mimetype);
        if (!transcribed) { await msg.reply('Sorry, I could not understand your voice note.'); return; }
        await processTextMessage(msg, transcribed, contact, name, API_ENDPOINT);
        return;
      }

      if (msg.type === 'image' || msg.type === 'document') {
        log(`[CellC] ${name}: [${msg.type}]`);
        const media = await msg.downloadMedia();
        if (!media) { await msg.reply('Sorry, I could not process that file.'); return; }
        await processDocumentMessage(msg, media.data, media.mimetype, contact, name);
        return;
      }

      if (msg.type !== 'chat') return;
      await processTextMessage(msg, msg.body, contact, name, API_ENDPOINT);
    } catch (e) {
      if (dying.current) return;
      log(`[CellC] Handler error: ${e.message}`);
    }
  });

  return { client: c, dying };
}

async function pollOutbox(clientObj, sender) {
  const cl = clientObj.client;
  const dying = clientObj.dying;
  try {
    const res = await fetch(`${OUTBOX_ENDPOINT}?sender=${sender}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.messages || data.messages.length === 0) return;

    for (const msg of data.messages) {
      const prev = retryCounts.get(msg.id) || 0;
      if (prev >= MAX_RETRIES) {
        log(`[${sender}] Skipping ${msg.id} (failed ${prev}x)`);
        await fetch(OUTBOX_CONFIRM, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [msg.id], status: 'failed', error: 'Max retries' }),
        }).catch(() => {});
        retryCounts.delete(msg.id);
        continue;
      }

      try {
        const clean = msg.to.replace(/\D/g, '').replace(/^0?27/, '27').replace(/^0/, '27');
        const waId = clean + '@c.us';

        const exists = await cl.isRegisteredUser(waId).catch(() => null);
        if (exists === false) {
          log(`[${sender}] Skipping ${msg.id} to ${clean} — not on WhatsApp`);
          await fetch(OUTBOX_CONFIRM, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [msg.id], status: 'failed', error: 'Not registered' }),
          }).catch(() => {});
          retryCounts.delete(msg.id);
          continue;
        }

        log(`[${sender}] Sending ${msg.id} to ${clean}`);
        await cl.sendMessage(waId, msg.message);
        log(`[${sender}] Sent: ${msg.id}`);
        await fetch(OUTBOX_CONFIRM, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [msg.id] }),
        }).catch(() => {});
        retryCounts.delete(msg.id);
      } catch (e) {
        const err = e?.message || '';
        const count = (retryCounts.get(msg.id) || 0) + 1;
        retryCounts.set(msg.id, count);
        log(`[${sender}] Failed: ${msg.id} (attempt ${count}/${MAX_RETRIES}): ${err.slice(0, 120)}`);
        if (err.includes('detached Frame') || err === 't') {
          log(`[${sender}] Client needs restart`);
          break;
        }
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (e) {
    log(`[${sender}] Poll error: ${e.message}`);
  }
}

async function processTextMessage(msg, body, contact, name, endpoint) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: msg.from, body, name }),
      signal: AbortSignal.timeout(25000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.reply) await msg.reply(data.reply);
    } else {
      log(`API Error ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await msg.reply("Sorry, I'm having trouble connecting. Please try again in a moment.").catch(() => {});
    }
  } catch (e) {
    log('Incoming API call failed: ' + e.message);
    await msg.reply("Sorry, something went wrong. Graham will check on me shortly.").catch(() => {});
  }
}

async function processDocumentMessage(msg, imageBase64, mimeType, contact, name) {
  try {
    const caption = msg.caption || '';
    const res = await fetch(DOCUMENT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: msg.from, image_base64: imageBase64, mime_type: mimeType, caption }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.reply) await msg.reply(data.reply);
    } else {
      log(`Document API Error ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await msg.reply('Sorry, I could not process that document.');
    }
  } catch (e) {
    log('Document API call failed: ' + e.message);
    await msg.reply('Sorry, something went wrong processing that file.');
  }
}

async function transcribeAudio(audioBase64, mimetype) {
  try {
    const res = await fetch(TRANSCRIBE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: audioBase64, mimetype }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.text || null;
  } catch {
    return null;
  }
}

async function checkMemory() {
  try {
    const usage = process.memoryUsage();
    const rssMB = Math.round(usage.rss / 1024 / 1024);
    log(`Memory: ${rssMB}MB RSS`);
    if (usage.rss > MEMORY_LIMIT) {
      log(`Memory limit exceeded, recycling clients`);
      for (const key of Object.keys(clients)) {
        if (clients[key]) {
          clients[key].dying.current = true;
          try { await clients[key].client.destroy().catch(() => {}); } catch {}
        }
      }
    }
  } catch {}
}

(async () => {
  log('Daemon starting with dual clients...');

  clients.naledi = makeNalediClient();
  clients.opencode = makeOpencodeClient();
  clients.cellc = makeCellCClient();

  await clients.naledi.client.initialize();
  await clients.opencode.client.initialize();
  await clients.cellc.client.initialize();

  setInterval(() => pollOutbox(clients.naledi, 'naledi'), 30000);
  setInterval(() => pollOutbox(clients.opencode, 'opencode'), 30000);
  setInterval(() => pollOutbox(clients.cellc, 'cellc'), 30000);
  setInterval(checkMemory, 300000);
  setInterval(() => sendHeartbeat('naledi', 'connected').catch(() => {}), 60000);
  setInterval(() => sendHeartbeat('cellc', 'connected').catch(() => {}), 60000);
  setTimeout(checkMemory, 5000);

  process.on('SIGTERM', async () => {
    log('SIGTERM received, shutting down...');
    for (const key of Object.keys(clients)) {
      if (clients[key]) {
        clients[key].dying.current = true;
        try { await clients[key].client.destroy().catch(() => {}); } catch {}
      }
    }
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    log('SIGINT received, shutting down...');
    for (const key of Object.keys(clients)) {
      if (clients[key]) {
        clients[key].dying.current = true;
        try { await clients[key].client.destroy().catch(() => {}); } catch {}
      }
    }
    process.exit(0);
  });

  process.on('uncaughtException', (e) => {
    log('Uncaught: ' + e.message);
  });
})();
