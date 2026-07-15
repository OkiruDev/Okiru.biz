# Prompt for the Railway coding agent — add `/api/leads/intake` to the okiru.app CRM

The okiru.biz website is live and its three lead forms (contact, training request, mailing list) POST JSON to `https://okiru.app/api/leads/intake`. That route does not exist yet on the okiru.app service, so browsers get the SPA catch-all HTML with no CORS headers and every submission fails with "Failed to fetch". Leads are being lost right now.

Copy everything below the line into the coding agent working on the okiru.app (CRM) repo on Railway.

---

I need a public lead intake endpoint added to this app so website leads from okiru.biz land in the CRM as leads. The website is already live and posting; the contract below is fixed — implement the server to match it exactly.

## 1. The exact request the website sends

`POST /api/leads/intake` with `Content-Type: application/json`:

```json
{
  "formId": "okiru-biz-contact",
  "fields": {
    "name": "Chengetai Myezwa",
    "email": "cmyezwa@gmail.com",
    "phone": "+27834696248",
    "company": "Okiru (Pty) Ltd",
    "topic": "AI Training",
    "message": "Test"
  },
  "consent": true,
  "attribution": {
    "utmSource": "google",
    "utmMedium": "cpc",
    "utmCampaign": "…",
    "utmTerm": "…",
    "utmContent": "…",
    "referrer": "https://www.google.com/",
    "landingUrl": "https://okiru.biz/toolkit.html?utm_source=google",
    "submittedFromUrl": "https://okiru.biz/toolkit.html#contact"
  }
}
```

Notes on the payload:
- `formId` is one of: `okiru-biz-contact`, `okiru-biz-training`, `okiru-biz-mailing`.
- Inside `fields`: `email` is always present; `name`, `phone`, `company`, `topic`, `message` are optional strings (missing or empty when the visitor left them blank). `topic` only appears on training requests. Training extras (candidate count, proposed date, delivery method) are folded into `message` as extra lines.
- Every key inside `attribution` is optional; the whole `attribution` object may be `{}`.
- `consent` is always `true` (submitting the form is the consent action; note this in the lead record for POPIA purposes).

## 2. The exact response the website expects

The site judges success by `data.success` in the JSON body — not by the HTTP status — and shows `data.error` to the visitor on failure. Always return JSON:

- Success: `{ "success": true, "leadId": "<id of the created CRM lead>" }`
- Failure: `{ "success": false, "error": "<short human-readable message>" }` with an appropriate 4xx/5xx status.

Never let this route fall through to the SPA catch-all — register it BEFORE any `app.get("*")` / history-fallback middleware.

## 3. CORS (this is why the site currently shows "Failed to fetch")

The browser sends a cross-origin request from `https://okiru.biz`. Handle both the `OPTIONS` preflight and the `POST`:

- Allow origins: `https://okiru.biz` and `https://www.okiru.biz` (echo the matching `Origin` back in `Access-Control-Allow-Origin`).
- `Access-Control-Allow-Methods: POST, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type`
- Respond `204` to `OPTIONS` with those headers, without touching the database.

## 4. What to do with each lead in the CRM

1. Validate: reject with `{success:false, error:"A valid email is required."}` if `fields.email` is missing or not email-shaped; reject unknown `formId` values.
2. Create (or upsert by email) a lead/contact in the CRM's existing lead model:
   - Name from `fields.name` (may be empty — fall back to the email local part).
   - Email, phone, company mapped directly.
   - Lead source: `web-okiru-biz-contact`, `web-okiru-biz-training`, or `web-okiru-biz-mailing` depending on `formId`.
   - Keep `fields.topic`, `fields.message`, the full `attribution` object, `consent: true`, and a server-side `submittedAt` timestamp visible on the lead record.
   - If a lead with the same email already exists, do not create a duplicate — attach this submission to the existing record as a new activity/note instead.
3. Mailing-list leads (`okiru-biz-mailing`) should be tagged/flagged as newsletter subscribers in whatever way the CRM models that.
4. Basic abuse protection: rate-limit by IP (e.g. max 10 posts per 10 minutes), cap the JSON body at ~32 KB, and trim/limit every string field (e.g. 2 000 chars for `message`, 300 for the rest). The website already filters bots with a client-side honeypot, so no captcha is needed.
5. Log each accepted lead server-side so submissions are visible in Railway logs.

## 5. Verify when done

```bash
# Preflight — must return 204 with the CORS headers:
curl -si -X OPTIONS https://okiru.app/api/leads/intake \
  -H "Origin: https://okiru.biz" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" | head -15

# Real POST — must return JSON {"success":true,"leadId":"…"}, NOT HTML:
curl -s -X POST https://okiru.app/api/leads/intake \
  -H "Origin: https://okiru.biz" -H "Content-Type: application/json" \
  -d '{"formId":"okiru-biz-contact","fields":{"name":"Test Lead","email":"test@example.com","message":"verification test"},"consent":true,"attribution":{"submittedFromUrl":"https://okiru.biz/toolkit.html"}}'
```

Then confirm the test lead appears in the CRM UI with source `web-okiru-biz-contact`, and finally submit the real contact form on https://okiru.biz to confirm the green success message appears.
