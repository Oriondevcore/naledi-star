const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file',
];

export function getAuthUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }
  return res.json();
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }
  return res.json();
}

async function getAccessToken(env: any): Promise<string> {
  const row = await env.NALEDI_DB.prepare(
    'SELECT refresh_token FROM calendar_tokens WHERE id = 1'
  ).first<{ refresh_token: string }>();
  if (!row) throw new Error('Google not connected. Visit /api/calendar/auth to connect.');
  const { access_token } = await refreshAccessToken(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, row.refresh_token);
  return access_token;
}

// ── CALENDAR ──

export async function listEvents(
  env: any,
  maxResults = 10,
  timeMin?: string
): Promise<any[]> {
  const token = await getAccessToken(env);
  const params = new URLSearchParams({
    maxResults: String(maxResults),
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: timeMin || new Date().toISOString(),
  });
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to list events: ${err}`);
  }
  const data: any = await res.json();
  return data.items || [];
}

export async function createEvent(
  env: any,
  event: {
    summary: string;
    description?: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
    attendees?: { email: string }[];
  }
): Promise<any> {
  const token = await getAccessToken(env);
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create event: ${err}`);
  }
  return res.json();
}

export async function checkAvailability(
  env: any,
  timeMin: string,
  timeMax: string
): Promise<{ busy: { start: string; end: string }[] }> {
  const token = await getAccessToken(env);
  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      timeMin,
      timeMax,
      items: [{ id: 'primary' }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to check availability: ${err}`);
  }
  const data: any = await res.json();
  return { busy: data.calendars?.primary?.busy || [] };
}

// ── SHEETS ──

export async function appendSheetRow(
  env: any,
  spreadsheetId: string,
  range: string,
  values: any[]
): Promise<void> {
  const token = await getAccessToken(env);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        values: [values],
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to append sheet row: ${err}`);
  }
}

export async function updateSheetRange(
  env: any,
  spreadsheetId: string,
  range: string,
  values: any[]
): Promise<void> {
  const token = await getAccessToken(env);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [values] }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to update sheet: ${err}`);
  }
}

export async function readSheetRange(
  env: any,
  spreadsheetId: string,
  range: string
): Promise<any[][]> {
  const token = await getAccessToken(env);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to read sheet: ${err}`);
  }
  const data: any = await res.json();
  return data.values || [];
}

// ── DOCS (Templates -> Copy -> Fill -> Export PDF) ──

export async function copyTemplate(
  env: any,
  templateFileId: string,
  title: string
): Promise<string> {
  const token = await getAccessToken(env);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${templateFileId}/copy`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: title }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to copy template: ${err}`);
  }
  const data: any = await res.json();
  return data.id;
}

export async function fillDocTemplate(
  env: any,
  documentId: string,
  replacements: Record<string, string>
): Promise<void> {
  const token = await getAccessToken(env);
  const requests = Object.entries(replacements).map(([key, value]) => ({
    replaceAllText: {
      containsText: { text: `{{${key}}}`, matchCase: true },
      replaceText: value,
    },
  }));
  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requests }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to fill template: ${err}`);
  }
}

export async function exportPdf(
  env: any,
  documentId: string,
): Promise<ArrayBuffer> {
  const token = await getAccessToken(env);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${documentId}/export?mimeType=application/pdf`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to export PDF: ${err}`);
  }
  return res.arrayBuffer();
}

export async function sendDocAsEmail(
  env: any,
  to: string,
  subject: string,
  bodyText: string,
  pdfBuffer: ArrayBuffer,
  fileName: string
): Promise<void> {
  const base64Pdf = btoa(String.fromCharCode(...new Uint8Array(pdfBuffer)));
  await env.EMAIL.send({
    to,
    from: { email: 'naledi@oriondevcore.com', name: 'Naledi Star' },
    subject,
    html: bodyText.replace(/\n/g, '<br>'),
    text: bodyText,
    attachments: [{ filename: fileName, content: base64Pdf, encoding: 'base64', contentType: 'application/pdf' }],
  });
}
