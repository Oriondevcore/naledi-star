# Naledi — Feature Status & Build Plan

## READY TO TEST NOW

| Feature | How |
|---------|-----|
| Core chat | `POST /api/incoming` with `{from, body, name}` |
| Speech-to-text | `POST /api/transcribe` with `{audio: <base64>}` — works now |
| Chat logs | `GET /api/logs` |
| Dashboard | `GET /dashboard` (phone: 27724971810) |
| Naledi landing page | `GET /naledi` |
| Orders & outbox | `POST /api/orders`, `GET /api/outbox` |
| Outreach seed/stats | `POST /api/outreach/seed`, `GET /api/outreach/stats` |
| Pricing plans | `GET /api/plans` |
| Office sheets | `POST /api/office/log-lead`, etc. |
| PWA tokens | `POST /api/pwa/admin/tokens` |
| PrivChat | `POST/GET /api/privchat/*` |
| Onboarding | `POST /api/onboard` |
| Bootstrap | `POST /api/bootstrap` |

## PARTIALLY BUILT

| Feature | Gap | Fix |
|---------|-----|-----|
| Meta Cloud API WhatsApp sending | Needs `META_CLOUD_API_TOKEN` + `META_PHONE_NUMBER_ID` secrets | `wrangler secret put` both |
| Calendar/Bookings | OAuth not connected; needs `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | Visit `/api/calendar/auth` |
| Model routing | `classifyComplexity()` never called — every msg uses expensive model | Wire into n-star.ts |
| Document OCR | `VISION_MODEL = 'glm-4.6v-flash'` doesn't exist in CF model map | Fix constant or use Llama 4 Scout |
| Outreach pitch gen | Uses hardcoded string, not AI | Replace line 223 with AI call |
| Multi-tenant | Client tables exist but no data | Seed `NALEDI_DB.clients` row |
| Payment webhooks | Code written, needs provider secrets | Set YOCO/PAYFAST/STRIPE secrets |
| Quote/invoice PDF | Google Doc template IDs are placeholders | Create real Google Doc templates |

## NOT BUILT YET

- Conversational booking flow (Naledi can't create events for clients)
- Automated onboarding workflow after form submit
- Customer-facing portal
- Multi-language detection (she speaks Zulu/Afrikaans but no lang detect)
- Booking approval workflow
- Weekly/monthly reports
- Agentic Chat (US) flow
- Cost tracking for Whisper STT usage

## SPEC FIXES DONE THIS SESSION (11 Jul)

- [x] System prompt: removed "can't transcribe voice notes" (STT works)
- [x] Meta webhook: downloads audio → Whisper → uses transcribed text
- [x] `stt.js` is dead code (not imported anywhere)
