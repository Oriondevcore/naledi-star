const API = 'https://helpme-api.orion269.workers.dev';
let session = null;

function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => { el.remove(); }, 3000);
}

async function init() {
  registerSW();
  setupScreens();
  const stored = localStorage.getItem('naledi_token');
  if (stored) {
    await verifyToken(stored);
  }
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
  }
}

function setupScreens() {
  document.getElementById('sos-btn')?.addEventListener('click', showSOS);
  document.getElementById('sos-confirm')?.addEventListener('click', triggerSOS);
  document.getElementById('sos-cancel')?.addEventListener('click', hideSOS);
  document.getElementById('chat-back')?.addEventListener('click', () => showScreen('dashboard'));
  document.getElementById('chat-send')?.addEventListener('click', sendMessage);
  document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
  document.getElementById('logout-btn')?.addEventListener('click', logout);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(`screen-${id}`);
  if (el) el.classList.add('active');
}

async function verifyToken(token) {
  try {
    const res = await fetch(`${API}/api/pwa/me?token=${encodeURIComponent(token)}`);
    if (!res.ok) { logout(); return; }
    session = await res.json();
    session.token = token;
    showScreen('dashboard');
    loadDashboard();
  } catch {
    logout();
  }
}

function logout() {
  localStorage.removeItem('naledi_token');
  localStorage.removeItem('naledi_name');
  localStorage.removeItem('naledi_phone');
  localStorage.removeItem('naledi_role');
  session = null;
  showScreen('landing');
}

function apiUrl(path, params = {}) {
  if (session?.token) params.token = session.token;
  const qs = Object.entries(params).filter(([_, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${API}${path}${qs ? '?' + qs : ''}`;
}

async function loadDashboard() {
  const el = document.getElementById('dashboard-content');
  if (!el) return;
  el.innerHTML = `<h1>Hi, ${session?.name || 'there'}</h1>`;

  if (session?.role === 'admin') {
    renderAdminDashboard(el);
  } else if (session?.role === 'carer') {
    renderCarerDashboard(el);
  } else {
    renderClientDashboard(el);
  }
}

function renderClientDashboard(el) {
  el.innerHTML += `
    <p style="color:var(--text-muted);margin-bottom:16px;font-size:16px;">
      Your carer is here if you need them.
    </p>
    <div class="contact-list" id="carer-card"></div>
    <div style="flex:1"></div>
    <button class="btn btn-danger" id="sos-btn">
      EMERGENCY
    </button>
  `;
  loadCarerInfo();
  document.getElementById('sos-btn')?.addEventListener('click', showSOS);
}

async function loadCarerInfo() {
  const res = await fetch(apiUrl('/api/pwa/matches', { phone: session?.phone }));
  const data = await res.json();
  const card = document.getElementById('carer-card');
  if (!card) return;
  if (data.carer) {
    const initial = (data.carer.name || 'C')[0].toUpperCase();
    card.innerHTML = `
      <div class="contact-card" onclick="openChat('${data.carer.id}','${data.carer.name}')">
        <div class="avatar">${initial}</div>
        <div class="info">
          <div class="name">${data.carer.name}</div>
          <div class="meta">Your carer — Tap to chat</div>
        </div>
        <div style="font-size:20px;color:var(--text-muted);">&rsaquo;</div>
      </div>
    `;
  } else {
    card.innerHTML = `<p style="color:var(--text-muted);font-size:15px;">No carer assigned yet.</p>`;
  }
}

function renderCarerDashboard(el) {
  el.innerHTML += `
    <p style="color:var(--text-muted);margin-bottom:16px;font-size:16px;">
      Here are the people you are looking after:
    </p>
    <div class="contact-list" id="clients-list"></div>
  `;
  loadClients();
}

async function loadClients() {
  const res = await fetch(apiUrl('/api/pwa/matches', { phone: session?.phone }));
  const data = await res.json();
  const list = document.getElementById('clients-list');
  if (!list) return;
  if (data.clients?.length) {
    list.innerHTML = data.clients.map(c => `
      <div class="contact-card" onclick="openChat('${c.id}','${c.name}')">
        <div class="avatar">${(c.name || '?')[0].toUpperCase()}</div>
        <div class="info">
          <div class="name">${c.name}</div>
          <div class="meta">Tap to chat</div>
        </div>
        <div style="font-size:20px;color:var(--text-muted);">&rsaquo;</div>
      </div>
    `).join('');
  } else {
    list.innerHTML = `<p style="color:var(--text-muted);font-size:15px;">No clients assigned yet.</p>`;
  }
}

function renderAdminDashboard(el) {
  el.innerHTML = `
    <p style="color:var(--text-muted);margin-bottom:16px;font-size:16px;">
      Naledi Star overview
    </p>
    <div class="contact-list" id="admin-overview"></div>
    <div class="contact-list" style="margin-top:12px;">
      <a href="/chat/" class="contact-card" style="text-decoration:none;border-color:var(--accent);">
        <div class="avatar" style="background:var(--accent);color:#000;">P</div>
        <div class="info">
          <div class="name" style="color:var(--accent);">Private Chat</div>
          <div class="meta">Private encrypted messaging</div>
        </div>
        <div style="font-size:20px;color:var(--text-muted);">&rsaquo;</div>
      </a>
    </div>
    <div style="flex:1"></div>
    <p style="font-size:13px;color:var(--text-muted);text-align:center;">
      Manage tokens via the API or WhatsApp
    </p>
  `;
  loadAdminOverview();
}

async function loadAdminOverview() {
  const res = await fetch(apiUrl('/api/pwa/matches', { phone: 'graham' }));
  const data = await res.json();
  const el = document.getElementById('admin-overview');
  if (!el) return;
  el.innerHTML = `
    <div class="contact-card">
      <div class="info">
        <div class="name">${data.total_matches || 0} Active Matches</div>
        <div class="meta">${data.pending_matches || 0} pending</div>
      </div>
    </div>
  `;
}

function openChat(id, name) {
  document.getElementById('chat-partner-id').value = id;
  document.getElementById('chat-partner-name').textContent = name;
  showScreen('chat');
  loadMessages(id);
  window._chatPartner = { id, name };
}

async function loadMessages(partnerId) {
  const el = document.getElementById('chat-messages');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px 0;">Loading...</p>';
  try {
    const res = await fetch(apiUrl('/api/pwa/messages', { phone: session?.phone, partner: partnerId }));
    const data = await res.json();
    el.innerHTML = (data.messages || []).map(m => `
      <div class="msg ${m.from === session?.phone ? 'msg-out' : 'msg-in'}">
        ${m.text}
        <div class="time">${new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      </div>
    `).join('') || '<p style="color:var(--text-muted);text-align:center;padding:40px 0;">No messages yet. Say hello!</p>';
    el.scrollTop = el.scrollHeight;
  } catch {
    el.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px 0;">Could not load messages.</p>';
  }
}

async function sendMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !window._chatPartner) return;

  const el = document.getElementById('chat-messages');
  el.innerHTML += `
    <div class="msg msg-out">
      ${text}
      <div class="time">Just now</div>
    </div>
  `;
  input.value = '';
  el.scrollTop = el.scrollHeight;

  await fetch(apiUrl('/api/pwa/messages'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_phone: session?.phone, to_id: window._chatPartner.id, text }),
  });
}

function showSOS() {
  document.getElementById('sos-modal').classList.add('active');
}

function hideSOS() {
  document.getElementById('sos-modal').classList.remove('active');
}

async function triggerSOS() {
  hideSOS();
  const dashboard = document.getElementById('dashboard-content');
  dashboard.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;flex:1;text-align:center;animation:fadeIn 0.3s ease;">
      <div class="icon" style="font-size:24px;font-weight:700;width:72px;height:72px;border-radius:50%;background:rgba(52,211,153,0.15);border:1px solid rgba(52,211,153,0.3);color:var(--state-success);display:flex;align-items:center;justify-content:center;">OK</div>
      <h2 style="color:var(--state-success);font-weight:700;">Help is on the way!</h2>
      <p style="color:var(--text-muted);">Your carer has been notified.</p>
      <button class="btn btn-outline btn-small" onclick="loadDashboard()">Back</button>
    </div>
  `;
  try {
    await fetch(apiUrl('/api/pwa/emergency'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: session?.phone, name: session?.name }),
    });
    toast('Alert sent successfully', 'success');
  } catch {
    toast('Failed to send alert', 'error');
  }
}

init();
