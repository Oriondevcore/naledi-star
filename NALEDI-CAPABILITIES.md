# Naledi AI — Capability Inventory

> Generated 22 June 2026 from codebase audit.

## Core AI Receptionist

- **24/7 WhatsApp AI** — receives messages, classifies intent (10 types), responds intelligently
- **Multilingual** — English, isiZulu, Afrikaans (auto-detects)
- **Speech-to-Text** — transcribes voice notes via Cloudflare Whisper
- **Document OCR** — reads CVs, IDs, certificates, business docs via vision AI
- **Complexity-based routing** — simple messages use cheap model, complex/sales use expensive
- **AI Memory** — remembers users across sessions, shares knowledge with opencode and other AI instances
- **Testing mode** — Graham can test absurd scenarios with `charlie mode` toggle

## Google Calendar Booking

- **Full OAuth flow** — connect any Google Calendar
- **Check availability** — see free/busy slots
- **Book appointments** — create events with attendees
- **List upcoming** — view scheduled events

## Sales & CRM

- **Auto lead capture** — business enquiries automatically create lead records
- **Graham notified** — WhatsApp notification for every business lead
- **Admin leads dashboard** — qualify, convert, or mark lost
- **Customer management** — view all customers, set plans, pause/activate
- **Subscription plans** — 3 tiers (Starter/Business/Pro) with usage tracking

## Prospect Outreach

- **25 seeded local leads** — Amanzimtoti businesses pre-loaded
- **Pitch generation** — AI generates sales pitches per category
- **CSV approval workflow** — bulk review + approve/skip
- **Business hours enforcement** — only 8am-7pm SAST
- **Daily limits** — 25 messages/day
- **Phone validation** — skips landlines, normalises numbers

## Order Processing

- **Orders API** — art prints, karaoke tracks, Naledi plan subscriptions
- **Email confirmations** — automatic via Cloudflare Email binding
- **Graham notifications** — new orders sent via email

## Document Management

- **Customer upload portal** — branded page for clients to upload PDFs/menus/logos
- **R2 storage** — documents stored in Cloudflare R2
- **AI training data** — uploaded docs can be used to train Naledi on business specifics

## Business Dashboard

- **Live metrics** — today/weekly enquiries, total users, pending orders, outbox status
- **Quick message Graham** — one-click notification to Graham's WhatsApp
- **Auto-refresh** — dashboard updates live

## Karaoke Song Library

- **10,000+ songs** — synced from OpenKJ
- **User search** — "do you have [song]?" queries the database
- **Sync API** — batch upsert from OpenKJ SQLite

## PWA Care Platform (HelpMe)

- **Magic-link auth** — no passwords, token-based login
- **Role dashboards** — elderly, carer, admin views
- **In-app chat** — carer/elderly messaging
- **SOS emergency** — panic button alerts Graham
- **Offline support** — service worker caching

## PrivChat

- **PIN-protected** — 6-digit access code
- **Text + media** — images, voice notes, camera capture
- **Text-to-speech** — reads messages aloud
- **R2 media storage** — files stored in Cloudflare R2

## opencode-mobile

- **Graham's personal AI chat** — talk to opencode from phone
- **SSE real-time streaming** — instant message delivery
- **Voice input** — speech-to-text via browser
- **TTS playback** — reads opencode's replies aloud

## Admin Tools

- **Chat logs** — paginated history of every Naledi conversation
- **Customer management** — plans, pause/activate, usage bars
- **Leads pipeline** — qualify/convert/lost with notes
- **Admin guide** — daily routine, links to all tools
- **Sales outreach dashboard** — bulk messaging control

## What Naledi WON'T Do (by design)

- Quote prices (deferred to Graham)
- Confirm bookings without approval
- Process payments
- Make up data/hallucinate facts
- Send WhatsApp messages directly (requires local daemon)

## Technical Stack

- **Hosting:** Cloudflare Workers (edge compute, 0 cold starts)
- **AI Models:** Z.AI (primary) `glm-4.7` / `glm-4.7-flash` / `glm-4.6v-flash`; Cloudflare Workers AI (fallback)
- **Databases:** 4x D1 (user_db, naledi-chat-db, karaoke-db, ai-memory-db)
- **Storage:** 2x R2 (whatsapp-sessions, naledi-docs)
- **WhatsApp:** Local daemon via whatsapp-web.js + Puppeteer
- **Calendar:** Google Calendar API (OAuth2)
- **Email:** Cloudflare Email Sending
- **Frontend:** Hono server-rendered HTML + vanilla JS PWA
