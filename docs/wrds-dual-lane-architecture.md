# WRDS Dual-Lane Architecture: API-First Categorization

> **Status:** Draft — awaiting review  
> **Author:** Auto-generated from codebase analysis  
> **Date:** 2026-04-27

---

## 1. Problem Statement

Our categorizer currently follows a single path: OCR/scrape company data → pass PitchBook keywords + taxonomy to an LLM → assign `climate_tech_category`. This is slow, expensive, and fragile:

- **>50% `no_result` rate** on categorize stage (see `context.md` line 244).
- Every company burns an LLM call even when PitchBook keywords already map deterministically.
- Companies without keywords are skipped entirely (`categorizer.js:161-164`).
- No structured source of "Emerging Space" tags — OCR captures keywords but not PitchBook's own industry classifications.

WRDS PitchBook data gives us a richer, structured API source including industry descriptions, Emerging Space tags, and deal metadata — enabling deterministic categorization for a large slice of companies.

---

## 2. Architectural Overview

```
                    ┌──────────────────────┐
                    │   companies.json     │
                    │   (company record)   │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │   WRDS Ingest Agent   │
                    │  (wrds-ingest.js)     │
                    │  Pulls PitchBook data │
                    │  via WRDS PostgreSQL  │
                    └──────────┬───────────┘
                               │
                  Adds: emerging_spaces[], pitchbook_description,
                        pitchbook_industry_code, wrds_company_id
                               │
                    ┌──────────▼───────────┐
                    │  Taxonomy Mapper      │
                    │  (taxonomy-mapper.js) │
                    │  Three-lane router    │
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼──────┐ ┌──────▼───────┐ ┌──────▼───────┐
     │  LANE 1: FAST │ │ LANE 2: MED  │ │ LANE 3: COLD │
     │ Deterministic │ │ LLM on API   │ │ Legacy scrape │
     │ Emerging Space│ │ description  │ │ + OCR + LLM  │
     │ → taxonomy    │ │ → taxonomy   │ │ → taxonomy   │
     │ No LLM ⚡     │ │ Lightweight  │ │ Full pipeline │
     └───────────────┘ └──────────────┘ └──────────────┘
```

### Lane Routing Decision Tree

```javascript
function classifyCategoryLane(company) {
  // Lane 1: Deterministic — Emerging Space tag maps to taxonomy
  if (hasEmergingSpaceMatch(company)) return 'fast';
  
  // Lane 2: LLM on API data — has WRDS description but no direct map
  if (hasWrdsDescription(company))    return 'medium';
  
  // Lane 3: Cold — fall back to existing scrape/OCR pipeline
  return 'cold';
}
```

---

## 3. WRDS Technical Constraints

These constraints are **non-negotiable** and shape every query pattern:

| Constraint | Detail | Mitigation |
|---|---|---|
| **SSH required** | WRDS PostgreSQL is only reachable from inside the WRDS Cloud | SSH tunnel through `wrds-cloud.wharton.upenn.edu:22`, then forward to `wrds-pgdata.wharton.upenn.edu:9737` |
| **Two-layer connection** | SSH → TCP tunnel → PostgreSQL | `ssh2` npm package creates tunnel; `pg` connects through it |
| **Statement timeout** | WRDS kills long queries | `statement_timeout: 30000` on pool; no `OFFSET` pagination |
| **No OFFSET pagination** | Forbidden by timeout policy | **High-water mark** delta: `WHERE lastupdated > $hwm ORDER BY lastupdated ASC LIMIT 500` |
| **Rate/connection limits** | Shared academic resource | `max: 2` pool connections; single-query-at-a-time pattern |

```
┌─────────────────┐     SSH (port 22)     ┌─────────────────────────┐    TCP (port 9737)    ┌─────────────────┐
│  Node.js agent  │ ───────────────► │  wrds-cloud.wharton.  │ ───────────────► │  wrds-pgdata.    │
│  (wrds-ingest)  │   ssh2 tunnel    │  upenn.edu (Cloud)   │   forwardOut()    │  wharton.upenn.  │
│                 │ ◄──────────────── │  (login node)         │ ◄──────────────── │  edu (PostgreSQL)│
└─────────────────┘                  └─────────────────────────┘                    └─────────────────┘
```

> **Schema status (resolved 2026-04-27):** Column names are **not obfuscated** — the [WRDS PitchBook variable reference](https://wrds-www.wharton.upenn.edu/pages/support/manuals-and-overviews/pitchbook/wrds-pitchbook-overview-new/#database-notes) documents plain-English column names. The `wrds-schema-scout.js` script and `artifacts/wrds-column-map.json` indirection layer are **no longer needed**. Column names can be hardcoded directly.

> **Connection note (resolved 2026-04-27):** WRDS PostgreSQL (`wrds-pgdata:9737`) is **not directly reachable** from external networks. All access must go through the [WRDS Cloud](https://wrds-www.wharton.upenn.edu/pages/support/the-wrds-cloud/using-ssh-connect-wrds-cloud/) via SSH (`wrds-cloud.wharton.upenn.edu:22`). This eliminates the IP whitelisting blocker — any WRDS account holder can connect. The `ssh2` npm package handles the tunnel transparently.

### Confirmed Schema: `pitchbk.company`

| WRDS Column | Type | Maps to | Notes |
|---|---|---|---|
| `companyid` | Char | `wrds_company_id` | PitchBook company identifier |
| `companyname` | Char | `name` | |
| `website` | Char | `domain` | Needs URL → domain normalization |
| `description` | Char | `pitchbook_description` | Full company description |
| `descriptionshort` | Char | — | Available as LLM context for Lane 2 |
| `keywords` | Char | `company_profile.keywords` | **Comma-separated string → split to array** |
| `emergingspaces` | Char | `emerging_spaces` | **Comma-separated string → split to array** |
| `verticals` | Char | `pitchbook_verticals` | **Comma-separated string → split to array** |
| `primaryindustrycode` | Char | `pitchbook_industry_code` | Single value |
| `primaryindustrygroup` | Char | `pitchbook_industry_group` | Single value |
| `primaryindustrysector` | Char | `pitchbook_industry_sector` | Single value |
| `allindustries` | Char | — | **Bonus:** all industry codes, comma-separated. Useful as Lane 2 LLM context |
| `employees` | Float | `company_profile.employees` | |
| `hqlocation` | Char | `company_profile.hq` | Also: `hqcity`, `hqstate_province`, `hqcountry` for structured HQ |
| `yearfounded` | Float | `company_profile.year_founded` | |
| `totalraised` | Float | `funding_signals` | In native currency; also `totalraisednativecurrency` |
| `lastfinancingdate` | Date | `funding_signals[].date` | Also: `lastfinancingsize`, `lastfinancingdealtype` |
| `ownershipstatus` | Char | — | Filter: `Privately Held (backing)`, `Privately Held (no backing)` |
| `lastupdated` | Date | `wrds_last_updated` | **High-water mark column** |
| `pitchbookcreateddate` | Date | — | When PitchBook first profiled this company |

> **Parsing note:** `emergingspaces`, `verticals`, `keywords`, and `allindustries` are `Char` (text) columns likely containing comma-separated or pipe-separated values. The ingest agent must split and trim these into `string[]` arrays.

### Existing Infrastructure

Already implemented and tested:

- **Config block:** `src/config.js` — `wrds.sshHost`, `wrds.pgHost`, `wrds.pgPort`, `wrds.username`, `wrds.password`, `wrds.database`, `wrds.schema`, `wrds.table`
- **npm scripts:** `wrds-ingest` and `wrds-scout` registered in `package.json`
- **Dependencies:** `pg@^8.20.0`, `ssh2` (to be added)
- **Update frequency:** Weekly (per WRDS docs, last updated 2026-04-24)

---

## 4. New/Modified Agents

### 4.1 WRDS Ingest Agent — `src/agents/wrds-ingest.js` [NEW]

**Owns:** `data/companies.json` (WRDS-sourced fields only)  
**Reads:** WRDS PostgreSQL (`pitchbk.company`)

**Responsibilities:**
1. Connect to WRDS with pooled `pg` client (strict SSL, port 9737).
2. Query `pitchbk.company` using `lastupdated` high-water mark pagination.
3. Parse comma-separated classification columns (`emergingspaces`, `verticals`, `keywords`, `allindustries`) into `string[]` arrays.
4. Map each row to `companies.json` schema via `ocr-utils.js::mergeCompanies()`.
5. Persist new fields per company:

```javascript
// New fields added to company records by WRDS ingest
{
  wrds_company_id: string | null,         // companyid
  emerging_spaces: string[] | null,       // emergingspaces (parsed from comma-separated Char)
  pitchbook_verticals: string[] | null,   // verticals (parsed from comma-separated Char)
  pitchbook_industry_code: string | null, // primaryindustrycode
  pitchbook_industry_group: string | null,// primaryindustrygroup
  pitchbook_industry_sector: string | null,// primaryindustrysector
  pitchbook_description: string | null,   // description (full) — descriptionshort also available
  pitchbook_keywords: string[] | null,    // keywords (parsed from comma-separated Char)
  wrds_last_updated: string | null,       // lastupdated (ISO timestamp)
  category_source: 'wrds_fast' | 'wrds_medium' | 'cold' | null
}
```

> **PitchBook Classification Hierarchy (granular → broad):**
> 1. **Emerging Spaces** (`emergingspaces`) — Curated thematic tags (e.g. "CleanTech / Solar"). Highest signal, smallest coverage.
> 2. **Verticals** (`verticals`) — Sector-specific tags (e.g. "Renewable Energy", "Energy Storage"). Good signal.
> 3. **Primary Industry Code** (`primaryindustrycode`) — PitchBook's own code (e.g. "Clean Technology"). Medium specificity.
> 4. **Industry Group** (`primaryindustrygroup`) — Broader grouping (e.g. "Energy Equipment & Services"). Low specificity.
> 5. **Industry Sector** (`primaryindustrysector`) — Top-level sector (e.g. "Energy"). Very broad, useful only as a tiebreaker.
> 6. **Keywords** (`keywords`) — Free-form tags, already used by the existing `resolveByRule()` in `categorizer.js`.
> 7. **All Industries** (`allindustries`) — All associated industry codes. Useful as supplementary LLM context in Lane 2.

**High-water mark strategy:**
```javascript
// On each run, find the max lastupdated already ingested
const hwm = companies
  .filter(c => c.wrds_last_updated)
  .reduce((max, c) => c.wrds_last_updated > max ? c.wrds_last_updated : max, '1970-01-01');

// Query only newer records — no OFFSET, respects statement_timeout
const query = `
  SELECT companyid, companyname, website, description, descriptionshort,
         keywords, emergingspaces, verticals, allindustries,
         primaryindustrycode, primaryindustrygroup, primaryindustrysector,
         employees, hqlocation, hqcity, hqstate_province, hqcountry,
         yearfounded, totalraised, ownershipstatus,
         lastfinancingdate, lastfinancingsize, lastfinancingdealtype,
         lastupdated
  FROM pitchbk.company
  WHERE lastupdated > $1
  ORDER BY lastupdated ASC
  LIMIT 500
`;
```

### 4.2 Taxonomy Mapper — `src/agents/taxonomy-mapper.js` [NEW]

**Owns:** `data/companies.json` (category fields: `climate_tech_category`, `primary_sector`, `opportunity_area`, `category_confidence`, `category_resolver`, `category_source`)  
**Reads:** `data/companies.json`, `data/climate-tech-map-industry-categories.json`, `data/pitchbook-taxonomy-map.json`

**Responsibilities:**

**Lane 1 — Fast (deterministic, multi-signal cascade):**

Lane 1 tries **five** PitchBook classification layers in order of specificity. Each layer uses a section of `data/pitchbook-taxonomy-map.json`. The first match wins — no LLM call required.

```javascript
// data/pitchbook-taxonomy-map.json — manually curated
{
  "emerging_spaces": {
    "CleanTech / Solar":        "Solar",
    "CleanTech / Wind Energy":  "Wind",
    "CleanTech / Battery Tech": "Electrochemical",
    "AgTech / Precision Ag":    "Precision Agriculture"
  },
  "verticals": {
    "Renewable Energy":         "Solar",
    "Energy Storage":           "Electrochemical",
    "Electric Vehicles":        "Battery EVs",
    "Carbon Capture & Storage": "Fossil Fuels with CCUS",
    "Hydrogen Economy":         "Hydrogen & Derivatives",
    "Sustainable Agriculture":  "Regenerative Agriculture"
  },
  "industry_codes": {
    "Clean Technology":         null,
    "Solar":                    "Solar",
    "Wind":                     "Wind",
    "Fuel Cells":               "Hydrogen & Derivatives",
    "Biofuels / Biochemicals":  "Biofuels"
  },
  "industry_groups": {
    "Energy Equipment & Services":    null,
    "Independent Power Producers":    null,
    "Electrical Equipment":           null
  },
  "industry_sectors": {
    "Energy":                  null,
    "Utilities":               null
  }
}
```

> **`null` values** in the map mean "this classification confirms climate-relevance but is too broad to assign a specific `Tech Category Name`". These companies skip Lane 1 and fall to Lane 2 with a `climate_relevant_hint: true` flag, which narrows the LLM prompt.

**Cascade order (first match wins):**

| Step | Field checked | Confidence | Resolver tag |
|---|---|---|---|
| 1 | `emerging_spaces[]` | `high` | `emerging_space` |
| 2 | `pitchbook_verticals[]` | `high` | `vertical` |
| 3 | `pitchbook_industry_code` | `medium` | `industry_code` |
| 4 | `pitchbook_industry_group` | `low` | `industry_group` |
| 5 | `pitchbook_keywords[]` | varies | `rule` (existing `resolveByRule()`) |

- `industry_sector` is **not** used for direct mapping (too broad) but is stored for analytics and as LLM context.
- Step 5 reuses the existing keyword-based `resolveByRule()` from `categorizer.js` — this already works and is tested.
- **No LLM call. No network call. Pure dictionary lookups.**

**Lane 2 — Medium (LLM on API data):**
- Company exists in WRDS (`wrds_company_id` is set) but no deterministic match from the cascade above.
- `pitchbook_description` is non-empty (≥80 chars).
- Build a lightweight prompt using `pitchbook_description` + all available PitchBook classifications (industry code, verticals, sector) as context + shortlisted taxonomy.
- If `climate_relevant_hint: true` (from a broad `null` map match), the prompt can be narrowed to climate-adjacent categories only.
- Set `category_resolver: 'llm_wrds'`, `category_source: 'wrds_medium'`.

**Lane 3 — Cold (fallback):**
- No WRDS data, or `pitchbook_description` is blank/short.
- Delegates to existing `categorizeCompany()` from `categorizer.js`.
- Set `category_source: 'cold'`.

### 4.3 Orchestrator Update — `src/orchestrator.js` [MODIFY]

Current stage sequence:
```
profile → discovery → fingerprint → scrape → extract → enrich → categorize
```

Updated stage sequence:
```
wrds_ingest → profile → discovery → fingerprint → scrape → extract → enrich → categorize
```

Key changes:
1. Add `wrds_ingest` as optional stage 0 (skipped if WRDS credentials missing).
2. Modify `categorize` stage handler to call `taxonomy-mapper.js` instead of directly calling `categorizeCompany()`.
3. The mapper routes to Lane 1/2/3 internally — the orchestrator just calls `mapCategory(company, repJob, taxonomy)`.
4. `pipeline-stages.js::STAGES` array gets `wrds_ingest` prepended (gated by config).
5. `pipeline-stages.js::getStage()` updated: if `wrds_last_updated` is set, skip to `profile`.

### 4.4 Categorizer Agent — `src/agents/categorizer.js` [MODIFY]

- Extract `resolveByRule()` and `buildKeywordIndex()` into a shared util (they're already exported).
- `categorizeCompany()` becomes the Lane 3 backend only.
- The taxonomy-mapper imports and calls it as a fallback.

---

## 5. Data Contract Changes

### companies.json — New Fields

```diff
 id, name, domain, funding_signals, company_profile,
+wrds_company_id, emerging_spaces, pitchbook_verticals,
+pitchbook_industry_code, pitchbook_industry_group,
+pitchbook_industry_sector, pitchbook_description,
+wrds_last_updated, category_source,
 careers_page_url, careers_page_reachable,
 careers_page_discovery_method, ats_platform, ats_slug,
 climate_tech_category, primary_sector, opportunity_area,
 category_confidence, category_resolver,
 last_scrape_signature, last_scrape_outcome, last_scraped_at,
 consecutive_empty_scrapes, dormant
```

### New File: `data/pitchbook-taxonomy-map.json`

Manually curated multi-layer dictionary mapping PitchBook classification tags to `Tech Category Name` values from `climate-tech-map-industry-categories.json`. Organized by classification layer with decreasing specificity. Values of `null` mean "climate-relevant but too broad to assign a category". See Section 4.2 for the full example.

> **NOTE:** The exact tag strings require a live WRDS query (e.g. `SELECT DISTINCT emergingspaces FROM pitchbk.company WHERE emergingspaces IS NOT NULL LIMIT 200`). The map will be populated in Slice 0 after WRDS access is granted.

### Existing File: `data/climate-tech-map-industry-categories.json`

No structural changes. The `keywords` arrays in this file continue to power the existing `resolveByRule()` keyword-matching fallback (Step 5 of the Lane 1 cascade).

---

## 6. Implementation Slices

Each slice is atomic, testable, and independently mergeable.

---

### Slice 0: WRDS Connection Validation & Tag Enumeration

**Goal:** Validate live WRDS connectivity and enumerate the actual Emerging Space / Vertical tag values to populate `data/pitchbook-taxonomy-map.json`.

**Files:**
- `scripts/wrds-schema-scout.js` — [MODIFY] update to run `SELECT DISTINCT` on classification columns

**Steps:**
1. Ensure WRDS credentials are approved and IP-whitelisted.
2. Run `npm run wrds-scout` — updated to query `pitchbk.company` directly (columns are known; no schema discovery needed).
3. Scout outputs distinct values for `emergingspaces`, `verticals`, `primaryindustrycode`, `primaryindustrygroup`, `primaryindustrysector`.
4. Use the distinct tag values to populate `data/pitchbook-taxonomy-map.json` (Slice 2).

**Test:** Scout connects via SSH tunnel, returns distinct tag values, exits 0.

**Blocker:** Requires WRDS account credentials (same username/password used for SSH and PostgreSQL).

> **Schema note (resolved):** Column names are plain English per the [WRDS variable reference](https://wrds-www.wharton.upenn.edu/pages/support/manuals-and-overviews/pitchbook/wrds-pitchbook-overview-new/#database-notes). The `artifacts/wrds-column-map.json` indirection layer is **eliminated** — column names are hardcoded in the ingest agent. `wrds-schema-scout.js` is repurposed for tag enumeration only.

---

### Slice 1: WRDS SSH Tunnel + Connection Utility

**Goal:** Build reusable WRDS connection module: SSH tunnel through WRDS Cloud, then PostgreSQL queries through the tunnel.

**Files:**
- `src/utils/wrds-pool.js` — [NEW]
- `tests/wrds-pool.test.js` — [NEW]

**New dependency:** `ssh2` (npm package for SSH connections)

**Contract:**
```javascript
// src/utils/wrds-pool.js
module.exports = {
  connect,     // () => Promise<void> (establishes SSH tunnel + pg client)
  query,       // (sql, params) => Promise<{rows}> (wraps pg.query with timeout guard)
  close,       // () => Promise<void> (tears down pg client + SSH tunnel)
};
```

**Connection flow:**
```javascript
const { Client: SSHClient } = require('ssh2');
const { Client: PGClient } = require('pg');

async function connect() {
  // 1. SSH into WRDS Cloud
  const ssh = new SSHClient();
  await new Promise((resolve, reject) => {
    ssh.on('ready', resolve).on('error', reject).connect({
      host: 'wrds-cloud.wharton.upenn.edu',
      port: 22,
      username: cfg.wrds.username,
      password: cfg.wrds.password,
    });
  });

  // 2. Open TCP tunnel from SSH server to PostgreSQL
  const stream = await new Promise((resolve, reject) => {
    ssh.forwardOut(
      '127.0.0.1', 0,                         // source (arbitrary)
      'wrds-pgdata.wharton.upenn.edu', 9737,   // destination (PostgreSQL)
      (err, stream) => err ? reject(err) : resolve(stream)
    );
  });

  // 3. Connect pg through the tunnel stream
  const pg = new PGClient({
    user: cfg.wrds.username,
    password: cfg.wrds.password,
    database: cfg.wrds.database,
    ssl: { rejectUnauthorized: true },
    stream,                                    // pg Client accepts a pre-established stream
    statement_timeout: 30000,
  });
  await pg.connect();
}
```

> **Note:** Uses `pg.Client` (not `pg.Pool`) because the SSH tunnel provides a single TCP stream. For our use case (sequential queries, max 2-3 per run), a single client is sufficient. The `query()` wrapper serializes calls.

**Tests (unit, mocked ssh2 + pg):**
- `connect()` establishes SSH first, then pg through the tunnel stream.
- `query()` passes results through; enforces `statement_timeout`.
- `close()` tears down pg client, then SSH connection. Idempotent.
- SSH error during connect surfaces as a descriptive error message.
- Missing credentials throw before attempting SSH.

---

### Slice 2: PitchBook Taxonomy Map & Multi-Signal Lookup

**Goal:** Create and test the multi-layer deterministic PitchBook → taxonomy cascade.

**Files:**
- `data/pitchbook-taxonomy-map.json` — [NEW] (stub with known mappings across all layers)
- `src/utils/pitchbook-taxonomy-lookup.js` — [NEW]
- `tests/pitchbook-taxonomy-lookup.test.js` — [NEW]

**Contract:**
```javascript
// src/utils/pitchbook-taxonomy-lookup.js
module.exports = {
  loadPitchbookTaxonomyMap,  // () => { emerging_spaces, verticals, industry_codes, industry_groups, industry_sectors }
  cascadeLookup,             // (company, map) => { category, confidence, resolver } | null
};
```

`cascadeLookup` checks layers in order: `emerging_spaces` → `verticals` → `industry_code` → `industry_group` → keyword `resolveByRule()`. Returns the first non-null match. A `null` value in the map (broad match) returns `{ category: null, confidence: null, resolver: '...', climate_relevant_hint: true }` which Lane 2 uses to narrow its LLM prompt.

**Tests:**
- Emerging Space exact match → `{ category: 'Solar', confidence: 'high', resolver: 'emerging_space' }`.
- No ES match but Vertical match → `{ category: 'Electrochemical', confidence: 'high', resolver: 'vertical' }`.
- No ES/Vertical but Industry Code match → `{ confidence: 'medium', resolver: 'industry_code' }`.
- Broad match (map value `null`) → returns `climate_relevant_hint: true` with no category.
- Case-insensitive matching works across all layers.
- No match at any layer returns `null`.
- Cascade respects priority order (ES wins over Vertical even if both match).

---

### Slice 3: WRDS Ingest Agent

**Goal:** Build `src/agents/wrds-ingest.js` — pulls companies from WRDS, maps to schema, merges into `companies.json`.

**Files:**
- `src/agents/wrds-ingest.js` — [NEW]
- `tests/wrds-ingest.test.js` — [NEW]

**Dependencies:** Slice 1 (wrds-pool), `ocr-utils.js::mergeCompanies()`

**Key behaviors:**
1. Reads `artifacts/wrds-column-map.json` for column aliases.
2. Computes high-water mark from existing `companies.json`.
3. Queries WRDS with `WHERE date_col > $hwm ORDER BY date_col LIMIT 500`.
4. Maps rows to company schema, including `emerging_spaces`, `pitchbook_description`.
5. Merges via `mergeCompanies()` (dedup by domain, then id).
6. Writes atomically to `data/companies.json`.
7. Supports `--dry-run`, `--verbose`, `--full` flags.

**Test (mocked pg):**
- Dry run produces no file writes.
- High-water mark skips already-ingested records.
- `--full` flag ignores high-water mark.
- Merge preserves existing non-null fields.
- Missing column-map file throws descriptive error.

---

### Slice 4: Taxonomy Mapper Agent

**Goal:** Build `src/agents/taxonomy-mapper.js` — the three-lane categorization router.

**Files:**
- `src/agents/taxonomy-mapper.js` — [NEW]
- `tests/taxonomy-mapper.test.js` — [NEW]

**Dependencies:** Slice 2 (pitchbook-taxonomy-lookup), existing `categorizer.js`

**Contract:**
```javascript
// src/agents/taxonomy-mapper.js
module.exports = {
  mapCategory,  // (company, repJob, taxonomy, llmOpts) => Promise<void>
                // Mutates company in-place (same pattern as categorizeCompany)
};
```

**Lane dispatch logic:**
```javascript
async function mapCategory(company, repJob, taxonomy, llmOpts) {
  const pbMap = loadPitchbookTaxonomyMap();

  // Lane 1: Fast — multi-signal deterministic cascade
  // Checks: emerging_spaces → verticals → industry_code → industry_group → keywords
  const cascadeResult = cascadeLookup(company, pbMap);
  if (cascadeResult && cascadeResult.category) {
    // Direct match — assign category, no LLM needed
    applyCategory(company, cascadeResult, 'wrds_fast');
    return;
  }

  // Lane 2: Medium — LLM on WRDS description (no scraping needed)
  const desc = (company.pitchbook_description || '').trim();
  if (company.wrds_company_id && desc.length >= 80) {
    // If cascade returned a broad match (null category), pass the hint
    const hint = cascadeResult?.climate_relevant_hint || false;
    await categorizeFromDescription(company, desc, taxonomy, llmOpts, {
      climate_relevant_hint: hint,
      // Pass all PitchBook classifications as extra LLM context
      pitchbook_context: {
        industry_code: company.pitchbook_industry_code,
        industry_group: company.pitchbook_industry_group,
        industry_sector: company.pitchbook_industry_sector,
        verticals: company.pitchbook_verticals,
      },
    });
    company.category_source = 'wrds_medium';
    return;
  }

  // Lane 3: Cold — existing categorizer pipeline
  await categorizeCompany(company, repJob, taxonomy, llmOpts, []);
  company.category_source = 'cold';
}
```

**Tests:**
- Company with matching Emerging Space → Lane 1, no LLM called.
- Company with WRDS description but no ES match → Lane 2, LLM called with description.
- Company with no WRDS data → Lane 3, delegates to `categorizeCompany`.
- Lane 1 sets `category_resolver: 'emerging_space'`, `category_confidence: 'high'`.
- Lane 2 sets `category_resolver: 'llm_wrds'`.

---

### Slice 5: Orchestrator Integration

**Goal:** Wire the new agents into the orchestrator pipeline.

**Files:**
- `src/utils/pipeline-stages.js` — [MODIFY]
- `src/orchestrator.js` — [MODIFY]
- `tests/orchestrator-wrds-lane.test.js` — [NEW]

**Changes to `pipeline-stages.js`:**
```diff
-const STAGES = ['profile', 'discovery', 'fingerprint', 'scrape', 'extract', 'enrich', 'categorize'];
+const WRDS_ENABLED = !!(require('../config').wrds.username && require('../config').wrds.password);
+const STAGES = WRDS_ENABLED
+  ? ['wrds_ingest', 'profile', 'discovery', 'fingerprint', 'scrape', 'extract', 'enrich', 'categorize']
+  : ['profile', 'discovery', 'fingerprint', 'scrape', 'extract', 'enrich', 'categorize'];
```

**Changes to `getStage()`:**
```diff
 function getStage(company) {
+  // WRDS ingest stage (if enabled)
+  if (WRDS_ENABLED && isBlank(company.wrds_last_updated) && isBlank(company.profile_attempted_at)) {
+    return 'wrds_ingest';
+  }
   if (isBlank(c.profile_attempted_at)) return 'profile';
   // ... rest unchanged
 }
```

**Changes to orchestrator `categorize` handler:**
```diff
   if (stage === 'categorize') {
-    // ... existing direct categorizeCompany call
+    const { mapCategory } = require('./agents/taxonomy-mapper');
+    await mapCategory(c, rep, taxonomy, { provider, apiKey, model, dryRun: DRY_RUN });
+    return buildCategorizeOutcome(c);
   }
```

**Tests:**
- Company with WRDS creds → `wrds_ingest` is first stage.
- Company without WRDS creds → `profile` is first stage (graceful degradation).
- Categorize stage uses `mapCategory` and records `category_source` in event extra.

---

### Slice 6: Observability & Reporting

**Goal:** Update reporter and admin panel to surface lane distribution.

**Files:**
- `src/agents/reporter.js` — [MODIFY]
- `scripts/pipeline-report.js` — [MODIFY]

**New metrics:**
- `category_source_distribution: { wrds_fast: N, wrds_medium: N, cold: N }`
- `emerging_space_coverage: N%` (companies with ≥1 emerging space tag)
- `wrds_ingest_delta: N` (new companies added this run)
- Lane-specific `no_result` rates

---

### Slice 7: End-to-End Integration Test

**Goal:** Smoke test the full three-lane flow with fixtures.

**Files:**
- `tests/dual-lane-integration.test.js` — [NEW]
- `tests/fixtures/wrds-sample-companies.json` — [NEW]

**Scenarios:**
1. Company with `emerging_spaces: ["CleanTech / Solar"]` → categorized as "Solar" without LLM.
2. Company with `pitchbook_description` but no ES → LLM called with description only.
3. Company with no WRDS data → full cold pipeline.
4. Mixed batch of all three → correct lane assignment for each.

---

## 7. Dependency Graph

```
Slice 0 (Tag Enumeration)  ──── blocker: WRDS account approval
   │
   ▼
Slice 1 (Connection Utility) ◄── can start immediately (mocked tests)
   │
   ├──► Slice 2 (Taxonomy Map) ◄── stub now; populate after Slice 0
   │       │
   │       ▼
   └──► Slice 3 (Ingest Agent) ──── depends on Slice 1
           │
           ▼
        Slice 4 (Taxonomy Mapper) ── depends on Slice 2 + categorizer.js
           │
           ▼
        Slice 5 (Orchestrator Integration) ── depends on Slices 3 + 4
           │
           ▼
        Slice 6 (Observability) ── depends on Slice 5
           │
           ▼
        Slice 7 (E2E Test) ── depends on all above
```

**Parallelizable now (no WRDS access needed):** Slices 1, 2 (stub), 4 (with mocks).

---

## 8. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| WRDS account never approved | Medium | High | Slices 1-2-4 are testable with mocks; cold lane is unchanged |
| ~~Emerging Space tags don't exist in schema~~ | ~~Medium~~ | ~~Medium~~ | **RESOLVED** — `emergingspaces` column confirmed in WRDS variable reference |
| Classification columns are mostly NULL/empty | Medium | Medium | Lane 2 still works on `description`; Lane 3 is unchanged |
| Comma-separated parsing edge cases | Medium | Low | Defensive split+trim; log warnings on unexpected delimiters |
| WRDS timeout on large queries | Medium | Low | HWM pagination + `LIMIT 500` + `statement_timeout: 30000` |
| LLM costs increase from Lane 2 | Low | Low | Lane 2 replaces existing LLM calls, doesn't add new ones |

---

## 9. Success Metrics

| Metric | Current | Target |
|---|---|---|
| Categorize `no_result` rate | >50% | <20% |
| Companies categorized without LLM | 0% | 30-50% (Lane 1) |
| Avg categorize latency | ~8s (LLM) | <100ms (Lane 1), ~4s (Lane 2) |
| LLM calls per pipeline run | 1 per company | ~0.5 per company |

---

## 10. Open Questions

1. ~~**Emerging Space tag format:** What are the exact string values?~~ **RESOLVED** — Column exists as `emergingspaces` (Char). Exact tag values still need enumeration via `SELECT DISTINCT` in Slice 0, but the column is confirmed.

2. **Multiple Emerging Space tags:** If a company has tags mapping to different categories, should we prefer the first match, or use a scoring heuristic like `resolveByRule()`?

3. **WRDS refresh cadence:** Should `wrds-ingest` run as part of every `npm run pipeline` invocation, or on a separate schedule? WRDS updates weekly (per docs), so daily runs would produce no delta.

4. **Lane 2 prompt:** Should we create a new prompt template (`categorizer-wrds.txt`) optimized for API descriptions, or reuse `categorizer.txt` with the description substituted?

5. **Backfill strategy:** For the ~551 existing companies, should we run a one-time WRDS lookup (by `website` domain match) to enrich them with PitchBook classification fields, or only apply the new lanes to newly ingested companies?

6. **`allindustries` utilization:** This bonus column contains all associated industry codes. Should it be stored on the company record and passed as LLM context in Lane 2, or is `primaryindustrycode` sufficient?

7. **Delimiter detection:** Are `emergingspaces`/`verticals`/`keywords` comma-separated, pipe-separated, or semicolon-separated? Slice 0 must inspect sample values to determine the parsing strategy.
