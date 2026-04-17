Agents and responsibilities

Overview
One agent per slice. All agents are idempotent, log outputs, and write artifacts to data/ or artifacts/. Model and key config is centralized in src/config.js — edit there or override via .env.local.

## Data Contracts
"If you get the type right, you're probably not far off." Schemas are the literal enforcement mechanism for parallelization.
- **Companies (data/companies.json)**: `id`, `name`, `careers_page_url`, `careers_page_reachable`, `ats_platform`, `ats_slug`, `consecutive_empty_scrapes`, `dormant`.
- **Jobs (data/jobs.json)**: `id`, `company_id`, `job_title_raw`, `source_url`, `description_hash`, `first_seen_at`, `last_seen_at`, `job_title_normalized`, `mba_relevance_score`, `climate_relevance_confirmed`.
- **Scrape Runs (data/scrape_runs.json)**: `company_id`, `timestamp`, `status`, `error_type`, `body_size_kb`.

## Concurrency & Scoping Rules
- **Volatile Filesystem**: Assume files are changing. Always read the current state of a shared file (e.g., `companies.json`) immediately before writing to it to avoid clobbering concurrent updates.
- **Strict Scoping**: Never modify files outside your assigned domain. Each agent owns its declared outputs; if a change is needed elsewhere, use the **Stub and Signal** rule: log the requirement and flag it for a peer agent/coordinator.
- **Idempotency**: All agents must be safe to re-run. Check for existing records or checksums before performing expensive operations or duplicate writes.

1) OCR Agent (Slice 1)
- File: src/agents/ocr.js
- Input: screenshot images (PNG/JPG) in a directory
- Tooling: Gemini 2.5 Flash-Lite (configurable via OCR_MODEL)
- Output: data/companies.json
- CLI: node src/agents/ocr.js <images_dir> [--dry-run]
- Notes: dry-run prints sample output without writing; merges into existing companies.json on re-runs

2) Discovery Agent (Slice 2)
- File: src/agents/discovery.js
- Input: data/companies.json
- Tooling: HTTP fetcher, sitemap parser, Playwright fallback, Gemini fallback for homepage heuristic
- Output: updated companies.json with careers_page_url, careers_page_reachable, careers_page_discovery_method, ats_platform
- CLI: node src/agents/discovery.js [--force] [--verbose] [--limit=N]
- Notes: --force re-runs already-discovered companies; --limit=N caps how many are processed in one run

3) ATS Fingerprinter (Slice 3)
- File: src/agents/fingerprinter.js
- Input: companies with careers_page_reachable === true
- Tooling: HTTP fetcher; caches homepage HTML to artifacts/html/{id}.homepage.html
- Output: updated companies.json with ats_platform, ats_slug
- CLI: npm run fingerprint
- Detects: greenhouse, lever, ashby, workday
- Notes: scraper trusts ats_platform set here for provider routing; URL extraction is fallback only

4) Scraper Agent (Slice 4)
- File: src/agents/scraper.js
- Input: companies with careers_page_reachable === true
- Tooling: native fetch; Greenhouse / Lever / Ashby / Workday API adapters; Playwright fallback for blocked pages
- Output: artifacts/html/{company_id}.json|html|playwright.html; appends to data/scrape_runs.json
- CLI: node src/agents/scraper.js [--companies=path]
- Provider routing: uses company.ats_platform first (set by fingerprinter), falls back to URL pattern extraction
- Provider concurrency limits: greenhouse=5, lever=5, ashby=5, workday=2, direct_html=3
- Playwright fallback: fires when direct HTML response is 4xx, <5KB, or non-HTML content-type; skips if body matches known blocker patterns (captcha, cookie walls)

5) Extraction Agent (Slice 5)
- File: src/agents/extraction.js
- Prompt: src/prompts/extraction.txt
- Input: artifacts/html/ (batch) or a single file (--input)
- Tooling: Gemini (configurable via EXTRACTION_MODEL); direct mapping for Greenhouse / Lever / Ashby / Workday JSON artifacts
- Output: data/jobs.json (merged, deduped by source_url + description_hash)
- CLI:
  - Batch (all companies): node src/agents/extraction.js [--dry-run]
  - Single company:        node src/agents/extraction.js --company=<id>
  - Single file:           node src/agents/extraction.js --input=<path> --base-url=<url> --company=<name>
- Schema out: id, company_id, job_title_raw, source_url, location_raw, employment_type, description_raw, description_hash, first_seen_at, last_seen_at
- ATS JSON mappers: mapGreenhouse, mapLever, mapAshby, mapWorkday — direct field mapping, no LLM needed for API artifacts

6) Enrichment Agent (Slice 6)
- File: src/agents/enricher.js
- Prompt: src/prompts/enrichment.txt (versioned — bump ENRICHMENT_PROMPT_VERSION to force re-enrichment of all jobs)
- Input: data/jobs.json
- Tooling: Gemini (configurable via ENRICHMENT_MODEL)
- Output: enriched data/jobs.json with classification fields
- CLI: node src/agents/enricher.js [--force] [--retry-errors] [--batch-size=N] [--concurrency=N] [--delay=N] [--stream] [--batch-mode]
- Fields added: job_title_normalized, job_function, seniority_level, location_type, mba_relevance_score, description_summary, climate_relevance_confirmed, climate_relevance_reason
- --batch-mode: sends 5 jobs per LLM call (5x fewer API calls); jobs that fail within a batch get enrichment_error set and can be retried with --retry-errors
- --retry-errors: only re-processes jobs with enrichment_error set
- --force: re-enriches all jobs regardless of prompt version or prior completion
- Rate-limited pool: concurrency=3, delay=1500ms between task starts; exponential backoff on 429/503; fallback model on persistent failure
- Description HTML is stripped before truncation to maximize signal within the 8000-char window

7) QA Agent (Slice 7)
- File: src/agents/qa.js
- Input: data/jobs.json
- Output: console report only (read-only, no writes)
- CLI: npm run qa
- Checks: enrichment error rate, climate relevance distribution, missing required fields
- Notes: run before Notion sync to catch anomalies; prints [WARN] for anything suspicious

8) Temporal Agent (Slice 8)
- File: src/agents/temporal.js
- Input: data/jobs.json, data/scrape_runs.json, data/companies.json
- Output: updated jobs.json (last_seen_at, removed_at, days_live) and companies.json (consecutive_empty_scrapes, dormant)
- CLI: node src/agents/temporal.js [--dry-run] [--verbose]
- Notes: run after each scrape+extract cycle; dormancy triggers at 3 consecutive empty scrapes

9) Notion Sync (Slice 8, continued)
- File: src/agents/notion-sync.js
- Input: data/companies.json, data/jobs.json
- Output: upserts to Notion Companies and Jobs databases
- CLI: node src/agents/notion-sync.js [--companies-only] [--jobs-only] [--dry-run] [--verbose]
- Env vars: NOTION_API_KEY, NOTION_COMPANIES_DB_ID, NOTION_JOBS_DB_ID
- Notes: upserts by id field; Jobs link to Companies via Notion relation; rate-limited to ~3 req/s; dynamic schema mapping tolerates renamed Notion properties

10) Reporter (Slice 9)
- File: src/agents/reporter.js
- Input: data/scrape_runs.json, data/companies.json, data/jobs.json
- Output: data/runs/YYYY-MM-DD-HH.json + data/runs/latest.json
- CLI: npm run reporter
- Metrics: per-provider scrape success rates, discovery yield, ATS distribution, enrichment error rate, climate relevance %, MBA score avg, small body count

11) Reviewer (Slice 9)
- File: src/agents/reviewer.js
- Input: data/runs/latest.json, data/scrape_runs.json, data/jobs.json, src/prompts/*.txt
- Output: data/postmortems/YYYY-MM-DD.md
- CLI: npm run review
- Tooling: Gemini (uses config.enrichment.apiKey + model)
- Notes: requires reporter to have run first; samples up to 10 scrape errors + 5 enrichment errors; LLM writes markdown postmortem with failure analysis and one prompt improvement suggestion
- Exit codes: 0=success, 2=missing API key, 3=quota error, 4=Gemini error, 5=write error

Utility scripts
- node src/agents/notion-setup.js   provision all DB properties (safe to re-run)
- node src/agents/notion-clear.js   archive all pages in both DBs (destructive)
## AI Assistant Protocol (Swarm Protocol)
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
`[STATUS]` (SUCCESS | BLOCKED | REQUIRES_PEER)
`[FILES_MODIFIED]` (List files changed)
`[NEW_CONTRACTS]` (List any new Types/Schemas created)
`[MESSAGE]` (Concise summary. If blocked, state the unknown. If `REQUIRES_PEER`, state the exact interface needed).

Operational notes
- Artifacts: data/companies.json, data/jobs.json, artifacts/html/<company-id>.html|.json
- Config: src/config.js — all model defaults and key lookups; override per-agent via .env.local
- Secrets: use .env.local locally, GitHub Secrets in CI; never commit keys
- Tests: npm test (Jest, --runInBand)
- Prompts: src/prompts/ — extraction.txt, enrichment.txt, ocr.txt; edit to tune LLM behavior; bump ENRICHMENT_PROMPT_VERSION after changing enrichment.txt to force re-enrichment
