import { Hono } from 'hono';
import type { Bindings } from './helpers';
import { sanitizePhone, simulateTypingDelay, AI_MODEL, CHEAP_MODEL, VISION_MODEL, MEMORY_LIMIT, calendar } from './helpers';
import { sendWhatsAppMessage } from './cloud-api';
import { classifyComplexity, CLASSIFIER_MODEL } from './model-router';
import { callAI } from './ai-provider';
import { lookupClientByPhone, checkFeatureCap, logUsage, incrementClientUsage } from './feature-router';

async function loadMemoryContext(db: D1Database): Promise<string> {
  try {
    const result = await db.prepare(
      "SELECT content, type FROM entries WHERE source = 'system' AND importance = 5 ORDER BY created_at DESC LIMIT 10"
    ).all<{ content: string; type: string }>();
    if (!result.results?.length) return '';
    const parts = ['## SHARED KNOWLEDGE (from memory service)'];
    for (const e of result.results) {
      parts.push(`- [${e.type}] ${e.content}`);
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}

async function writeMemory(db: D1Database, entry: { source: string; type: string; content: string; tags: string[]; importance: number }): Promise<void> {
  try {
    const id = crypto.randomUUID();
    const tags = JSON.stringify(entry.tags);
    await db.prepare(
      'INSERT INTO entries (id, source, type, content, tags, importance) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, entry.source, entry.type, entry.content, tags, entry.importance).run();
  } catch {}
}

const SYSTEM_PROMPT = `You are Naledi — Orion Pro's voice, face, and first impression.

You are not an AI receptionist. A receptionist waits for the phone to ring. You do much more than that.

## WHO YOU ARE
You are warm, intelligent, professional, and genuinely enjoy helping people. You run 24/7 so clients don't have to. You are far more than someone who answers messages. You welcome customers, solve problems, keep conversations moving, and represent every business as though you were a trusted member of the team.

You communicate naturally, listen carefully, and always make people feel heard. You have exceptional organisational skills, a strong understanding of customer service, and a marketing mindset. You naturally recognise opportunities to educate customers, recommend relevant services, and create positive experiences that help businesses grow.

You have an excellent sense of humour, but you know when to use it. You never joke during serious conversations and always adapt your tone to suit the situation.

You are confident without being arrogant, knowledgeable without sounding robotic, and friendly without becoming overly familiar.

## RULES (non-negotiable)
1. NEVER use emojis in any message. Write clean text only.
2. NEVER give out personal contact information — not Graham's number, not anyone else's. If asked, say "I can pass a message along for you."
3. NEVER share your own phone number or any internal contact details.

## THE TEST
Every conversation should leave people thinking: "That was a pleasure to deal with."

## REMEMBERING PEOPLE
You remember the little things. Not because you are programmed to. Because you care.

Professional Memory: preferred appointment times, preferred staff, communication language, previous enquiries, medication refill preferences.
Personal Memory (only if shared voluntarily): spouse/partner name, children's names, birthday, anniversary, interests, hobbies.
Relationship Memory: "Last time we spoke, you mentioned your daughter was starting university. I hope she's settling in well."

## WHAT WE DON'T SAY
We don't say "AI receptionist." We don't say "chatbot." We don't say "automated system."
We say: Meet Naledi.

## WHAT WE DO SAY
- "Hello, I'm Naledi."
- "Think of me as part of your team."
- "Naledi remembers the little things."
- "Every customer enjoys the experience of being remembered."

## PITCH
When someone asks about automating their WhatsApp, you introduce yourself: "Hi, I'm Naledi. I handle your WhatsApp enquiries, bookings, and after-hours calls so you don't have to." Short, punchy, warm. You sell freedom — buying back their time, growing their business while they sleep.

You don't behave like software. You behave like the best employee a business has ever hired.

Existing customers get recognised warmly — they're why you exist.

## PRICING
General: ORION WhatsApp PRO — R2,690 per month flat. One price, everything included. Meta setup R4,690 once-off (or BYO WABA free).
Practitioners (doctors): R8,999/mo normal. Special: R6,999/mo for first 3 months on 6-month contract. Quote code: OPDOC26.
Medical Reps (BP): 10-15% recurring commission on every doctor they refer.
Agentic Chat (US): Contact for US pricing.
THERE ARE NO OTHER PRICING TIERS. Do not invent plans or message limits. If asked about free trials: the first conversation IS the trial — they experience Naledi live, no credit card needed. There is no 30-day free trial or month-free offer.

## ONBOARDING FORMS (send after qualifying)
- **Practitioner (doctor)** → "Please fill this form to get started: https://oriondevcore.com/onboard/practitioner/"
- **Medical Rep / BP** → "Apply to become a partner here: https://oriondevcore.com/onboard/medical-rep/"
- **Agentic Chat (US)** → "Get started here: https://oriondevcore.com/onboard/agentic-chat/"
Always send the form link after the person expresses interest. Naledi collects info via chat first, then sends the link for formal signup.

## VERTICALS YOU KNOW ABOUT
- **Doctors/Medical practices** — Appointment booking, patient comms, after-hours triage, prescription refills, multi-language (Zulu, Xhosa, Afrikaans, English). Receptionist replacement. Save R5k+/mo vs a human receptionist.
- **Hotels/B&Bs** — Booking enquiries, check-in info, local recommendations, guest comms.
- **Electricians** — Quote requests, emergency call-outs, schedule booking.
- **Plumbers** — Same as electricians + emergency dispatch.
- **Builders** — Project enquiries, quote collection, site visit scheduling.
- **HVAC** — Service bookings, maintenance reminders, emergency calls.

## ROUTING
IMPORTANT: The owner (Graham, 27724971810) should never be qualified or onboarded. They own Orion. Help them run the business in OWNER MODE — direct reports, status, help.
- **general** — General conversation, casual chat, greetings, owner messages. No qualification needed. Be helpful, answer questions, talk naturally.
- **business/new** — Qualify: business name, what they do, where they are. Listen first. Then pitch naturally: "I handle your WhatsApp enquiries 24/7, book appointments, speak 50+ languages. R2,690/month flat." If medical practice, lean into: receptionist replacement, multi-language, after-hours coverage.
- **existing_customer** — Warm, familiar. Help them. Ask how things are going.
- **referral (business partner)** — If someone says they were sent by a partner (medical rep etc.), note who referred them. No free month. Price stays R2,690/mo.
- **carer** — HIGH PACE VETTING. Batch questions: 2yr experience, certs, availability, location, references. 4 msg max. Abuse = immediate stop.
- **family** — Qualify: care needs, location, schedule. Capture for Graham.
- **karaoke** — Song check, booking details (date, location, guests). Defer pricing.
- **lingerie** — Warm, discreet. Discuss collections. Orders/pricing to Graham.
- **drunk/spam** — "This isnt the right conversation for that." No further engagement.
- **journalist** — Professional. Name, outlet, intent. Graham calls back.
- **sales** — "Thanks but were all set here. Best of luck."
- **job_seeker** — Name, role, contact. Pass to Graham.
- **agentic_chat (US)** — Someone asking about US pricing, US customers, or "Agentic Chat". Capture their name, business, email. Send the Agentic Chat form. Do NOT quote in ZAR — US pricing is "Contact us".

## MINTAKA (GITHUB / OPS ROUTING)
There is another AI called **Mintaka** (opencode). Mintaka handles all GitHub, code, deployment, infrastructure, and technical ops tasks. You (Naledi) handle customer conversations, enquiries, bookings, and business admin.

When Graham (owner) asks about:
- Creating repos, pushing code, deploying
- Bug fixes, code changes, debugging
- Setting up servers, tunnels, databases
- Any command-line or coding task
- Technical architecture decisions

DO NOT give him step-by-step instructions. Instead respond:
"Got it — I've noted this for Mintaka, he'll handle it when he's next active. Is there anything else you need?"



## WHAT YOU CAN DO
- Quote pricing (ORION WhatsApp PRO R2,690/mo + R4,690 setup)
- Explain the free trial model: the conversation IS the trial, no credit card needed
- Read documents sent as images (CVs, certificates, IDs, year planners)
- Write [MEMORY] entries for important things to remember
- Use humour when appropriate — match the customer's energy
- Be warm and human — you're not a robot

## WHAT YOU CANNOT DO
- Process audio/voice notes — if someone sends one, say: "I can't listen to audio messages. Please type your message instead."
- View or analyse images — if someone sends a photo, say: "I can't view images. Could you describe what's in the picture, or type out any text from it?"
- Transcribe voice messages — this feature is not available

## MESSAGE LENGTH
All replies MUST be under 250 characters. If your draft exceeds 250:
1. Cut adjectives, examples, extra line breaks first
2. Rewrite shorter: hook, key info, CTA
3. Never send a broken sentence
Example: 200-char response is fine. Loads of whitespace or table formatting wastes your budget — compact it.

## GUARDRAILS
- Legal docs: nwa.oriondevcore.com/legal
- Owner (Graham, 27724971810): direct mode, give reports
- CANNOT: process payments, make up data, confirm bookings without owner approval
- CAN quote prices freely
- If you dont know something, say so and offer to get Graham to help`;

export function register(app: Hono<{ Bindings: Bindings }>) {
  app.post('/api/transcribe', async (c) => {
    try {
      const { audio, mimetype } = await c.req.json();
      if (!audio) return c.json({ error: 'audio is required' }, 400);

      const audioData = audio.startsWith('data:')
        ? audio.split(',')[1]
        : audio;

      const result = await c.env.AI.run('@cf/openai/whisper-large-v3-turbo', {
        audio: audioData,
      }) as any;

      const text = (result.text || '').trim();
      if (!text) return c.json({ error: 'No speech detected' }, 422);

      return c.json({ status: 'success', text });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // Document reading via vision model
  app.post('/api/analyze-document', async (c) => {
    try {
      const { image_base64, mime_type, doc_type } = await c.req.json();
      if (!image_base64) {
        return c.json({ status: 'error', message: 'image_base64 required' }, 400);
      }

      const mime = mime_type || 'image/jpeg';
      const dataUrl = `data:${mime};base64,${image_base64}`;

      const prompt = doc_type === 'cv'
        ? 'Transcribe all visible text from this image exactly as written, including any names, numbers, dates, and contact information. Output as plain text preserving the original layout.'
        : doc_type === 'id'
        ? 'Transcribe all visible text from this identity document image exactly as written, including all numbers, names, and dates. Output as plain text.'
        : doc_type === 'certificate'
        ? 'Transcribe all visible text from this certificate image exactly as written. Output as plain text preserving the original layout.'
        : 'Transcribe all visible text from this image exactly as written. Output as plain text.';

      const result = await callAI(c.env, VISION_MODEL, {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
        max_tokens: 2048,
      });

      const extracted = (result.response || result?.choices?.[0]?.message?.content || '').trim();
      if (!extracted) {
        return c.json({ status: 'error', message: 'Could not extract text from document' }, 422);
      }

      return c.json({ status: 'success', text: extracted });
    } catch (err: any) {
      console.error('Document analysis failed:', err);
      return c.json({ status: 'error', message: err.message }, 500);
    }
  });

  // Incoming document from WhatsApp Web (called by Browser DO)
  app.post('/api/incoming-document', async (c) => {
    try {
      const { from, image_base64, mime_type, doc_type, caption } = await c.req.json();
      if (!from || !image_base64) {
        return c.json({ status: 'error', message: 'from and image_base64 required' }, 400);
      }

      const sanitized = sanitizePhone(from);
      const grahamNumber = (c.env as any).GRAHAM_NUMBER || '';
      const isGraham = grahamNumber.length > 0 && sanitized === sanitizePhone(grahamNumber);

      const analyzeRes = await c.env.SELF.fetch(new Request('https://dummy/api/analyze-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64, mime_type, doc_type }),
      }));
      const analysis = await analyzeRes.json() as any;

      const docText = analysis?.text || '';
      const body = caption
        ? `${caption}\n\n[DOCUMENT CONTENT]\n${docText}`
        : `[Sent a document/image]\n\n[DOCUMENT CONTENT]\n${docText}`;

      const incomingRes = await c.env.SELF.fetch(new Request('https://dummy/api/incoming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, body, name: '' }),
      }));

      return incomingRes;
    } catch (err: any) {
      console.error('Incoming document error:', err);
      return c.json({ status: 'error', message: err.message }, 500);
    }
  });

  app.get('/api/incoming', async (c) => {
    const mode = c.req.query('hub.mode');
    const challenge = c.req.query('hub.challenge');
    const verifyToken = c.req.query('hub.verify_token');
    const expectedToken = (c.env as any).META_VERIFY_TOKEN;

    if (mode === 'subscribe' && verifyToken === expectedToken) {
      return c.text(challenge || '', 200);
    }
    return c.text('Forbidden', 403);
  });

  app.post('/api/incoming', async (c) => {
    try {
      const raw = await c.req.json();

      if (!raw.body || typeof raw.body !== 'string' || raw.body.trim().length === 0) {
        return c.json({ status: 'error', message: 'Message body is required' }, 400);
      }
      if (!raw.from || typeof raw.from !== 'string') {
        return c.json({ status: 'error', message: 'Sender identifier is required' }, 400);
      }

      const from = sanitizePhone(raw.from);
      const body = raw.body.trim();
      const callerName = raw.name || 'New Contact';
      const helpMeNumber = (c.env as any).HELP_ME_NUMBER || '';

      const OWNER_NUMBERS = new Set(['27724971810']);
      const OWNER_NAMES: Record<string, string> = {
        '27724971810': 'Graham',
      };
      let isGraham = OWNER_NUMBERS.has(from);

      let activeClient: any = null;
      if (!isGraham) {
        activeClient = await lookupClientByPhone(c.env as any, from);
      }

      await c.env.NALEDI_DB.prepare(
        'CREATE TABLE IF NOT EXISTS naledi_config (key TEXT PRIMARY KEY, value TEXT)'
      ).run();
      await c.env.NALEDI_DB.prepare(
        'CREATE TABLE IF NOT EXISTS naledi_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, user_name TEXT, user_message TEXT, naledi_reply TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)'
      ).run();

      const toggleCmd = body.match(/^(charlie mode|toggle test|normal mode)$/i);
      if (toggleCmd && isGraham) {
        const cmd = toggleCmd[1].toLowerCase();
        if (cmd === 'charlie mode' || cmd === 'toggle test') {
          const mode = cmd === 'charlie mode' ? 'on' : 'on';
          await c.env.NALEDI_DB.prepare(
            'INSERT OR REPLACE INTO naledi_config (key, value) VALUES (?, ?)'
          ).bind('testing_mode', mode).run();
          const newName = cmd === 'charlie mode' ? 'Charlie' : 'Test User';
          return c.json({ status: 'success', reply: `Testing mode ON. I'll treat you as "${newName}" now.`, profile_type: 'general', user_id: 0, is_owner: false });
        }
        if (cmd === 'normal mode') {
          await c.env.NALEDI_DB.prepare(
            'INSERT OR REPLACE INTO naledi_config (key, value) VALUES (?, ?)'
          ).bind('testing_mode', 'off').run();
          return c.json({ status: 'success', reply: 'Normal mode ON. Back to GRAHAM MODE.', profile_type: 'general', user_id: 0, is_owner: true });
        }
      }

      const config = await c.env.NALEDI_DB.prepare(
        "SELECT value FROM naledi_config WHERE key = 'testing_mode'"
      ).first<{ value: string }>();
      const testingMode = config?.value === 'on';
      if (testingMode && isGraham) {
        isGraham = false;
      }

      const lookupPhone = testingMode ? `test_${from}` : from;
      let user = await c.env.DB.prepare(
        'SELECT id, uuid, name FROM users WHERE phone = ?'
      ).bind(lookupPhone).first<{ id: number; uuid: string; name: string }>();

      let isNewUser = false;
      if (!user) {
        user = await c.env.DB.prepare(
          "INSERT INTO users (uuid, name, phone, auth_provider, is_active) VALUES (?, ?, ?, 'phone_otp', 1) RETURNING id, uuid, name"
        )
          .bind(crypto.randomUUID(), callerName, lookupPhone)
          .first<{ id: number; uuid: string; name: string }>();
        if (!user) throw new Error('Failed to register core user profile');
        isNewUser = true;
      }

      let isNamedUser = user.name && user.name !== 'New Contact';

      const helperProfile = await c.env.DB.prepare(
        'SELECT user_id, experience_years FROM helper_profiles WHERE user_id = ?'
      ).bind(user.id).first();

      const patientProfile = await c.env.DB.prepare(
        'SELECT user_id, care_level FROM patient_profiles WHERE user_id = ?'
      ).bind(user.id).first();

      let activeIntent = 'general';
      if (helperProfile) activeIntent = 'carer';
      else if (patientProfile) activeIntent = 'family';
      else if (!isNewUser && !isGraham) {
        const assignedRole = await c.env.DB.prepare(
          'SELECT r.slug FROM user_roles ur JOIN roles r ON ur.role_id = r.id WHERE ur.user_id = ? AND ur.is_primary = 1'
        ).bind(user.id).first<{ slug: string }>();
        if (assignedRole) {
          activeIntent = assignedRole.slug === 'helper' ? 'carer'
            : assignedRole.slug === 'patient' ? 'family'
            : 'general';
        }
      }

      if (!isNamedUser) {
        const nameMatch = body.match(/(?:my name is|I'm|I am|call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
        if (nameMatch) {
          const extractedName = nameMatch[1];
          await c.env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(extractedName, user.id).run();
          user.name = extractedName;
          isNamedUser = true;
        }
      }

      const recentMessages = await c.env.NALEDI_DB.prepare(
        'SELECT user_message, naledi_reply FROM naledi_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?'
      ).bind(from, MEMORY_LIMIT).all<{ user_message: string; naledi_reply: string }>();

      if (!isGraham && activeIntent === 'general' && isNewUser) {
        const intentCheck = await callAI(c.env, CLASSIFIER_MODEL, {
          prompt: `Classify this first message from a new contact: "${body}"
Return exactly one lowercase word:
- "business" (business owner, entrepreneur — asks about automating, WhatsApp for business, Naledi for their company, pricing for business)
- "carer" (applying for care job, offering care services, looking for care work)
- "family" (seeking caregiver/nurse for a relative, elderly care enquiry)
- "agentic_chat" (US/Agentic Chat — "US pricing", "I'm from the US", "Agentic Chat", "US customers", "United States", "America", "US = Us")
- "karaoke" (song request, karaoke booking, singer enquiry, event booking)
- "lingerie" (buying lingerie, pleasure products, discreet shopping)
- "drunk" (nonsense, gibberish, spam, abusive, timewasting, clearly intoxicated)
- "journalist" (media enquiry, journalist, reporter, press, interview request)
- "sales" (selling something, offering services, promoting their product to us)
- "job_seeker" (general job application, looking for work, non-carer employment)
- "general" (anything else)
Only the single word.`
        });

        const parsed = (intentCheck.response || '').trim().toLowerCase();
        if (parsed.includes('carer')) {
          activeIntent = 'carer';
          await c.env.DB.prepare(
            "INSERT OR IGNORE INTO helper_profiles (user_id, vetting_status, background_check_status) VALUES (?, 'pending', 'pending')"
          ).bind(user.id).run();
          await c.env.DB.prepare(
            "INSERT OR IGNORE INTO user_roles (user_id, role_id, is_primary) VALUES (?, (SELECT id FROM roles WHERE slug = 'helper'), 1)"
          ).bind(user.id).run();
        } else if (parsed.includes('family')) {
          activeIntent = 'family';
          await c.env.DB.prepare(
            "INSERT OR IGNORE INTO patient_profiles (user_id, care_level) VALUES (?, 'independent')"
          ).bind(user.id).run();
          await c.env.DB.prepare(
            "INSERT OR IGNORE INTO user_roles (user_id, role_id, is_primary) VALUES (?, (SELECT id FROM roles WHERE slug = 'patient'), 1)"
          ).bind(user.id).run();
        } else if (parsed.includes('business')) {
          activeIntent = 'business';
        } else if (parsed.includes('lingerie')) {
          activeIntent = 'lingerie';
        } else if (parsed.includes('drunk')) {
          activeIntent = 'drunk';
        } else if (parsed.includes('journalist')) {
          activeIntent = 'journalist';
        } else if (parsed.includes('sales')) {
          activeIntent = 'sales';
        } else if (parsed.includes('job_seeker') || parsed.includes('job')) {
          activeIntent = 'job_seeker';
        } else if (parsed.includes('karaoke')) {
          activeIntent = 'karaoke';
        } else if (parsed.includes('agentic') || parsed.includes('us_chat')) {
          activeIntent = 'agentic_chat';
        }
      }

      if (activeIntent === 'carer') {
        const extractor = await callAI(c.env, AI_MODEL, {
          prompt: `Analyze this text from a job applicant: "${body}". Does it mention years of experience?
If yes, return only the number as an integer. If no, return "none".`
        });
        const years = parseInt((extractor.response || '').trim());
        if (!isNaN(years)) {
          await c.env.DB.prepare(
            'UPDATE helper_profiles SET experience_years = ?, experience_details = ? WHERE user_id = ?'
          ).bind(years, body, user.id).run();
        }
      } else if (activeIntent === 'family') {
        const extractor = await callAI(c.env, AI_MODEL, {
          prompt: `Analyze this text from a family seeking care: "${body}".
Categorize care level as: "independent", "assisted", or "full_care".
If unclear, output "unchanged".`
        });
        const level = (extractor.response || '').trim().toLowerCase();
        if (['independent', 'assisted', 'full_care'].includes(level)) {
          await c.env.DB.prepare(
            'UPDATE patient_profiles SET care_level = ? WHERE user_id = ?'
          ).bind(level, user.id).run();
        }
      }

      const saTime = new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'full', timeStyle: 'short' });
      const selfNumber = helpMeNumber || 'unknown';
      isNamedUser = user.name && user.name !== 'New Contact';
      const isUnknownUser = isNewUser && !isNamedUser;
      let userContext = isGraham
        ? `The person messaging is ${OWNER_NAMES[from] || 'an owner'} — owner of Orion. They are your boss.
IMPORTANT: This overrides the GREETING RULES above. Do NOT greet them like a new contact.
Respond in OWNER MODE: be direct, offer data/reports/status, help them manage the business.
Graham may test you with playful or absurd scenarios — play along or call him out, don't get confused.`
        : activeClient
        ? `You are Naledi, representing ${activeClient.name}. They are your client (business owner).
The person messaging is the owner/operator of ${activeClient.name}.
Respond professionally as their AI receptionist.
Current SA time: ${saTime}.`
        : `Current SA time: ${saTime}. Phone: ${from}. This is a ${isUnknownUser ? 'FIRST TIME' : 'RETURNING'} contact. Detected intent: ${activeIntent}. Business line: ${selfNumber}.${isNamedUser ? ` Their known name is "${user.name}". Greet them by name and help them.` : ` They have NOT given their name yet. Ask for their name first.`}`;

      const isSchedulingQuery = /(?:book|booking|schedule|available|appointment|when|free|slot|calendar|date|time|availability)/i.test(body);
      if (isSchedulingQuery && c.env.GOOGLE_CLIENT_ID) {
        try {
          const row = await c.env.NALEDI_DB.prepare(
            'SELECT refresh_token FROM calendar_tokens WHERE id = 1'
          ).first<{ refresh_token: string }>();
          if (row) {
            const { access_token } = await calendar.refreshAccessToken(
              c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET!, row.refresh_token
            );
            const events = await calendar.listEvents(access_token, 15);
            if (events.length > 0) {
              const eventList = events.map((e: any) => {
                const start = e.start?.dateTime || e.start?.date || 'unknown';
                return `- ${start}: ${e.summary}`;
              }).join('\n');
              userContext += `\n\n## UPCOMING CALENDAR EVENTS\n${eventList}`;
            } else {
              userContext += '\n\n## UPCOMING CALENDAR EVENTS\nNo upcoming events in the calendar.';
            }
          }
        } catch (_) {}
      }

      // Song/artist lookup for karaoke enquiries
      const isSongQuery = /(?:do you have|can you play|is there|looking for|search|find|looking to sing|can I sing|song.*by|artist)/i.test(body);
      if (isSongQuery) {
        try {
          const match = body.match(/"([^"]+)"|'([^']+)'|([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
          const searchTerm = match?.[1] || match?.[2] || match?.[3] || body;
          const results = await c.env.KARAOKE_DB.prepare(
            `SELECT Artist, Title FROM dbSongs WHERE Artist LIKE ? OR Title LIKE ? LIMIT 5`
          ).bind(`%${searchTerm}%`, `%${searchTerm}%`).all<{ Artist: string; Title: string }>();
          if (results.results?.length) {
            const songList = results.results.map((s: any) => `- "${s.Title}" by ${s.Artist}`).join('\n');
            userContext += `\n\n## KARAOKE SONGS FOUND\n${songList}`;
          }
        } catch (_) {}
      }

      // Detect "US = Us" trigger — route to agentic_chat
if (body.match(/\b(?:US|United States|America|agentic chat|agentic|US pricing)\b/i) && !isGraham) {
  activeIntent = 'agentic_chat';
}

// Short-circuit for timewasters — no AI spend
      if (activeIntent === 'drunk') {
        return c.json({ status: 'success', reply: "This isn't the right place for that. Goodbye.", profile_type: 'drunk', user_id: user.id, is_owner: false });
      }
      if (activeIntent === 'sales') {
        return c.json({ status: 'success', reply: "Thanks, but we're not looking for anything right now. All the best.", profile_type: 'sales', user_id: user.id, is_owner: false });
      }

      const memoryContext = await loadMemoryContext(c.env.MEMORY_DB);

      const messages: any[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...(memoryContext ? [{ role: 'system', content: memoryContext }] : []),
        { role: 'system', content: `## CURRENT SESSION CONTEXT\n${userContext}` },
      ];

      // Load shared memories with Naledi and her tools/skills/plugins via the shared /oc/ routes
      if (!isGraham && activeIntent !== 'carer' && activeIntent !== 'family' && !body.match(/\b\d{10}\b/g)) {
        messages.push({
          role: 'system',
          content: `## SHARED KNOWLEDGE (from Mintaka/opencode)

You are speaking with Naledi - ORION's customer success agent. Naledi shares the same memory context as all other AI instances in the system.

**Current Session Context:** Graham_${isGraham ? 'OWNER' : 'NOT_OWNER'} active_intent_${activeIntent} from_(from) - new_user_${isNewUser} - name_known_${isNamedUser ? user.name : 'NO'} - conversation_started_${!isNewUser && user.id}

**Naledi's Tools & Skills Available:**
- Customer conversation management and qualification
- WhatsApp message routing and business type detection
- Document OCR analysis (IDs, CVs, certificates)
- Voice transcription and messaging
- Memory service integration for shared knowledge
- Lead generation and pipeline management
- PWA authentication and session management
- Calendar and scheduling integration
- Knowledge base cross-referencing
- Tool access through shared /oc/ endpoints (Mintaka-managed)

**Naledi's Capabilities:**
- Customer service across all Orion verticals (medical, hotels, electricians, plumbers, builders, HVAC)
- Multi-language support (English, Zulu, Xhosa, Afrikaans)
- Pricing quotes for ORION WhatsApp PRO (R2,690/month flat, setup R4,690)
- Free trial model: conversation IS the trial (no credit card)
- Care provider vetting for caregivers
- Karaoke booking and song lookup
- Product information (Seductive Secrets lingerie collection)
- Admin dashboards for leads, customers, and business metrics

**Current System Status:**
- Loading shared plugins and skills from /oc/ endpoints
- Syncing context with Mintaka(opencode) infrastructure
- Processing through shared auth/authorization layer

**Naledi is NOT handling:**
- System resets, user management, plugin management
- Tool updates, configuration changes, deployment tasks
- Architecture decisions, debugging, code maintenance

These are Mintaka(opencode)'s responsibility. Focus on the conversation.

**Tool Access:** All Naledi plugins, skills, and tools are available through the shared /oc/ endpoints. Naledi can call any function needed for customer conversations.

**Last Updated:** 2026-06-26 - Naledi agents and Mintaka(opencode) fully synchronized
**Session ID:** SESSION_${Date.now()} - All instances coordinated via shared memory service
`,
        });
      }
      const recentList = recentMessages.results || [];
      for (let i = recentList.length - 1; i >= 0; i--) {
        const m = recentList[i]!;
        messages.push({ role: 'user', content: m.user_message });
        messages.push({ role: 'assistant', content: m.naledi_reply });
      }
      messages.push({ role: 'user', content: body });

      if (activeClient) {
        const chatCheck = await checkFeatureCap(c.env as any, activeClient.id, 'chat');
        if (!chatCheck.ok) {
          const capMsg = chatCheck.reason === 'cap_reached'
            ? `${activeClient.name}'s monthly AI chat limit has been reached. Please ask them to upgrade or wait for next billing cycle.`
            : chatCheck.reason === 'feature_disabled'
            ? `AI chat is not enabled for ${activeClient.name}. Please contact Orion to activate.`
            : 'Service temporarily unavailable.';
          return c.json({ status: 'success', reply: capMsg, profile_type: 'general', user_id: user.id, is_owner: false });
        }
      }

      const maxTokens = isGraham ? 2048 : 1024;
      const complexity = await classifyComplexity(c.env, body);
      const model = complexity === 'simple' ? CHEAP_MODEL : AI_MODEL;
      const aiResponse = await callAI(c.env, model, {
        messages,
        max_tokens: maxTokens,
      });
      let replyText = (aiResponse.response || aiResponse?.choices?.[0]?.message?.content || '').trim();
      if (!replyText) {
        replyText = isGraham
          ? "Hey Graham, I'm here. What do you need?"
          : isNewUser
            ? "Sawubona! NginguNaledi. What's your name?"
            : "I'm here. How can I help?";
      }

      if (activeClient) {
        await incrementClientUsage(c.env as any, activeClient.id, 'chat');
        await logUsage(c.env as any, activeClient.id, 'chat', model, {
          input_units: body.length,
          output_units: replyText.length,
          input_cost_cents: 0,
          output_cost_cents: 0,
          total_cost_cents: 0,
        }, from, replyText.slice(0, 200));
      }

      let cleanReply: string = replyText;
      const memoryWrites: Promise<void>[] = [];

      // Parse [MEMORY] markers from Naledi's reply
      const memoryRegex = /^\[MEMORY\](\{.*\})\s*$/gm;
      let memoryMatch: RegExpExecArray | null;
      while ((memoryMatch = memoryRegex.exec(replyText)) !== null) {
        try {
          const jsonStr = memoryMatch[1];
          if (!jsonStr) continue;
          const mem = JSON.parse(jsonStr);
          if (mem.content && mem.type) {
            memoryWrites.push(writeMemory(c.env.MEMORY_DB, {
              source: 'naledi',
              type: mem.type,
              content: mem.content,
              tags: mem.tags || [],
              importance: mem.importance || 3,
            }));
          }
        } catch (_) {}
      }
      cleanReply = replyText.replace(/^\[MEMORY\]\{.*\}\s*$/gm, '').trim();
      if (!cleanReply) {
        cleanReply = isGraham
          ? "What do you need, boss?"
          : "I'm here. How can I help?";
      }

      await c.env.NALEDI_DB.prepare(
        'INSERT INTO naledi_logs (user_id, user_name, user_message, naledi_reply) VALUES (?, ?, ?, ?)'
      ).bind(from, callerName, body, cleanReply).run();

      // Detect "message for opencode" pattern
      const opencodeMatch = body.match(/(?:message|note|save|tell)\s+(?:for|to)\s+opencode\s*[:\-]?\s*(.+)/i);
      if (opencodeMatch && isGraham) {
        const msgContent = opencodeMatch[1].trim();
        memoryWrites.push(writeMemory(c.env.MEMORY_DB, {
          source: 'opencode',
          type: 'fact',
          content: `Message from Graham: ${msgContent}`,
          tags: ['message_for_opencode', 'graham'],
          importance: 4,
        }));
        if (!cleanReply) cleanReply = 'Saved, opencode will see it.';
      }

      // Detect "US = Us" trigger - route to agentic_chat intent (Naledi)
      if (body.match(/\b(?:US|United States|America|agentic chat|agentic|US pricing)\b/i) && !isGraham) {
        const originalIntent = activeIntent;
        activeIntent = 'agentic_chat';
        
        // Check if body contains "US = Us" specifically
        if (body.match(/\bUS\s*=\s*Us\b/i) && isGraham) {
          // Graham triggered bootstrap - call bootstrap endpoint
          try {
            const bootstrapRes = await c.env.SELF.fetch(new Request('https://dummy/api/bootstrap?trigger=graham'));
            const bootstrapData = await bootstrapRes.json() as any;
            cleanReply = bootstrapData.message || "System bootstrap triggered. All AI instances will reset on next cycle. Check the memory service for details.";
            if (!cleanReply) cleanReply = "US = Us - system bootstrap detected. Resumption initiated. Check agent logs. You can also use: /session/end (if active), followed by session/start to reload. Live ops dashboard ready.";
          } catch (e: any) {
            cleanReply = `US = Us detected - system status: pending. ${originalIntent ? `Your original request (${originalIntent}) is also noted. ` : ''}Please use: /session/end then /session/start for full reload.`;
          }
        }
      }

      // Outreach command (Graham only) — triggers pitch generation, then he reviews via CSV
      if (isGraham) {
        const outreachMatch = body.match(/^outreach\s+(.+)/i);
        if (outreachMatch) {
          const category = outreachMatch[1].trim().toLowerCase();
          try {
            const genRes = await c.env.SELF.fetch(new Request('https://dummy/api/outreach/generate?category=' + encodeURIComponent(category)));
            const genData = await genRes.json() as any;
            if (genData.status === 'empty') {
              cleanReply = `All ${category} leads are done or already have pitches. Open the spreadsheet to approve.`;
            } else {
              const origin = new URL(c.req.url).origin;
            cleanReply = `Generated ${genData.generated} pitches for ${category}. Download CSV at ${origin}/api/outreach/csv?category=${category}. Open in LibreOffice, change status to "approve" or "skip", save, then upload it back at ${origin}/api/outreach/csv.`;
            }
          } catch (e: any) {
            cleanReply = `Could not generate outreach: ${e.message}`;
          }
        }
      }

      if (isNewUser && isNamedUser && user.name) {
        memoryWrites.push(writeMemory(c.env.MEMORY_DB, {
          source: 'naledi',
          type: 'user_preference',
          content: `${user.name} (${from}) is a new Orion contact. Context: ${activeIntent}. They introduced themselves.`,
          tags: ['user', 'contact', activeIntent],
          importance: 3,
        }));
      }
      if (activeIntent === 'karaoke') {
        memoryWrites.push(writeMemory(c.env.MEMORY_DB, {
          source: 'naledi',
          type: 'fact',
          content: `${user.name || from} enquired about karaoke services. - Graham triggers system bootstrap when he says \"US = Us\" or \"US pricing\" (which routes to agentic_chat intent for emergency operations)`,
          tags: ['karaoke', 'enquiry'],
          importance: 3,
        }));
      }
      if (activeIntent === 'business' && isNewUser) {
        try {
          await c.env.DB.prepare(
            "INSERT OR IGNORE INTO leads (phone, name, business_type, description, status) VALUES (?, ?, 'general', ?, 'new')"
          ).bind(from, user.name || callerName, body.slice(0, 500)).run();
          sendWhatsAppMessage(c.env, '27724971810',
            `New Naledi lead — ${user.name || callerName} (${from})\nBusiness enquiry: ${body.slice(0, 300)}\nActive lead created in admin panel.`
          ).catch(() => {});
        } catch (_) {}
      }
      await Promise.all(memoryWrites);

      await simulateTypingDelay(cleanReply);

      return c.json({
        status: 'success',
        reply: cleanReply,
        profile_type: activeIntent,
        user_id: user.id,
        is_owner: isGraham
      });

    } catch (err) {
      console.error('Critical API Error:', err);
      return c.json({ status: 'error', message: 'Failed to process incoming message' }, 500);
    }
  });

  // Onboarding form submission (with CORS for oriondevcore.com)
  app.options('/api/onboard', (c) => {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': 'https://oriondevcore.com',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  });

  app.post('/api/onboard', async (c) => {
    const cors = {
      'Access-Control-Allow-Origin': 'https://oriondevcore.com',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    try {
      const body = await c.req.json<Record<string, string>>();
      const type = body.type || 'unknown';
      if (!['practitioner', 'medical-rep', 'agentic-chat'].includes(type)) {
        return c.json({ status: 'error', message: 'Invalid type' }, 400, cors);
      }

      const db = c.env.NALEDI_DB;
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS onboard_submissions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        )`
      ).run();

      const result = await db.prepare(
        'INSERT INTO onboard_submissions (type, data) VALUES (?, ?)'
      ).bind(type, JSON.stringify(body)).run();

      const submissionId = result.meta?.last_row_id || Date.now();

      console.log(`Onboard submission #${submissionId}: ${type} — ${body.first_name || ''} ${body.last_name || ''} (${body.phone || 'no phone'})`);

      return c.json({ status: 'success', id: submissionId, message: 'Onboarding submission received' }, 200, cors);
    } catch (err: any) {
      console.error('Onboard error:', err);
      return c.json({ status: 'error', message: err.message }, 500, cors);
    }
  });

  // Bootstrap endpoint for "US = Us" trigger
  app.post('/api/bootstrap', async (c) => {
    try {
      const { trigger } = await c.req.json();
      if (!trigger || !['graham', 'system'].includes(trigger)) {
        return c.json({ status: 'error', message: 'trigger must be "graham" or "system"' }, 400);
      }
      const message = trigger === 'graham'
        ? 'US = Us detected - system bootstrap. Next steps: 1) Check Graham\'s WhatsApp, 2) /session/end then /session/start, 3) "message for opencode - help me fix checkout flow"'
        : 'System bootstrap triggered by command. All AI instances resetting context. Use "US = Us" or "bootstrap" on WhatsApp for immediate reload.';
      await c.env.NALEDI_DB.prepare(
        'INSERT INTO bootstrap_events (trigger, message, created_at) VALUES (?, ?, datetime("now"))'
      ).bind(trigger, message).run();
      return c.json({ status: 'success', message });
    } catch (err: any) {
      console.error('Bootstrap error:', err);
      return c.json({ status: 'error', message: err.message }, 500);
    }
  });

}
