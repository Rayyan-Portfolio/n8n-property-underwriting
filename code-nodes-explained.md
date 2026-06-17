# Code Nodes Explained

This document describes every **Code** node in the underwriting pipeline: what the code does, and **why** we used custom JavaScript instead of built-in n8n nodes.

---

## Why use Code nodes at all?

n8n has many built-in nodes (HTTP, IF, Set, Notion, etc.), but several steps need logic that is awkward or impossible to express only with expressions:

| Need | Why Code is better |
|------|-------------------|
| Validation with many rules | One place to check fields, coerce types, and throw a clear error |
| Parsing nested API responses | Census geocoder and ACS return nested JSON or split rows — Code can walk structures safely |
| Deterministic math | ARV, MAO, mortgage, deal score need formulas, conditionals, and stored assumptions |
| Guaranteed fallbacks | AI can fail or return bad JSON — Code ensures a usable `strategy` object every time |
| Same output shape from different paths | Three WF2 exits must all return identical field names so WF3 does not branch again |

Code nodes are the **business logic layer** of the project. HTTP/Notion nodes fetch and store; Code nodes **decide and calculate**.

---

## WF1 — Validate & Normalize

**Node name:** `Validate`  
**Mode:** Run Once for Each Item  
**Workflow:** `WF#1 - Validate & Normalize`

### What the code does

1. **Reads input** — Uses `input.body ?? input` so it works from the webhook (data under `body`) or from direct tests.
2. **Coerces types** — `num()` strips symbols from strings like `"$250,000"` and returns a number or `null`.
3. **Normalizes text** — Trims strings, uppercases state, lowercases condition.
4. **Validates** — Collects errors for missing/invalid address, city, state (must be 2 letters), zip (5 digits), sqft, yearBuilt, askingPrice.
5. **Stops early** — If any error, throws `Validation failed: ...` so bad leads never reach Census or Notion.
6. **Enriches metadata** — Builds `runId` (from address + zip + timestamp), `receivedAt`, `oneLineAddress`, `propertyAgeYears`.

### Why code was needed

- Webhook payloads wrap the lead in `body`; sub-workflow tests send a flat object — one line handles both.
- Validation rules are multi-field (e.g. state regex + zip regex + positive numbers). A single Code node is clearer than many IF + Set nodes.
- `runId` generation from address + time is custom string logic.
- Throwing on failure is the standard pattern to stop the workflow with a readable error.

```javascript
// WF1 - Validate & Normalize
const input = $input.item.json;
const lead = input.body ?? input;

const errors = [];
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const address = (lead.address ?? '').toString().trim();
const city    = (lead.city ?? '').toString().trim();
const state   = (lead.state ?? '').toString().trim().toUpperCase();
const zip     = (lead.zip ?? '').toString().trim();
const beds    = num(lead.beds);
const baths   = num(lead.baths);
const sqft    = num(lead.sqft);
const yearBuilt   = num(lead.yearBuilt);
const askingPrice = num(lead.askingPrice);
const condition   = (lead.condition ?? 'unknown').toString().trim().toLowerCase();
const notes       = (lead.notes ?? '').toString().trim();

if (!address) errors.push('address is required');
if (!city) errors.push('city is required');
if (!/^[A-Z]{2}$/.test(state)) errors.push('state must be a 2-letter code');
if (!/^\d{5}(-\d{4})?$/.test(zip)) errors.push('zip must be 5 digits');
if (sqft === null || sqft <= 0) errors.push('sqft must be a positive number');
if (yearBuilt === null || yearBuilt < 1800 || yearBuilt > 2100) errors.push('yearBuilt looks invalid');
if (askingPrice === null || askingPrice <= 0) errors.push('askingPrice must be a positive number');

if (errors.length) {
  throw new Error('Validation failed: ' + errors.join('; '));
}

const stamp = new Date().toISOString();
const runId = (address + '|' + zip + '|' + stamp)
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

return {
  json: {
    runId,
    receivedAt: stamp,
    address, city, state, zip,
    oneLineAddress: `${address}, ${city}, ${state} ${zip}`,
    beds, baths, sqft, yearBuilt,
    propertyAgeYears: new Date().getFullYear() - yearBuilt,
    askingPrice, condition, notes,
  },
};
```

---

## WF2 — Parse FIPS

**Node name:** `Parse FIPS`  
**Mode:** Run Once for Each Item  
**Workflow:** `WF#2 - Enrich (Census)`

### What the code does

1. **Loads the original lead** from the trigger node `Lead In` (Geocode output does not include the lead).
2. **Reads geocoder JSON** — Looks at `result.addressMatches`.
3. **No match** — Returns lead + `geocodeStatus: 'nomatch'` for the IF node FALSE branch.
4. **Match** — Extracts Census tract from `geographies['Census Tracts']` and sets `fipsState`, `fipsCounty`, `fipsTract`, `matchedAddress`, `geocodeStatus: 'matched'`.

### Why code was needed

- The HTTP node only returns the geocoder response; we must **merge** it with the lead from an earlier step (`$('Lead In')`).
- FIPS codes live deep inside nested arrays — not mappable with simple Set/IF expressions.
- `geocodeStatus` is a single flag the IF node uses to choose ACS vs geocode fallback.

```javascript
const lead = $('Lead In').item.json;
const geo = $input.item.json;

const matches = geo?.result?.addressMatches ?? [];
if (!matches.length) {
  return { json: { ...lead, geocodeStatus: 'nomatch' } };
}
const tract = matches[0].geographies?.['Census Tracts']?.[0] ?? {};
return {
  json: {
    ...lead,
    geocodeStatus: 'matched',
    matchedAddress: matches[0].matchedAddress ?? null,
    fipsState: tract.STATE ?? null,
    fipsCounty: tract.COUNTY ?? null,
    fipsTract: tract.TRACT ?? null,
  },
};
```

---

## WF2 — Shape Enrichment

**Node name:** `Shape Enrichment`  
**Mode:** Run Once for All Items  
**Workflow:** `WF#2 - Enrich (Census)` — TRUE branch after ACS succeeds

### What the code does

1. **Combines three sources** — Lead (`Lead In`), FIPS (`Parse FIPS`), and all ACS HTTP items (`$input.all()`).
2. **Handles ACS table format** — ACS returns header row + data row as **two items**; code pairs column names to values.
3. **Maps Census fields** — `NAME` → region name; `B25077_001E` → median home value; `B19013_001E` → median income; `B01003_001E` → population.
4. **Filters bad numbers** — `ok()` rejects non-positive values and Census “no data” sentinels (e.g. `-666666666`).
5. **Sets confidence** — `enrichmentConfidence: 'high'` only when median home value is valid; otherwise `'low'`.

### Why code was needed

- ACS response is a **two-row table split across two n8n items** — must use `Run Once for All Items` and `$input.all()`.
- Column lookup by header name is table parsing logic, not a single expression.
- Census uses sentinel values for missing data; custom `ok()` prevents bogus ARV inputs in WF3.
- Must output the **same field names** as the fallback nodes for downstream compatibility.

```javascript
const lead = $('Lead In').first().json;
const fips = $('Parse FIPS').first().json;
const rows = $input.all().map(i => i.json);

const toArr = (r) => Array.isArray(r) ? r : Object.values(r);

let name = null, mhv = null, mi = null, pop = null;
try {
  const header = toArr(rows[0]);
  const data   = toArr(rows[1]);
  const idx = (k) => header.indexOf(k);
  name = data[idx('NAME')] ?? null;
  mhv  = Number(data[idx('B25077_001E')]);
  mi   = Number(data[idx('B19013_001E')]);
  pop  = Number(data[idx('B01003_001E')]);
} catch (e) {}

const ok = (n) => Number.isFinite(n) && n > 0;

return [{
  json: {
    ...lead,
    fipsState: fips.fipsState,
    fipsCounty: fips.fipsCounty,
    fipsTract: fips.fipsTract,
    regionName: name,
    medianHomeValue: ok(mhv) ? mhv : null,
    medianIncome: ok(mi) ? mi : null,
    population: ok(pop) ? pop : null,
    enrichmentConfidence: ok(mhv) ? 'high' : 'low',
  },
}];
```

---

## WF2 — Enrichment Fallback

**Node name:** `Enrichment Fallback`  
**Mode:** Run Once for Each Item  
**Workflow:** `WF#2` — FALSE branch (address did not geocode)

### What the code does

- Keeps the full lead.
- Sets FIPS and all Census metrics to `null`.
- Sets `enrichmentConfidence: 'low'` and `enrichmentNote` explaining geocode failed.
- Pipeline continues to WF3 with form data only.

### Why code was needed

- We need a **deterministic, documented fallback object** — not an empty failure.
- Same **schema** as `Shape Enrichment` so WF3/WF4/WF5 need no extra branches.
- A short Code node is simpler than multiple Set nodes for many null fields.

```javascript
const lead = $('Lead In').item.json;
return {
  json: {
    ...lead,
    fipsState: null, fipsCounty: null, fipsTract: null,
    regionName: null,
    medianHomeValue: null, medianIncome: null, population: null,
    enrichmentConfidence: 'low',
    enrichmentNote: 'address not geocoded - proceeding with form data only',
  },
};
```

---

## WF2 — ACS Fallback

**Node name:** `ACS Fallback`  
**Mode:** Run Once for Each Item  
**Workflow:** `WF#2` — error output from ACS node (geocode OK, ACS API failed)

### What the code does

- Keeps lead and FIPS from successful geocoding.
- Sets Census metrics to `null`, confidence `low`, note that ACS lookup failed.
- Prevents the whole pipeline from crashing when the Census data API errors.

### Why code was needed

- HTTP “On Error: Continue” only routes to another node — something must **build a valid record** on that path.
- Mirrors `Enrichment Fallback` shape but preserves FIPS and a different `enrichmentNote` for debugging.
- Without this, a bad key or API outage would stop every lead after geocode.

```javascript
const lead = $('Lead In').item.json;
const fips = $('Parse FIPS').item.json;
return {
  json: {
    ...lead,
    fipsState: fips.fipsState ?? null,
    fipsCounty: fips.fipsCounty ?? null,
    fipsTract: fips.fipsTract ?? null,
    regionName: null,
    medianHomeValue: null,
    medianIncome: null,
    population: null,
    enrichmentConfidence: 'low',
    enrichmentNote: 'ACS lookup failed - proceeding with form data only',
  },
};
```

---

## WF3 — Underwrite

**Node name:** `Underwrite`  
**Mode:** Run Once for Each Item  
**Workflow:** `WF#3 - Math Engine`

### What the code does

1. **Assumptions object `A`** — Down payment %, interest rate, term, assignment fee, 70% rule, post-repair uplift (saved on the deal for audit).
2. **Repair estimate** — Base $/sqft by condition (`good`/`fair`/`poor`), plus age bump, × sqft.
3. **ARV** — Average of regional median home value (if present) and asking × uplift factor.
4. **ARV confidence** — `High` / `Medium` / `Low` based on enrichment quality and whether regional median exists.
5. **MAO (max offer)** — `ARV × 70% − repairs`, floored at 0.
6. **Assignment offer** — MAO minus assignment fee.
7. **Mortgage** — Loan amount and monthly P&I from standard amortization formula.
8. **Deal score** — Heuristic 0–100 from spread between MAO and asking; reduced if ARV confidence is Low.

### Why code was needed

- **Project requirement:** money math must be deterministic and auditable — not delegated to AI.
- Multiple interdependent formulas (repair → ARV → MAO → mortgage → score) in one pass.
- Condition/age tables and confidence rules are easier to read and change in one script.
- `assumptions` bundled in output documents what was used for each deal.

```javascript
// WF3 - Investment Math Engine
const lead = $input.item.json;

const A = {
  downPct: 0.20,
  annualRate: 0.07,
  termYears: 30,
  assignmentFee: 10000,
  arvRule: 0.70,
  postRepairUplift: 1.15
};

const sqft   = Number(lead.sqft) || 0;
const age    = Number(lead.propertyAgeYears) || 0;
const cond   = (lead.condition || 'unknown').toLowerCase();
const asking = Number(lead.askingPrice) || 0;
const regionMedian = Number(lead.medianHomeValue) || null;

const baseRate = ({ good: 15, fair: 35, poor: 65, unknown: 35 })[cond] ?? 35;
const ageBump  = age > 50 ? 15 : age > 30 ? 8 : age > 15 ? 4 : 0;
const repairRatePerSqft = baseRate + ageBump;
const repairEstimate = Math.round(sqft * repairRatePerSqft);

const arvInputs = [];
if (regionMedian) arvInputs.push(regionMedian);
if (asking) arvInputs.push(Math.round(asking * A.postRepairUplift));
const arvEstimate = arvInputs.length
  ? Math.round(arvInputs.reduce((a, b) => a + b, 0) / arvInputs.length)
  : null;

const arvConfidence = !arvEstimate ? 'Low'
  : (regionMedian && lead.enrichmentConfidence === 'high') ? 'High'
  : regionMedian ? 'Medium' : 'Low';

const maxOffer = arvEstimate
  ? Math.max(0, Math.round(arvEstimate * A.arvRule - repairEstimate))
  : null;

const assignmentOffer = maxOffer != null ? Math.max(0, maxOffer - A.assignmentFee) : null;

const purchase   = maxOffer || asking || 0;
const loanAmount = Math.round(purchase * (1 - A.downPct));
const mr = A.annualRate / 12;
const n  = A.termYears * 12;
const monthlyPI = loanAmount > 0
  ? Math.round(loanAmount * (mr * Math.pow(1 + mr, n)) / (Math.pow(1 + mr, n) - 1))
  : 0;

let dealScore = 50;
if (asking && maxOffer) {
  const spreadPct = (maxOffer - asking) / asking;
  dealScore = Math.round(50 + spreadPct * 120);
}
if (arvConfidence === 'Low') dealScore = Math.round(dealScore * 0.8);
dealScore = Math.max(0, Math.min(100, dealScore));

return {
  json: {
    ...lead,
    repairRatePerSqft,
    repairEstimate,
    arvEstimate,
    arvConfidence,
    maxOffer,
    assignmentOffer,
    loanAmount,
    monthlyPI,
    dealScore,
    assumptions: A,
  },
};
```

---

## WF4 — Parse Strategy

**Node name:** `Parse Strategy`  
**Mode:** Run Once for Each Item  
**Workflow:** `WF#4 - AI Strategy`

### What the code does

1. **Reads original deal** from `Math In` (Gemini response does not include the lead).
2. **Parses Gemini JSON** from `candidates[0].content.parts[0].text`.
3. **If parse fails or no `marketingSummary`** — Builds a **template strategy** from deal fields (buyers, highlights, talking points, summary) and sets `strategySource: 'fallback-template'`.
4. **If OK** — Uses Gemini output and sets `strategySource: 'gemini'`.
5. Returns `{ ...lead, strategy }` so WF5 always has a complete strategy object.

### Why code was needed

- Gemini returns **nested HTTP JSON**, not a flat strategy object — must extract and `JSON.parse` with try/catch.
- **Reliability requirement:** a deal must always be fileable even if AI is down, rate-limited, or returns malformed JSON.
- Fallback text is built from **deterministic deal numbers** (ARV, MAO, address) — appropriate in Code, not in the HTTP node.
- Merging `strategy` onto the full lead preserves all fields for Notion.

```javascript
const lead = $('Math In').first().json;
const resp = $input.item.json;

let s = null;
try {
  const text = resp?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  s = JSON.parse(text);
} catch (e) { s = null; }

if (!s || !s.marketingSummary) {
  s = {
    targetBuyerCriteria: ['Cash buyers / fix-and-flip investors active in ' + (lead.regionName || 'this market')],
    assetHighlights: [
      lead.beds + ' bed / ' + lead.baths + ' bath, ' + lead.sqft + ' sqft (built ' + lead.yearBuilt + ')',
      'Estimated ARV $' + (lead.arvEstimate ?? 'n/a') + ' (' + (lead.arvConfidence ?? 'n/a') + ' confidence)'
    ],
    negotiationTalkingPoints: [
      'Max allowable offer $' + (lead.maxOffer ?? 'n/a'),
      'Assignment offer $' + (lead.assignmentOffer ?? 'n/a')
    ],
    marketingSummary: 'Investment opportunity at ' + lead.oneLineAddress + '. Estimated ARV $' +
      (lead.arvEstimate ?? 'n/a') + ', repairs ~$' + (lead.repairEstimate ?? 'n/a') + '.',
    strategySource: 'fallback-template'
  };
} else {
  s.strategySource = 'gemini';
  s.targetBuyerCriteria = s.targetBuyerCriteria ?? [];
  s.assetHighlights = s.assetHighlights ?? [];
  s.negotiationTalkingPoints = s.negotiationTalkingPoints ?? [];
}

return { json: { ...lead, strategy: s } };
```

---

## WF5 — Notion Writer (no Code node)

**Workflow:** `WF#5 - Notion Writer`

WF5 uses the **Notion** node only — expressions map `$json` fields to database properties and page blocks. No custom JavaScript.

**Why no code here:** Creating a database page and setting properties is what the Notion node is built for. Strategy body uses static block types plus expressions like `{{ $json.strategy.marketingSummary }}`.

---

## Summary table

| Workflow | Code node | Primary purpose | Why not built-in only? |
|----------|-----------|-----------------|-------------------------|
| WF1 | `Validate` | Clean + validate lead | Multi-rule validation, `body` unwrap, custom `runId` |
| WF2 | `Parse FIPS` | Geocode → FIPS or nomatch | Nested API merge with lead |
| WF2 | `Shape Enrichment` | ACS rows → metrics | Two-item table parse, sentinel filter |
| WF2 | `Enrichment Fallback` | No geocode safe exit | Uniform null schema + note |
| WF2 | `ACS Fallback` | ACS error safe exit | Same schema, keep FIPS, no crash |
| WF3 | `Underwrite` | All financial math | Formulas, audit assumptions, no AI |
| WF4 | `Parse Strategy` | AI JSON + template fallback | Parse HTTP, try/catch, always output strategy |
| WF5 | — | Notion create | Native node sufficient |

---

## Data flow through Code nodes

```
Webhook body
  → Validate (clean record)
  → Parse FIPS → IF
       ├─ Shape Enrichment     (geocode + ACS OK)
       ├─ ACS Fallback         (geocode OK, ACS fail)
       └─ Enrichment Fallback  (no geocode)
  → Underwrite (numbers)
  → Parse Strategy (strategy object)
  → Notion (no code)
```

Each Code node either **transforms**, **calculates**, or **falls back** so the next step always receives a predictable JSON shape.
