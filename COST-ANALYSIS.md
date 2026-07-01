# Naledi AI — Real Cost Analysis

> Generated 22 June 2026 from research + codebase analysis

## AI Model Costs (Z.AI / OpenRouter)

| Model | Input / 1M tokens | Output / 1M tokens | Used for |
|---|---|---|---|
| `glm-4.7-flash` | $0.06 | $0.40 | Cheap/simple messages, classifier |
| `glm-4.7` | $0.40 | $1.75 | Complex messages (bookings, enquiries) |
| `glm-4.6v-flash` | $0.30 | $0.90 | Vision/OCR (documents, images) |

## Per-Message Cost Breakdown

**Simple message** (greeting, FAQ, quick answer):
- Classifier: ~200 in + 10 out = $0.000016
- Response (cheap model): ~500 in + 50 out = $0.00005
- **Total: ~$0.00007**

**Complex message** (pricing enquiry, booking, job application):
- Classifier: ~200 in + 10 out = $0.000016
- Response (expensive model): ~1500 in + 200 out = $0.00095
- **Total: ~$0.001**

**Voice note** (transcribe + respond):
- Whisper STT: included in Workers AI
- Then complex message cost
- **Total: ~$0.001**

## Monthly Projection Per Business

| Scenario | Messages/mo | AI cost | STT cost | Total AI |
|---|---|---|---|---|
| Light use (restaurant) | 500 | ~$0.15 | ~$0.01 | **~$0.16** |
| Medium (plumber) | 1,000 | ~$0.35 | ~$0.02 | **~$0.37** |
| Heavy (security co) | 5,000 | ~$1.75 | ~$0.10 | **~$1.85** |
| Extreme (real estate) | 20,000 | ~$7.00 | ~$0.40 | **~$7.40** |

## Infrastructure Costs

| Item | Cost | Notes |
|---|---|---|
| Cloudflare Workers | $5/mo (paid) or free tier | Naledi runs on Workers free tier |
| D1 Databases (4) | Free tier likely enough | 5M rows read/day free |
| R2 Storage (docs) | ~$0/month | Negligible for doc uploads |
| Workers AI (Whisper) | Included in $5 Workers paid | Or free tier limits |
| Domain | ~$10/yr ($0.83/mo) | nwa.oriondevcore.com |
| WhatsApp number | R0/mo (your existing) | Unless getting dedicated SIM |
| Linux machine (daemon) | R0 (your laptop) | Electricity cost negligible |
| **Total fixed** | **~$5.83/mo** | |

## The Truth

Your marginal cost to serve a customer is **essentially zero**.

A plumber paying R1,500/mo (~$80) costs you ~$0.37 in AI. That's **99.5% gross margin** on variable costs.

The only real constraint is your time for:
- Onboarding/setup (website, GBP, docs upload)
- Support/troubleshooting
- Monthly SEO work (if offering that)

## Comparison: What Competitors Would Pay

To build what Naledi does:
- WhatsApp Business API: ~$50-100/mo just for the number
- AI model (GPT-4o): ~$2.50/M input, ~$10/M output — 40x more expensive
- Chatbot platform (ManyChat, etc.): $15-100/mo per seat
- Google Calendar API: free
- Custom development: R50,000-150,000 upfront

You have a structural cost advantage because:
1. Using Z.AI (Chinese models) — 10-100x cheaper than OpenAI
2. WhatsApp Web (free, no API fees) — risky but zero cost
3. Cloudflare Workers edge compute — $0 alternative to VPS

## Risk: WhatsApp Web

The daemon uses `whatsapp-web.js` (unofficial). Risks:
- Account ban (low probability, but real)
- QR re-auth required periodically
- Must run on your local Linux machine 24/7
- No SLA

**Mitigation:** WhatsApp Business API is ~$50/mo if needed later. By then you have revenue.
