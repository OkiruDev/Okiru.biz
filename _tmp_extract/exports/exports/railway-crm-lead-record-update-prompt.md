# Prompt for the Railway coding agent — update how the okiru.app CRM ingests okiru.biz leads

The `/api/leads/intake` endpoint is live and working — do not change its URL, CORS setup, or response shape (`{"success":true,"leadId":"…"}`). The okiru.biz website forms have since been updated, so the CRM should be updated to make full use of the richer data now arriving. Copy everything below the line into the coding agent working on the okiru.app CRM repo.

---

The okiru.biz website forms now send richer lead data to `/api/leads/intake`. Update the CRM's lead ingestion and lead record display to match. The endpoint contract stays exactly the same — only how leads are stored, categorized and displayed should improve.

## 1. Topic is now always present — use it to categorize

Every submission now includes `fields.topic`. The possible values per `formId`:

**`okiru-biz-contact`** — visitor picks a topic from a dropdown:
- `General enquiry`
- `AI Training`
- `BizBrain (CRM, invoicing & marketing app)`
- `AI tool advice`
- `Website, automation or AI project`
- `Partnership or reselling`
- `Other`
- `BizBrain demo request` ← special: this value is sent (not from the dropdown) when the lead comes from the "Book a demo" form on the BizBrain product page. Treat these as the highest-intent leads.

**`okiru-biz-training`** — `topic` is the training type selected:
`AI-powered Reporting & Analysis`, `Claude/ChatGPT Customisation`, `Copilot Workflow Automation`, `Customised Content`, `Prompt Mastery & Creativity`, `Safe AI Use & Compliance` (fallback: `AI Training`).

**`okiru-biz-mailing`** — `topic` is always `Mailing list signup`.

Requirements:
- Store `topic` on the lead record and show it prominently (as a category/tag).
- Make leads filterable by topic in the CRM UI.
- Do NOT hard-reject unknown topic values — accept any non-empty string, so future website changes don't break intake. Only `formId` should stay strictly validated.

## 2. BizBrain demo requests — parse plan interest

Leads with `topic = "BizBrain demo request"` have a structured `message` that starts with:

```
Demo request from okiru.biz BizBrain page.
Plan interest: <one of the values below>
<optional free-text from the visitor>
```

Plan interest values:
- `Not sure yet`
- `Starter (R999pm)`
- `Growth (R2,500pm)`
- `Own it outright (R20,000 once-off)`

Requirements:
- Parse the `Plan interest:` line and store it as a dedicated field/tag on the lead (e.g. `planInterest`), while keeping the full original message visible.
- Surface these leads clearly — e.g. a "BizBrain demo requests" view or filter, sorted newest first, showing name, phone, email, company and plan interest at a glance. These leads expect contact within one business day.
- These arrive with `formId: okiru-biz-contact` — the topic value is what distinguishes them, not the formId.

## 3. Training requests — structured extras in the message

Training leads (`okiru-biz-training`) append structured lines to the message:

```
Training type: <same as topic>
Candidates: <number>
Proposed date: <free text, e.g. 15-Aug-2026>
Delivery method: Hybrid | In-person | Online
```

Any of these lines may be absent. Parse the ones present into fields on the lead record (candidates, proposedDate, deliveryMethod) while keeping the raw message intact. Phone is now always present on training leads (the website enforces it).

## 4. Mailing list leads

`okiru-biz-mailing` leads now always carry `topic: "Mailing list signup"`. Ensure they are tagged as newsletter subscribers and excluded from any "needs follow-up call" queues — they should not create tasks for the sales pipeline.

## 5. General record display

For every okiru.biz lead, the record should show: name, email, phone, company, topic, plan interest (if any), parsed training fields (if any), full original message, lead source (`web-okiru-biz-contact` / `-training` / `-mailing`), consent (true, POPIA — consent given by form submission), submission timestamp, and the attribution block (utmSource/utmMedium/utmCampaign/utmTerm/utmContent, referrer, landingUrl, submittedFromUrl) so marketing can see which campaign produced each lead.

## 6. Do not break what works

- Keep the endpoint URL, CORS (`https://okiru.biz`, `https://www.okiru.biz`), request/response contract, and required-field validation exactly as they are (contact: name/email/topic/message; training: also phone; mailing: email).
- Re-processing/parsing improvements must also apply cleanly to leads already stored since the endpoint went live (backfill `planInterest`/training fields for existing records where the message matches the patterns).

## Verify when done

```bash
# Demo request — should create a lead with topic "BizBrain demo request" and planInterest "Growth (R2,500pm)":
curl -s -X POST https://okiru.app/api/leads/intake \
  -H "Origin: https://okiru.biz" -H "Content-Type: application/json" \
  -d '{"formId":"okiru-biz-contact","fields":{"name":"Verify Demo","email":"verify-demo@okiru.biz","phone":"+27000000001","company":"Verify Co","topic":"BizBrain demo request","message":"Demo request from okiru.biz BizBrain page.\nPlan interest: Growth (R2,500pm)\nWe run a plumbing business in Durban."},"consent":true,"attribution":{"utmSource":"verify","submittedFromUrl":"https://okiru.biz/okiru-bizbrain.html"}}'

# Training — should create a lead with parsed candidates/date/delivery fields:
curl -s -X POST https://okiru.app/api/leads/intake \
  -H "Origin: https://okiru.biz" -H "Content-Type: application/json" \
  -d '{"formId":"okiru-biz-training","fields":{"name":"Verify Training","email":"verify-training@okiru.biz","phone":"+27000000002","company":"Verify Co","topic":"Prompt Mastery & Creativity","message":"Team needs prompting skills.\nTraining type: Prompt Mastery & Creativity\nCandidates: 12\nProposed date: 15-Aug-2026\nDelivery method: Online"},"consent":true,"attribution":{"submittedFromUrl":"https://okiru.biz/toolkit.html"}}'
```

Then check both records in the CRM UI: topic tags visible, demo lead shows plan interest, training lead shows candidates 12 / proposed date / Online, both filterable, and both safe to delete afterwards.
