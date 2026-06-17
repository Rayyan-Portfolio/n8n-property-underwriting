# n8n Property Underwriting Pipeline

Automated lead intake → Census enrichment → investment math → AI resale strategy → Notion deal page.

**Stack:** n8n · Census ACS · Gemini 2.5 Flash · Notion · Google Form (demo)

**Status:** Demo-ready

---

## What it does

A property lead arrives (webhook or Google Form). The pipeline validates it, enriches it with free Census data, runs deterministic underwriting math, generates an AI resale strategy, files a deal in Notion, and returns JSON confirmation — no manual steps.

```
Webhook / Form → WF1 Validate → WF2 Enrich → WF3 Math → WF4 Strategy → WF5 Notion → JSON response
```

---

## Repository contents

| Path | Description |
|------|-------------|
| `workflows/` | Six importable n8n workflow JSON files (WF0–WF5) |
| `docs/README.md` | Full build guide, API keys, testing, troubleshooting |
| `code-nodes-explained.md` | JavaScript for every Code node |
| `PRESENTATION.md` | Concise speaker notes for demos |
| `outputs.md` | Sample data per workflow stage |
| `scripts/google-form-apps-script.js` | Google Form → webhook bridge |
| `build-log/` | Daily EOD summaries from the 5-day build |

---

## Quick start

### 1. Run n8n

```bash
docker run -d --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n n8nio/n8n
```

Open http://localhost:5678

### 2. Get API keys

- **Census** (free): https://api.census.gov/data/key_signup.html
- **Gemini** (free): https://aistudio.google.com
- **Notion**: https://www.notion.so/my-integrations

Details in `docs/README.md`.

### 3. Import workflows

In n8n: **Workflows → Import from file** — import in this order:

1. `WF#1 - Validate & Normalize.json`
2. `WF#2 - Enrich (Census).json`
3. `WF#3 - Math Engine.json`
4. `WF#4 - AI Strategy.json`
5. `WF#5 - Notion Writer.json`
6. `WF0 - Orchestrator.json`

### 4. Configure secrets

Workflow exports use placeholders — replace before running:

| Workflow | Placeholder | Where |
|----------|-------------|-------|
| WF2 ACS node | `YOUR_CENSUS_API_KEY` | HTTP query param `key` |
| WF4 Gemini node | `YOUR_GEMINI_API_KEY` | HTTP query param `key` |
| WF5 Notion node | — | Select your Notion credential + Deal Pipeline database |

Rename sub-workflow triggers: `Lead In` (WF1/WF2), `Math In` (WF3/WF4), `Deal In` (WF5).

### 5. Publish and test

Publish WF1–WF5, then WF0. Test with:

```powershell
$body = @{ address="120 Maple Ave"; city="Columbus"; state="OH"; zip="43004"
  beds=3; baths=2; sqft=1500; yearBuilt=2006; askingPrice=120000; condition="good" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:5678/webhook-test/YOUR-PATH" -Method Post -ContentType "application/json" -Body $body
```

---

## Google Form demo

1. Create a Form (field list in `docs/README.md`).
2. Paste `scripts/google-form-apps-script.js` into Apps Script.
3. Expose n8n with ngrok; set `WEBHOOK_URL` in the script.

---

## Documentation

- **Full guide:** `docs/README.md`
- **Presentation:** `PRESENTATION.md`
- **Code reference:** `code-nodes-explained.md`

---

## Security note

Do not commit API keys. Workflow JSON in this repo uses `YOUR_CENSUS_API_KEY` and `YOUR_GEMINI_API_KEY` placeholders. Add real keys only in your local n8n instance.

---

## License

Portfolio / demonstration project. Use and adapt with attribution.
