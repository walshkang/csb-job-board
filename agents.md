# AGENTS — Developer & AI Assistant Protocol

**ENVIRONMENT WARNING:** You are operating in a multi-agent, highly concurrent environment. Other AI instances (Cursor, Claude Code, Copilot, Antigravity) may be executing tasks in this codebase simultaneously. You share no memory with them; the filesystem and this document are your only shared context.

For pipeline usage, CLI commands, and step-by-step run instructions, see [README.md](README.md).

---

## Agent Ownership Table

One agent per slice. All agents are idempotent, log outputs, and write artifacts to `data/` or `artifacts/`. Model and key config is centralized in `src/config.js` — edit there or override via `.env.local`.

| # | Agent | File | Owns (writes to) | Reads from |
|---|---|---|---|---|
| 0 | WRDS Ingest | `src/agents/wrds-ingest.js` | `data/companies.json` (WRDS fields) | WRDS PostgreSQL (`pitchbk_companies_deals`) |
| 0b | Taxonomy Mapper | `src/agents/taxonomy-mapper.js` | `data/companies.json` (category fields) | `data/companies.json`, `data/pitchbook-taxonomy-map.json`, taxonomy JSON |
| 1 | OCR | `src/agents/ocr.js` | `data/companies.json` | `data/images/` (PDFs/screenshots) |
| 2 | Categorizer | `src/agents/categorizer.js` | `data/companies.json` (category fields — Lane 3 fallback) | `data/companies.json`, taxonomy JSON |
| 3 | Discovery | `src/agents/discovery.js` | `data/companies.json` (careers fields) | `data/companies.json` |
| 4 | Fingerprinter | `src/agents/fingerprinter.js` | `data/companies.json` (ats_platform, ats_slug) | `data/companies.json` |
| 5 | Scraper | `src/agents/scraper.js` | `artifacts/html/{id}.*`, `data/scrape_runs.json` | `data/companies.json` |
| 6 | Extraction | `src/agents/extraction.js` | `data/jobs.json` | `artifacts/html/` |
| 7 | Enrichment | `src/agents/enricher.js` | `data/jobs.json` (classification fields) | `data/jobs.json` |
| 8 | QA | `src/agents/qa.js` | _(read-only — console output)_ | `data/jobs.json` |
| 9 | Temporal | `src/agents/temporal.js` | `data/jobs.json`, `data/companies.json` (temporal fields) | `data/scrape_runs.json` |
| 10 | Notion Sync | `src/agents/notion-sync.js` | Notion databases | `data/companies.json`, `data/jobs.json` |
| 11 | Reporter | `src/agents/reporter.js` | `data/runs/*.json` | `data/scrape_runs.json`, `data/companies.json`, `data/jobs.json` |
| 12 | Reviewer | `src/agents/reviewer.js` | `data/postmortems/*.md` | `data/runs/latest.json`, `data/scrape_runs.json`, `data/jobs.json` |

**Execution Boundaries:**
- The streaming orchestrator (`npm run pipeline`) exclusively handles the data ingestion and enrichment loop (Agents 0–7).
- Post-processing, auditing, syncing, and observability (Agents 8–12) run sequentially *after* the orchestrator finishes. Notion will not reflect new data until Agent 10 runs.

**Utility scripts:**
- `node src/agents/notion-setup.js` — provision all DB properties (safe to re-run)
- `node src/agents/notion-clear.js` — archive all pages in both DBs (destructive)

---

## Data Contracts

"If you get the type right, you're probably not far off." Schemas are the literal enforcement mechanism for parallelization.

### Companies (`data/companies.json`)
```
id, name, domain, careers_page_url, careers_page_reachable,
careers_page_discovery_method, ats_platform, ats_slug,
last_scrape_signature, last_scrape_outcome, last_scraped_at,
funding_signals, company_profile,
wrds_company_id, emerging_spaces, pitchbook_verticals,
pitchbook_industry_code, pitchbook_industry_group,
pitchbook_industry_sector, pitchbook_description,
wrds_last_updated, category_source,
climate_tech_category, primary_sector, opportunity_area,
category_confidence, category_resolver,
consecutive_empty_scrapes, dormant
```

### Jobs (`data/jobs.json`)
```
id, company_id, job_title_raw, source_url, location_raw,
employment_type, description_raw, description_hash,
first_seen_at, last_seen_at, removed_at, days_live,
job_title_normalized, job_function, seniority_level, location_type,
mba_relevance,
climate_relevance_confirmed, climate_relevance_reason,
enrichment_prompt_version, enrichment_error
```

### Scrape Runs (`data/scrape_runs.json`)
```
company_id, timestamp, status, error_type, body_size_kb,
provider, scrape_method
```

### Contracts Before Logic

Before writing *any* functional code, define and export the Data Contract. Focus entirely on transforming data to fit the contract. If a cross-boundary contract does not exist, create it and seek approval before proceeding.

---

## Concurrency & Scoping Rules

- **Volatile Filesystem**: Assume files are changing. Always read the current state of a shared file (e.g., `companies.json`) immediately before writing to it to avoid clobbering concurrent updates.
- **Strict Scoping**: Never modify files outside your assigned domain. Each agent owns its declared outputs (see ownership table above). If a change is needed elsewhere, use the **Stub and Signal** rule below.
- **Idempotency**: All agents must be safe to re-run. Check for existing records or checksums before performing expensive operations or duplicate writes.

### The Stub and Signal Rule

If your task requires a change or feature in a file outside your scope, **DO NOT EDIT IT**. Instead:
1. Write a deterministic stub/mock.
2. Define the expected Data Contract.
3. Explicitly flag it in your final output so the Coordinator can assign it to a peer agent.

---

## AI Assistant Protocol

When multiple AI instances (Antigravity, Cursor, etc.) operate in this repo, adhere to these standards:

### 1. Dynamic Roles

- **Orchestrator**: If planning or delegating, define non-overlapping scopes and write interfaces/contracts. Do not write implementation logic.
- **Peer Executor**: If assigned a feature/fix, execute only that scope. Do not spawn sub-agents or nested workflows.

### 2. Execution Loop (Shape Up + TDD)

1. **Scope & Appetite**: Identify exact files and boundaries.
2. **Define Contracts**: Update/write Types and Schemas first.
3. **Test First (Red)**: Write a failing test using Jest for the exact behavior.
4. **Implement (Green)**: Write the minimum code to pass the test.
5. **Handoff**: Stop. Do not refactor adjacent systems or "fix" out-of-scope files.

### 3. Standardized Handoff

Report status in this exact format:

```
[STATUS]         SUCCESS | BLOCKED | REQUIRES_PEER
[FILES_MODIFIED] list files changed
[NEW_CONTRACTS]  list any new Types/Schemas created
[MESSAGE]        concise summary; if blocked, state the unknown;
                 if REQUIRES_PEER, state the exact interface needed
```

---

## Operational Notes

- **Artifacts**: `data/companies.json`, `data/jobs.json`, `artifacts/html/<company-id>.html|.json`
- **Config**: `src/config.js` — all model defaults and key lookups; override per-agent via `.env.local`
- **Secrets**: use `.env.local` locally, GitHub Secrets in CI; never commit keys
- **Tests**: `npm test` (Jest, `--runInBand`)
- **Prompts**: `src/prompts/` — `extraction.txt`, `enrichment.txt`, `ocr.txt`, `ocr-pdf.txt`, `categorizer.txt`; edit to tune LLM behavior; bump `ENRICHMENT_PROMPT_VERSION` after changing `enrichment.txt` to force re-enrichment
- **Taxonomy maps**: `data/climate-tech-map-industry-categories.json` (canonical taxonomy), `data/pitchbook-taxonomy-map.json` (PitchBook classification → taxonomy mapping, multi-layer: emerging_spaces → verticals → industry_codes → industry_groups)
- **Architecture docs**: `docs/wrds-dual-lane-architecture.md` — Dual-Lane API-First categorization design (Lane 1: deterministic PitchBook cascade, Lane 2: LLM on API data, Lane 3: legacy cold scrape)
