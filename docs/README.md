# Automated Property Underwriting Pipeline

Hands-free n8n workflow: webhook or Google Form intake → Census enrichment → investment math → AI resale strategy → Notion deal page → JSON confirmation.

**Status:** Demo-ready (June 2026).

---

## What this system does

When a property lead arrives:

1. **WF1 — Validate & Normalize** — checks required fields, coerces types, assigns a `runId`.
2. **WF2 — Enrich (Census)** — geocodes the address, pulls median home value, income, and population.
3. **WF3 — Math Engine** — repair estimate, ARV, max offer (70% rule), assignment offer, mortgage, deal score.
4. **WF4 — AI Strategy** — Gemini 2.5 Flash structured JSON, with a template fallback if AI fails.
5. **WF5 — Notion Writer** — numbers in database columns, strategy in the page body.
6. **WF0 — Orchestrator** — returns confirmation JSON with runId, address, dealScore, arvEstimate, arvConfidence.

Bad data is rejected early. API failures degrade gracefully. No manual steps.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────────────────────────────────┐
│ Google Form │────▶│ Apps Script  │────▶│ ngrok → WF0 Webhook (Orchestrator)          │
└─────────────┘     └──────────────┘     │                                             │
                                         │  WF1 Validate → WF2 Enrich → WF3 Math       │
┌─────────────┐                          │       → WF4 Strategy → WF5 Notion           │
│ Any system  │─── POST JSON ───────────▶│       → Build Response → Respond            │
└─────────────┘                          └─────────────────────────────────────────────┘
                                                              │
                                                              ▼
                                                    Notion Deal Pipeline
```

## Workflows

| ID | Name | Role |
|----|------|------|
| WF0 | Orchestrator | Public webhook, chains WF1–WF5, returns JSON confirmation |
| WF1 | Validate & Normalize | Quality gate, runId, type coercion |
| WF2 | Enrich (Census) | Geocode → FIPS → ACS metrics, 3 safe exit paths |
| WF3 | Math Engine | Deterministic underwriting formulas |
| WF4 | AI Strategy | Gemini structured JSON + template fallback |
| WF5 | Notion Writer | Database page + strategy body |

## Design principles

- **Bottom-up build** — each sub-workflow tested alone before wiring WF0.
- **Math ≠ AI** — dollar figures are auditable formulas; AI only handles language and judgment.
- **Same output shape from every branch** — WF2's three exit paths return identical field names.
- **Fail safe** — validation stops bad leads; enrichment and AI have fallbacks.

## Build order

WF1 → WF2 → WF3 → WF4 → WF5 → WF0

Full JavaScript for every Code node: `code-nodes-explained.md`

---

## Environment setup

### Prerequisites

| Requirement | Notes |
|-------------|-------|
| Docker | n8n runs in a container |
| n8n | Editor at `http://localhost:5678` |
| Census API key | Free; ACS data (geocoder needs no key) |
| Gemini API key | Google AI Studio, free tier |
| Notion account | Internal integration + Deal Pipeline database |
| ngrok | Demo only — exposes local n8n to Google Apps Script |
| Google account | For Form + Apps Script (optional) |

### Run n8n in Docker

```bash
docker run -d --name n8n \
  -p 5678:5678 \
  -v n8n_data:/home/node/.n8n \
  -e CENSUS_API_KEY="your-census-key" \
  -e GEMINI_API_KEY="your-gemini-key" \
  n8nio/n8n
```

Open `http://localhost:5678` and complete first-time setup. Workflows and credentials persist in the `n8n_data` volume. Re-pass env vars if you recreate the container.

### Expose n8n with ngrok (Google Form demo)

```bash
ngrok config add-authtoken YOUR_NGROK_TOKEN
ngrok http 5678
```

Production webhook URL:

```
https://YOUR-NGROK-HOST/webhook/YOUR-WEBHOOK-PATH
```

Update Apps Script `WEBHOOK_URL` whenever ngrok restarts.

### Publish workflows

Publish WF1–WF5 first, then WF0. Test URLs (`/webhook-test/...`) work while editing without publish.

---

## API keys and credentials

Never commit API keys to git. Store secrets in n8n credentials or environment variables.

### Census API key (free)

1. Go to https://api.census.gov/data/key_signup.html
2. Enter organization name and email.
3. Check email and click the activation link.
4. Save the key.

Used by WF2 ACS HTTP Request (`key` query parameter). Geocoder needs no key.

**Gotcha:** A bad Census key returns HTTP 200 + HTML. n8n treats this as success. WF2 Shape Enrichment detects HTML and falls back.

### Gemini API key (free tier)

1. Go to https://aistudio.google.com
2. Sign in → Get API key → Create API key.
3. Copy the key.

```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=YOUR_KEY
```

Model: gemini-2.5-flash with `responseMimeType: application/json` and fixed `responseSchema`.

### Notion integration token

1. Go to https://www.notion.so/my-integrations
2. New integration → Internal → name it (e.g. "n8n Deal Pipeline").
3. Copy the Internal Integration Secret (starts with `ntn_`).
4. In n8n: Credentials → Notion API → save as `Notion - Deal Pipeline`.
5. Connect integration to Deal Pipeline database (see Notion section below).

### Webhook secret (optional for demo)

```powershell
[guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
```

Webhook node → Header Auth → header `x-webhook-secret`. Skipped for demo.

### Where keys live in n8n

| Key | Storage |
|-----|---------|
| Notion | n8n Notion credential |
| Census | Query param on ACS node or `$env.CENSUS_API_KEY` |
| Gemini | Query param on Gemini node or `$env.GEMINI_API_KEY` |
| Webhook secret | Header Auth credential on Webhook node |

---

## Notion Deal Pipeline database

### Create the database

1. In Notion: new page → Table – Full page → name **Deal Pipeline**.
2. Add properties (exact names matter):

| Property | Type | Options / notes |
|----------|------|-----------------|
| Address | Title | Default title column |
| City/State | Text | |
| Asking Price | Number | |
| ARV Estimate | Number | |
| ARV Confidence | Select | High, Medium, Low |
| Repair Estimate | Number | |
| Est. Monthly Payment | Number | |
| Max Offer (MAO) | Number | |
| Assignment Offer | Number | |
| Deal Score | Number | |
| Status | Select | New, Reviewed, Rejected |
| Run ID | Text | |
| Created | Date | |

### Connect the integration

Database → ⋯ menu → Connections → Connect to → select your integration. Without this, API returns "object not found."

### Save the database ID

Copy the 32-character ID from the database URL (before `?`). Used in WF5's Notion node.

### Page body (WF5)

- Marketing Summary — `strategy.marketingSummary`
- Target Buyers — `strategy.targetBuyerCriteria`
- Asset Highlights — `strategy.assetHighlights`
- Negotiation Points — `strategy.negotiationTalkingPoints`

### WF5 property mapping

| Notion property | Expression |
|-----------------|------------|
| Address (title) | `{{ $json.address }}` |
| City/State | `{{ $json.city }}, {{ $json.state }}` |
| Asking Price | `{{ $json.askingPrice }}` |
| ARV Estimate | `{{ $json.arvEstimate }}` |
| ARV Confidence | `{{ $json.arvConfidence }}` |
| Repair Estimate | `{{ $json.repairEstimate }}` |
| Est. Monthly Payment | `{{ $json.monthlyPI }}` |
| Max Offer (MAO) | `{{ $json.maxOffer }}` |
| Assignment Offer | `{{ $json.assignmentOffer }}` |
| Deal Score | `{{ $json.dealScore }}` |
| Status | `New` |
| Run ID | `{{ $json.runId }}` |
| Created | `{{ $json.receivedAt }}` |

WF3 must emit ARV Confidence as `High`, `Medium`, or `Low` (not `Med`).

---

## Lead data contract

| Field | Type | Required | Rules |
|-------|------|----------|-------|
| address | string | yes | Street address |
| city | string | yes | |
| state | string | yes | 2-letter code (TX, not Texas) |
| zip | string | yes | 5 digits |
| beds | number | no | |
| baths | number | no | |
| sqft | number | yes | Positive |
| yearBuilt | number | yes | 1800–2100 |
| askingPrice | number | yes | Positive; `"$250,000"` coerced by WF1 |
| condition | string | no | good / fair / poor |
| notes | string | no | Free text |

### Example payload

```json
{
  "address": "120 Maple Ave",
  "city": "Columbus",
  "state": "OH",
  "zip": "43004",
  "beds": 3,
  "baths": 2,
  "sqft": 1500,
  "yearBuilt": 2006,
  "askingPrice": 120000,
  "condition": "good",
  "notes": "motivated seller"
}
```

### WF1 output

Adds: `runId`, `receivedAt`, `oneLineAddress`, `propertyAgeYears`, cleaned types.

### Webhook confirmation response

```json
{
  "status": "received",
  "runId": "120-maple-ave-43004-2026-06-16t18-03-55-468z",
  "address": "120 Maple Ave",
  "dealScore": "0",
  "arvEstimate": "225900",
  "arvConfidence": "High"
}
```

Built by Build Response Set node referencing Call WF4 (not WF5).

---

## Workflows — build guide

### WF1 — Validate & Normalize

**Trigger:** Execute Workflow Trigger (rename `Lead In`).

**Nodes:** Lead In → Code `Validate` (Run Once for Each Item)

- Reads `input.body ?? input`
- Coerces numbers, trims text, uppercases state
- Rejects with `Validation failed: ...`
- Adds runId, oneLineAddress, propertyAgeYears

**Test:** Pin valid JSON → green. Remove sqft → error.

### WF2 — Enrich (Census)

**Trigger:** `Lead In`

```
Lead In → Geocode → Parse FIPS → IF (matched?)
  ├─ TRUE  → ACS → Shape Enrichment
  └─ FALSE → Enrichment Fallback
```

**Geocode** (HTTP GET, no key):
- URL: `https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress`
- Params: `address={{ $json.oneLineAddress }}`, `benchmark=Public_AR_Current`, `vintage=Current_Current`, `format=json`

**ACS** (HTTP GET):
- URL: `https://api.census.gov/data/2023/acs/acs5`
- Params: `get=NAME,B25077_001E,B19013_001E,B01003_001E`, `for=tract:...`, `in=state:... county:...`, `key=...`

**Shape Enrichment:** parses ACS response, filters `-666666666` sentinels, detects bad-key HTML.

**Enrichment Fallback:** same output shape with nulls and `enrichmentNote`.

### WF3 — Math Engine

**Trigger:** `Math In` → Code `Underwrite`

| Metric | Logic |
|--------|-------|
| Repair estimate | $/sqft by condition (good 15, fair 35, poor 65) + age bump × sqft |
| ARV | Average of regional median and asking × 1.15 |
| ARV confidence | High / Medium / Low |
| Max offer (MAO) | ARV × 70% − repairs |
| Assignment offer | MAO − $10,000 fee |
| Monthly P&I | 20% down, 7%, 30-year |
| Deal score | 0–100 from MAO vs asking spread |

### WF4 — AI Strategy

**Trigger:** `Math In` → HTTP `Gemini` → Code `Parse Strategy`

- Gemini: structured JSON schema, On Error Continue
- Parse Strategy reads `$('Math In').first().json`
- Fallback template if AI fails; arrays guarded with `?? []`
- **Trigger must be named exactly `Math In`**

### WF5 — Notion Writer

**Trigger:** `Deal In` → Notion Create Database Page. See property mapping above.

Outputs Notion page object (not the deal — why WF0 needs Build Response).

### WF0 — Orchestrator

```
Webhook → Call WF1 → Call WF2 → Call WF3 → Call WF4 → Call WF5
       → Build Response → Respond to Webhook
```

**Build Response** (Set node):

| Field | Value |
|-------|-------|
| status | received |
| runId | `{{ $('Call WF4').item.json.runId }}` |
| address | `{{ $('Call WF4').item.json.address }}` |
| dealScore | `{{ $('Call WF4').item.json.dealScore }}` |
| arvEstimate | `{{ $('Call WF4').item.json.arvEstimate }}` |
| arvConfidence | `{{ $('Call WF4').item.json.arvConfidence }}` |

**Respond to Webhook:** First Incoming Item.

### Trigger naming checklist

| Workflow | Trigger name |
|----------|--------------|
| WF1 | Lead In (optional) |
| WF2 | Lead In |
| WF3 | Math In |
| WF4 | Math In |
| WF5 | Deal In |

Re-check after changing Accept all data — names can reset.

---

## Google Form demo intake

| Form question | JSON field |
|---------------|------------|
| Address | address |
| City | city |
| State code in 2 letters (TX, not Texas). | state |
| Zip | zip |
| Beds / Baths / Sqft / Year Built | beds, baths, sqft, yearBuilt |
| Asking price | askingPrice |
| Condition | condition (dropdown: good/fair/poor) |
| Notes | notes |

Extensions → Apps Script:

```javascript
const WEBHOOK_URL = 'https://YOUR-NGROK-URL/webhook/YOUR-WEBHOOK-PATH';
const SECRET = '';

function getField(responses, title) {
  const want = title.trim().toLowerCase();
  const hit = responses.find(i =>
    i.getItem().getTitle().trim().toLowerCase() === want
  );
  if (!hit) return '';
  const v = hit.getResponse();
  return Array.isArray(v) ? v[0] : v;
}

function getState(responses) {
  const titles = ['State code in 2 letters (TX, not Texas).', 'State'];
  for (const t of titles) {
    const v = getField(responses, t);
    if (v) return v;
  }
  const hit = responses.find(i => /state/i.test(i.getItem().getTitle()));
  if (!hit) return '';
  const v = hit.getResponse();
  return Array.isArray(v) ? v[0] : v;
}

function onFormSubmit(e) {
  const r = e.response.getItemResponses();
  const payload = {
    address: getField(r, 'Address'),
    city: getField(r, 'City'),
    state: getState(r),
    zip: getField(r, 'Zip'),
    beds: getField(r, 'Beds'),
    baths: getField(r, 'Baths'),
    sqft: getField(r, 'Sqft'),
    yearBuilt: getField(r, 'Year Built'),
    askingPrice: getField(r, 'Asking price'),
    condition: getField(r, 'Condition'),
    notes: getField(r, 'Notes')
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  if (SECRET) options.headers = { 'x-webhook-secret': SECRET };
  const res = UrlFetchApp.fetch(WEBHOOK_URL, options);
  Logger.log('Payload: ' + JSON.stringify(payload));
  Logger.log(res.getResponseCode() + ': ' + res.getContentText());
}
```

Trigger: onFormSubmit → On form submit.

Apps Script maps form titles to JSON keys. WF1 validates and normalizes.

**Common mistake:** `state: ""` means question title mismatch. Check Executions → Logs for `Form titles found: [...]`.

---

## Testing

### PowerShell webhook test

```powershell
$body = @{
  address = "120 Maple Ave"; city = "Columbus"; state = "OH"; zip = "43004"
  beds = 3; baths = 2; sqft = 1500; yearBuilt = 2006; askingPrice = 120000
  condition = "good"; notes = "Testing"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:5678/webhook-test/lead-intake" `
  -Method Post `
  -Headers @{ "x-webhook-secret" = "YOUR_SECRET" } `
  -ContentType "application/json" -Body $body
```

### Edge-case matrix (all passed)

| # | Case | Expected |
|---|------|----------|
| C1 | state: "tx" | Normalized to TX |
| C2 | state: "Texas" | Rejected by WF1 |
| C3 | askingPrice: "$250,000" | Coerced to 250000 |
| C4 | zip: "787" | Rejected |
| C5 | Missing sqft | Rejected |
| C8 | yearBuilt: 3000 | Rejected |
| B1 | 123 Main St, Austin, TX | Low confidence, Notion created |
| B2 | Google HQ, Mountain View | Null median, Low/Medium ARV |
| E1 | Invalid Gemini key | Fallback template, chain completes |
| A1 | 4600 Silver Hill Rd, Suitland, MD | High enrichment, real Census data |

### Happy path checklist

1. n8n — all nodes green
2. Notion — new Deal Pipeline page
3. Webhook — populated JSON (not `{{ ... }}`)
4. Apps Script log — `200: {"status":"received",...}`

### Per-workflow isolation

| Workflow | Pin on trigger | Confirm |
|----------|----------------|---------|
| WF1 | Raw lead JSON | runId or validation error |
| WF2 | WF1 output | medianHomeValue or fallback |
| WF3 | WF2 output | arvEstimate, maxOffer, dealScore |
| WF4 | WF3 output | strategy with strategySource |
| WF5 | WF4 output | Notion page created |

Sample outputs: `outputs.md`

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| state must be 2-letter code | Form title mismatch | Fix getState() aliases |
| askingPrice must be positive | Form title mismatch | Match Asking price title |
| Referenced node doesn't exist | Trigger not Math In | Rename trigger in WF3/WF4 |
| Empty webhook response | Respond reads WF5 output | Build Response from Call WF4 |
| .join is not a function | Missing strategy arrays | Guard arrays in Parse Strategy |
| ACS junk / crash | Bad Census key (200 + HTML) | Shape Enrichment fallback |
| Notion object not found | Integration not connected | Connect integration to DB |
| ARV Confidence write fails | Code emitted Med | Use High / Medium / Low |
| Trigger names reset | Changed Accept all data | Re-rename triggers |
| ngrok 404 | URL changed on restart | Update WEBHOOK_URL |

## Known limitations

- Header Auth skipped for demo
- No dedup — resubmit creates duplicate Notion pages
- No error-handler workflow (WF9)
- n8n local — ngrok required for Form intake
- ARV from Census regional median, not MLS comps
- dealScore returned as string in webhook response (cosmetic)

## Bugs fixed during build

- **Bug B:** Empty webhook response — fixed with Build Response Set node from Call WF4.
- **Bug D:** Missing strategy arrays — Parse Strategy defaults arrays to `[]`.
- **Bug A:** ACS bad-key HTML — Shape Enrichment detects and falls back.

## Build timeline

| Day | Milestone | Progress |
|-----|-----------|----------|
| Day 1 | Credentials, WF1, WF2, webhook skeleton | 45% |
| Day 2 | WF3 Math, WF4 Gemini, WF5 Notion | 80% |
| Day 3 | Full chain in WF0 | 95% |
| Day 4 | WF2 hardening, edge-case tests | 98% |
| Day 5 | Bug fixes, Form intake, demo verified | 100% |

## Future production hardening

- Enable Header Auth on production webhook
- Dedup by runId in WF5
- WF9 error-handler → Notion Errors DB
- Deploy n8n to persistent host (not ngrok)

---

## Related files

| File | Contents |
|------|----------|
| `code-nodes-explained.md` | Full JavaScript for every Code node |
| `PRESENTATION.md` | Speaker notes for demos |
| `outputs.md` | Sample workflow outputs |
| `build-log/` | Daily EOD summaries |
| `workflows/` | Importable n8n workflow JSON |

**Result:** Lead in → validated → enriched → underwritten → strategized → filed in Notion → JSON confirmation out. Demo-ready.
