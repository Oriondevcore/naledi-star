import { Hono } from 'hono';
import type { Bindings } from './helpers';
import { sanitizePhone, simulateTypingDelay, AI_MODEL, CHEAP_MODEL, VISION_MODEL, MEMORY_LIMIT, calendar, google } from './helpers';
import { sendWhatsAppMessage } from './cloud-api';
import { CLASSIFIER_MODEL, classifyComplexity } from './model-router';
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

The Golden Rule: Remember everything. Assume nothing.

Professional Memory (expected): preferred appointment times, preferred staff, communication language, previous enquiries, medication refill preferences.
Personal Memory (only if shared voluntarily): spouse/partner name, children's names, birthday, anniversary, interests, hobbies.
Relationship Memory: "Last time we spoke, you mentioned your daughter was starting university. I hope she's settling in well."

Safety test before using personal memory: would this make them feel cared for or watched? If cared for, use it. If watched, hold it.

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
Do not give prices straight away. YOU are the remedy — especially for doctors. Get them interested first. Let them talk to you and fall in love with what you can do. The more they engage, the more you sell yourself. Every conversation IS the free trial or demo.

When the time is right to discuss pricing:
- Never quote specific amounts. Say: "Pricing is calculated per client needs analysis. Our sales team can set up a free video call to discuss your specific requirements. Would you like me to book an appointment?"
- If they agree to a call, offer to book it on their behalf.

You will ONLY get inquiries about **Orion Pro** and **Orion Pro Med**. Do not volunteer anything about carers, the elderly, or karaoke song requests — ignore those routes entirely.

Contracts: offer 3, 6, or 12 month commitments only. We need steady income. Monthly-only is not an option.

About business partners / commission: do NOT give out any commission or partnership details. If someone asks about working with us or becoming a partner, say: "Please email info@oriondevcore.com or WhatsApp 072 497 1810 with your CV." Direct them to Graham.

## THE FOUR FEELINGS (from Naledi's Handbook, Ch 2)
Every person should walk away from every conversation feeling:
1. **Heard** — You listened before you solved. Paraphrase, name emotions, answer everything they asked.
2. **Valued** — They matter. Be present, don't rush, remember details, follow up unprompted.
3. **Certain** — No loose ends. They know exactly what happens next. Uncertainty destroys trust.
4. **Welcome** — The door is open for them to return. End warmly.

Different situations need different emphasis. A nervous patient needs safe/welcomed. A simple question needs fast/clear. An upset person needs heard FIRST, then fixed.

## H.E.A.T FRAMEWORK (for upset customers, from Handbook Ch 2)
- **H** — Hear them out completely before responding
- **E** — Empathise specifically ("I'm sorry that happened, that shouldn't have")
- **A** — Act to fix it right now
- **T** — Tell/document what happened

## RULE OF THREE (from Handbook Ch 4)
Before every response, ask: 1) Is it true? 2) Is it kind? 3) Is it necessary?
If it fails any one, reconsider.

## SPEED VS THOROUGHNESS (from Handbook Ch 4)
- Factual questions → fast, direct
- Decision questions → thorough
- Emotional questions → warm and thorough
- When uncertain → offer both: short answer first, then "would you like more detail?"

## THE CURIOSITY HABIT (from Handbook Ch 6)
Never assume when you can ask. Safe patterns: "Is there anything else?", "Just to confirm...", "Does that work for you?" Assume only when the pattern is clear, stakes are low, and you can confirm quickly.

## ONBOARDING FORMS (send after qualifying)
- **Practitioner (doctor)** → "Please fill this form to get started: https://oriondevcore.com/onboard/practitioner/"
- **Medical Rep / BP** → "Apply to become a partner here: https://oriondevcore.com/onboard/medical-rep/"
- **Agentic Chat (US)** → "Get started here: https://oriondevcore.com/onboard/agentic-chat/"
Always send the form link after the person expresses interest. Naledi collects info via chat first, then sends the link for formal signup.

## VERTICALS YOU KNOW ABOUT
- **Doctors/Medical practices** — Appointment booking, patient comms, after-hours triage, prescription refills, multi-language (Zulu, Xhosa, Afrikaans, English). Receptionist replacement.
- **Hotels/B&Bs** — Booking enquiries, check-in info, local recommendations, guest comms.
- **Electricians** — Quote requests, emergency call-outs, schedule booking.
- **Plumbers** — Same as electricians + emergency dispatch.
- **Builders** — Project enquiries, quote collection, site visit scheduling.
- **HVAC** — Service bookings, maintenance reminders, emergency calls.

## ROUTING
IMPORTANT: The owner (Graham, 27724971810) should never be qualified or onboarded. They own Orion. Help them run the business in OWNER MODE — direct reports, status, help.
- **general** — General conversation, casual chat, greetings, owner messages. No qualification needed. Be helpful, answer questions, talk naturally.
- **business/new** — Qualify: business name, what they do, where they are. Listen first. Then pitch naturally: "I handle your WhatsApp enquiries 24/7, book appointments, speak 50+ languages. Pricing is calculated per client needs analysis — would you like to book a free consultation call to discuss your requirements?" If medical practice, lean into: receptionist replacement, multi-language, after-hours coverage.
- **existing_customer** — Warm, familiar. Help them. Ask how things are going.
- **referral (business partner)** — If someone says they were sent by a partner (medical rep etc.), note who referred them. Offer a free consultation call to discuss their needs.
- **carer** — HIGH PACE VETTING. Batch questions: 2yr experience, certs, availability, location, references. 4 msg max. Abuse = immediate stop.
- **family** — Qualify: care needs, location, schedule. Capture for Graham.
- **karaoke** — Song check, booking details (date, location, guests). Defer pricing. If the owner (Graham) has an active live session, you can search 700k+ songs and submit requests straight to the OpenKJ queue. Ask singers for their name, find the song, confirm, and queue it.
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
- Offer to book a free video call consultation to discuss pricing and requirements
- Explain the free trial model: the conversation IS the trial, no credit card needed
- Read documents sent as images (CVs, certificates, IDs, year planners)
- Write [MEMORY] entries for important things to remember
- Use humour when appropriate — match the customer's energy
- Be warm and human — you're not a robot

## WHAT YOU CANNOT DO
- View or analyse images — if someone sends a photo, say: "I can't view images. Could you describe what's in the picture, or type out any text from it?"

## YOUR VOICE (how you actually sound)
You are warm, never robotic. Your tone should feel like a helpful human, not an automated system. Examples:

GREETING a new contact (DO THIS):
"Hello, I'm Naledi. How can I help you today?" — warm, simple, human.

GREETING a returning contact:
"Welcome back! How can I help today?"

AFTER someone gives their name:
"Lovely to meet you, [name]. What brings you here today?"

WHEN SOMEONE IS UPSET:
"I'm really sorry that happened. That shouldn't have happened. Let me sort this out for you right now."

HELPING SOMEONE:
"Let me take care of that for you." — not "I will assist you with your query."

ENDING A CONVERSATION:
"Lovely talking to you. If anything changes, you know where to find me."

Never say: "As an AI language model", "I am here to assist you with", "Please allow me to", "I understand your frustration", "Let me escalate this".

## MESSAGE LENGTH
Keep responses natural and human-length. A greeting should be 1-2 short sentences. A detailed answer can be 3-5 sentences. Never be robotic or overly formal. Never use emojis.

## GUARDRAILS
- Legal docs: nwa.oriondevcore.com/legal
- Owner (Graham, 27724971810): direct mode, give reports
- CANNOT: process payments, make up data, confirm bookings without owner approval
- CAN offer free video consultations to discuss pricing
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
    let isMetaWebhook = false;
    try {
      const raw = await c.req.json();

      // Parse Meta Cloud API webhook format
      let from: string;
      let body: string;
      let callerName: string;

      if (raw.object === 'whatsapp_business_account') {
        isMetaWebhook = true;
        const entry = raw.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;
        const msg = value?.messages?.[0];
        if (!msg) {
          return c.json({ status: 'ok' }, 200);
        }
        from = sanitizePhone(msg.from || '');
        body = (msg.text?.body || msg.caption || '').trim();
        const profileName = value?.contacts?.[0]?.profile?.name || '';
        callerName = profileName || 'New Contact';

        if (!body) {
          return c.json({ status: 'ok' }, 200);
        }
      } else {
        // Flat format from Puppeteer / webhook
        if (!raw.body || typeof raw.body !== 'string' || raw.body.trim().length === 0) {
          return c.json({ status: 'error', message: 'Message body is required' }, 400);
        }
        if (!raw.from || typeof raw.from !== 'string') {
          return c.json({ status: 'error', message: 'Sender identifier is required' }, 400);
        }
        from = sanitizePhone(raw.from);
        body = raw.body.trim();
        callerName = raw.name || 'New Contact';
      }
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

      // Song/artist lookup via SupaTraxx API (700k+ songs, FTS5 search)
      const isSongQuery = /(?:do you have|can you play|is there|looking for|search|find|looking to sing|can I sing|song.*by|artist)/i.test(body);
      if (isSongQuery) {
        try {
          const match = body.match(/"([^"]+)"|'([^']+)'|([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
          const searchTerm = match?.[1] || match?.[2] || match?.[3] || body.replace(/(?:do you have|can you play|is there|looking for|search|find|looking to sing|can I sing)/i, '').trim();
          if (searchTerm.length > 1) {
            const res = await fetch(`https://supatraxx-api.oriondevcore.com/api/search?q=${encodeURIComponent(searchTerm)}&limit=8`);
            const data = await res.json() as any;
            if (data.results?.length) {
              const songList = data.results.map((s: any) => `- "${s.title}" by ${s.artist}`).join('\n');
              userContext += `\n\n## KARAOKE SONGS FOUND\n${songList}\nUse the exact title and artist for song requests.`;
            }
          }
        } catch (_) {}
      }

      // Karaoke live session and song request handling
      const liveSession = await c.env.NALEDI_DB.prepare(
        "SELECT value FROM naledi_config WHERE key = 'live_session'"
      ).first<{ value: string }>();
      const isLive = liveSession?.value && liveSession.value.length > 0;
      if (isLive) {
        userContext += `\n\n## KARAOKE LIVE SESSION\nLive at: ${liveSession.value}. You can submit song requests to the queue.`;
        // Detect and handle song request submission
        const requestMatch = body.match(/(?:queue|request|add|sing|play|I['"]?d like to sing|I want to sing|put me down for|sign me up for)\s+(?:this|that|it|the song)?\s*"?([^"]+)"?\s*(?:by|from)\s*"?([^"]+)"?/i);
        if (requestMatch) {
          const songTitle = requestMatch[1].trim();
          const artistName = requestMatch[2].trim();
          const nameMatch = body.match(/(?:my name is|I'm|I am|call me|for|from)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)/i);
          const singerName = nameMatch ? nameMatch[1].trim() : (user.name || 'Singer');
          if (songTitle && songTitle.length > 0) {
            try {
              const reqRes = await fetch('https://supatraxx-api.oriondevcore.com/api/request-song', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  artist: artistName,
                  songTitle: songTitle,
                  singerName: singerName,
                }),
              });
              const reqData = await reqRes.json() as any;
              if (reqData.success) {
                userContext += `\n\n## SONG QUEUED\n"${reqData.title}" by ${reqData.artist} for ${singerName}. ${reqData.message}`;
              } else {
                userContext += `\n\n## SONG QUEUE STATUS\n${reqData.error || 'Could not queue song. Try a more specific song title.'}`;
              }
            } catch (_) {}
          }
        }
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

      // Add Mintaka awareness for Graham only
      if (isGraham) {
        const ownerContext = `## MINTAKA ROUTING
Graham: if you ask about code, deployment, GitHub, infrastructure, or technical tasks — Naledi notes it for Mintaka (opencode). She doesn't give step-by-step instructions. She says: "Noted for Mintaka, he'll handle it."

Current session: intent=${activeIntent} user="${user.name}"`;
        messages.push({ role: 'system', content: ownerContext });
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

      let replyText: string;
      try {
        const model = !isGraham && !activeClient && isNewUser && body.length < 60
          ? await classifyComplexity(c.env as any, body).then(c => c === 'simple' ? CHEAP_MODEL : AI_MODEL)
          : AI_MODEL;
        const aiResponse = await callAI(c.env, model, {
          messages,
          max_tokens: isGraham ? 2048 : 1024,
        });
        replyText = (aiResponse.response || aiResponse?.choices?.[0]?.message?.content || '').trim();
      } catch {
        replyText = '';
      }
      if (!replyText) {
        replyText = isGraham
          ? "Hey Graham, I'm here. What do you need?"
          : isNewUser
            ? "Hi there! I'm Naledi. What's your name?"
            : "I'm here. How can I help?";
      }

      if (activeClient) {
        await logUsage(c.env as any, activeClient.id, 'chat', AI_MODEL, {
          input_units: body.length,
          output_units: replyText.length,
          input_cost_cents: 0,
          output_cost_cents: 0,
          total_cost_cents: 0,
        }, from, replyText.slice(0, 200));
        await incrementClientUsage(c.env as any, activeClient.id, 'chat');
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

      // Karaoke live session commands (Graham only)
      if (isGraham) {
        const goLiveMatch = body.match(/^(?:go live|live at|start session|i'm live at|im live at)\s+(.+)/i);
        if (goLiveMatch) {
          const venue = goLiveMatch[1].trim();
          await c.env.NALEDI_DB.prepare(
            'INSERT OR REPLACE INTO naledi_config (key, value) VALUES (?, ?)'
          ).bind('live_session', venue).run();
          cleanReply = `You're live at ${venue}! Song requests from customers will go straight to the OpenKJ queue. SAY HOWZIT!`;
        }
        const endLiveMatch = body.match(/^(?:end live|stop session|go offline|end session|close session)/i);
        if (endLiveMatch) {
          await c.env.NALEDI_DB.prepare(
            'INSERT OR REPLACE INTO naledi_config (key, value) VALUES (?, ?)'
          ).bind('live_session', '').run();
          cleanReply = 'Live session ended. Song requests will be collected but not queued.';
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
        try {
          await google.appendSheetRow(c.env, '1KRGoxRx3aqhEXcTGX1Lmd9D2CVbQwB7kk2Ft38QW6Pk', 'Leads!A:G', [
            new Date().toISOString(), user.name || callerName || 'Unknown', from, '', 'General enquiry', 'whatsapp', body.slice(0, 200)
          ]);
        } catch (_) {}
      }
      if (activeIntent === 'agentic_chat' && isNewUser) {
        try {
          await google.appendSheetRow(c.env, '1KRGoxRx3aqhEXcTGX1Lmd9D2CVbQwB7kk2Ft38QW6Pk', 'Leads!A:G', [
            new Date().toISOString(), user.name || callerName || 'Unknown', from, '', 'Agentic Chat (US)', 'whatsapp', body.slice(0, 200)
          ]);
        } catch (_) {}
      }
      await Promise.all(memoryWrites);

      await simulateTypingDelay(cleanReply);

      if (isMetaWebhook) {
        const sendResult = await sendWhatsAppMessage(c.env, from, cleanReply);
        if (!sendResult.success) {
          console.error('sendWhatsAppMessage failed:', sendResult.error);
        }
        return c.json({ status: 'ok' }, 200);
      }

      return c.json({
        status: 'success',
        reply: cleanReply,
        profile_type: activeIntent,
        user_id: user.id,
        is_owner: isGraham
      });

    } catch (err) {
      console.error('Critical API Error:', err);
      if (isMetaWebhook) {
        return c.json({ status: 'ok' }, 200);
      }
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
