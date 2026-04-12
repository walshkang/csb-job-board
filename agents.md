Agents and responsibilities

Overview
One agent per slice. All agents are idempotent, log outputs, and write artifacts to data/ or artifacts/. Model and key config is centralized in src/config.js — edit there or override via .env.local.

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
- Tooling: HTTP fetcher, sitemap parser, Gemini fallback for homepage heuristic
- Output: updated companies.json with careers_page_url, careers_page_reachable, careers_page_discovery_method, ats_platform
- CLI: node src/agents/discovery.js [--force] [--verbose] [--limit=N]
- Notes: --force re-runs already-discovered companies; --limit=N caps how many are processed in one run

3) Scraper Agent (Slice 3)
- File: src/agents/scraper.js
- Input: companies with careers_page_reachable === true
- Tooling: native fetch, Greenhouse API adapter, Lever API adapter, direct HTML fallback
- Output: artifacts/html/{company_id}.html or .json, appends to data/scrape_runs.json
- CLI: node src/agents/scraper.js [--companies=path]

4) Extraction Agent (Slice 4)
- File: src/agents/extraction.js
- Prompt: src/prompts/extraction.txt
- Input: artifacts/html/ (batch) or a single file (--input)
- Tooling: Gemini (configurable via EXTRACTION_MODEL); direct mapping for Greenhouse/Lever JSON artifacts
- Output: data/jobs.json (merged, deduped by source_url + description_hash)
- CLI:
  - Batch (all companies): node src/agents/extraction.js [--dry-run]
  - Single company:        node src/agents/extraction.js --company=<id>
  - Single file:           node src/agents/extraction.js --input=<path> --base-url=<url> --company=<name>
- Schema out: id, company_id, job_title_raw, source_url, location_raw, employment_type, description_raw, description_hash, first_seen_at, last_seen_at

5) Enrichment Agent (Slice 5)
- File: src/agents/enricher.js
- Prompt: src/prompts/enrichment.txt (versioned — bump ENRICHMENT_PROMPT_VERSION to force re-enrichment)
- Input: data/jobs.json
- Tooling: Gemini (configurable via ENRICHMENT_MODEL)
- Output: enriched data/jobs.json with classification fields
- CLI: node src/agents/enricher.js [--force] [--batch-size=N]
- Fields added: job_title_normalized, job_function, seniority_level, location_type, mba_relevance_score, description_summary, climate_relevance_confirmed, climate_relevance_reason

6) Temporal Agent (Slice 6)
- File: src/agents/temporal.js
- Input: data/jobs.json, data/scrape_runs.json, data/companies.json
- Output: updated jobs.json (last_seen_at, removed_at, days_live) and companies.json (consecutive_empty_scrapes, dormant)
- CLI: node src/agents/temporal.js [--dry-run] [--verbose]
- Notes: run after each scrape+extract cycle; dormancy triggers at 3 consecutive empty scrapes

7) Notion Sync
- File: src/agents/notion-sync.js
- Input: data/companies.json, data/jobs.json
- Output: upserts to Notion Companies and Jobs databases
- CLI: node src/agents/notion-sync.js [--companies-only] [--jobs-only] [--dry-run] [--verbose]
- Env vars: NOTION_API_KEY, NOTION_COMPANIES_DB_ID, NOTION_JOBS_DB_ID
- Notes: upserts by id field; Jobs link to Companies via Notion relation; rate-limited to ~3 req/s

Operational notes
- Artifacts: data/companies.json, data/jobs.json, artifacts/html/<company-id>.html|.json
- Config: src/config.js — all model defaults and key lookups; override per-agent via .env.local
- Secrets: use .env.local locally, GitHub Secrets in CI; never commit keys
- Tests: npm test (Jest, --runInBand)
