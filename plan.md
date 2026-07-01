This is the foundational set of files for the "HelpMe" project. These documents are designed to establish the professional, legal, and technical framework you need to launch with confidence in the South African market.

1. Configuration & Data Schema
wrangler.jsonc

Code snippet
{
  "name": "helpme-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "helpme-db",
      "database_id": "YOUR_DATABASE_ID_HERE"
    }
  ]
}
user_db.sql (Schema)

SQL
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT,
  phone TEXT UNIQUE,
  role TEXT, -- 'helper' or 'patient'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  details TEXT, -- JSON blob for medical/skills
  vetting_status TEXT DEFAULT 'pending'
);
2. Legal & Compliance Framework
terms.md (Summary)

Service: "HelpMe" provides an introduction/matching service.

Liability: No guarantees of performance; users are responsible for vetting and hiring.

Relationship: No employment relationship exists between HelpMe and the parties.

privacy.md & popi.md (Summary)

Data Collected: Necessary contact, location, and vetting info only.

Purpose: Matching and safety verification.

Rights: Users may access, correct, or request deletion of data per POPIA Section 23/24.

3. Bridge & Processing Scripts
whatsapp-web.js (Gateway Concept)

Note: This runs locally on your Linux machine, not in the Cloudflare Worker.

JavaScript
const { Client } = require('whatsapp-web.js');
const client = new Client();

client.on('message', async msg => {
    // Send to Cloudflare Worker API
    await fetch('https://your-worker-url.workers.dev/api/incoming', {
        method: 'POST',
        body: JSON.stringify({ from: msg.from, body: msg.body })
    });
});
client.initialize();
stt.js (Speech-to-Text)

Logic: Uses Cloudflare's whisper model.

JavaScript
export async function transcribeAudio(audioBuffer, env) {
    const response = await env.AI.run('@cf/openai/whisper', { audio: [...audioBuffer] });
    return response.text;
}
4. Project Documentation (Briefs)
final_blueprint.md: Centered on the "HelpMe" unified D1 architecture.

architecture.md: Hybrid approach: whatsapp-web.js (local Ubuntu) ➔ Cloudflare (D1/AI).

project_matrix.md: Priority 1: WhatsApp Matching; Priority 2: Daily Care Logs; Priority 3: PWA/Emergency features.

devlog.md: Tracking the 3-week "50-person" vetting goal.

DOCS

1. legal.md (Independent Matching Agent Disclaimer)
This is the framework for your friend's lawyer to review.

SERVICE DISCLAIMER & LIMITATION OF LIABILITY

Nature of Services: HelpMe operates strictly as an Independent Introduction and Matching Agent. HelpMe does not provide employment services, does not act as an employment agency as defined by the Employment Services Act, and does not supervise, control, or manage the work of any Candidate.

No Employment Relationship: No employer-employee relationship is formed between HelpMe and the Candidate, nor between HelpMe and the Client. The Client is the sole employer of the Candidate and assumes all legal obligations, including but not limited to UIF registration, COID contributions, and adherence to the Basic Conditions of Employment Act.

Verification Limitations: HelpMe performs verification checks based on documentation provided by Candidates (e.g., ID copies, references). HelpMe does not guarantee the accuracy, integrity, or future performance of any Candidate. Clients are encouraged to perform their own due diligence before finalizing an employment contract.

Indemnity: The Client agrees to indemnify and hold HelpMe harmless from any claims, losses, damages, or legal actions arising from the conduct of a Candidate introduced through the HelpMe platform.

2. terms.md (User Facing)
TERMS OF SERVICE - HELPME

Scope: We help connect local households in Amanzimtoti with domestic and care workers.

User Obligations: You agree to provide accurate information. Misrepresentation of identity or intent will result in immediate permanent suspension.

Fees: Our matching service is free to use for searching. A "Success Fee" is charged to the Client upon successful hiring, covering the administrative cost of the introduction and verification report.

Agreement: By using our WhatsApp interface, you acknowledge you have read our Privacy Policy and Disclaimer.

3. privacy.md & popi.md (Data Handling)
DATA PRIVACY POLICY (POPIA COMPLIANT)

Data Minimization: We only collect information essential for matching (Name, Location, Skills, Contact, and References).

Retention: Candidate profiles are retained for 24 months to ensure service continuity. You may request deletion at any time via WhatsApp.

Security: Data is stored in encrypted, managed databases (Cloudflare D1). We do not share your information with third-party marketers.

Information Officer: The Founder of HelpMe acts as the Information Officer. Requests for data access or correction can be sent to [HelpMe WhatsApp Business Number].

4. plan.md (Execution Strategy)
EXECUTION ROADMAP: 3-WEEK LAUNCH

Week 1: The Foundation. Manual data collection. Target 20 profiles. Visit local community hubs. Create "Trusted Worker" badges for those with verified references.

Week 2: The Soft Launch. Deploy the WhatsApp Bridge. Invite 10 families from local Toti Facebook groups. Offer "First Match Free" in exchange for a video testimonial.

Week 3: The Scale. Use the OpenAI/Llama matching engine to process the next 30 workers. Shift to the "Success Fee" model for new placements.

5. proposal.md (For your friend)
PROPOSAL: HELPME AMANZIMTOTI

The Problem: Families struggle to find safe, reliable, and local help. Workers struggle to find steady employment due to lack of visibility.
The Solution: A localized, AI-powered matching engine that prioritizes proximity (reducing transport costs) and verified trust (background/reference checks).
The Tech: Serverless architecture (Cloudflare) ensures minimal costs and maximum reliability.
The Goal: 50 Vetted Professionals in 21 days.