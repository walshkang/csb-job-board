Project context — CSB Job Board

Purpose
Collect and enrich job listings for climate / clean-tech companies and store structured records in Notion as the system of record. Data originates from OCRed Pitchbook screenshots, company websites, ATS APIs (Greenhouse, Lever, Ashby, Workday), and plain HTML scraping. Work is organized into discrete slices that form a DAG and can be run independently.

Pipeline (current architecture)

Slice 1 — Pitchbook OCR → companies.json
  npm run ocr -- data/images
  Input: directory of Pitchbook screenshot images
  Gemini 2.5 Flash-Lite does vision OCR → extracts rows → maps to Company schema
  Output: data/companies.json with identity + funding signals + company_profile

Slice 2 — Careers Page Discovery
  npm run discovery
  Input: data/companies.json
  Step order: standard paths (/careers, /jobs) → ATS slug guesses → homepage link scan → sitemap → LLM fallback (last resort, only when homepage HTML is available)
  Output: companies.json updated with careers_page_url, careers_page_reachable, careers_page_discovery_method, ats_platform

Slice 3 — ATS Fingerprinting
  npm run fingerprint
  Input: companies with careers_page_reachable === true
  Scans homepage HTML for Greenhouse / Lever / Ashby / Workday fingerprints
  Updates ats_platform and ats_slug on each company
  Output: companies.json updated with accurate ats_platform

Slice 4 — Scrape / Fetch
  npm run scrape
  Input: companies with careers_page_reachable === true
  Routes by ats_platform: Greenhouse API → Lever API → Ashby API → Workday API → direct HTML
  Provider-keyed concurrency (per-provider rate limits)
  Output: artifacts/html/{company_id}.json|html + scrape_runs.json entries (with status field)

Slice 5 — Extraction
  npm run extract
  Input: artifacts per company
  LLM extracts jobs into Job schema; dedupes by source_url + description_hash
  Output: data/jobs.json with identity + role details

Slice 6 — LLM Enrichment
  npm run enrich [--retry-errors] [--force] [--batch-size=N] [--concurrency=N]
  Input: jobs.json with raw fields
  Gemini classifies: job_title_normalized, job_function, seniority_level, location_type, mba_relevance_score, description_summary, climate_relevance_confirmed
  Rate-limited worker pool (concurrency=3, delay=1500ms); exponential backoff on 429/503; fallback model on persistent failure
  Output: enriched jobs.json

Slice 7 — QA Spot-check
  npm run qa
  Read-only. Checks enrichment error rate, climate relevance distribution, missing fields. Prints [WARN] for anomalies. Run before Notion sync.

Slice 8 — Temporal Tracking + Notion Sync
  node src/agents/temporal.js     # update last_seen_at, removed_at, days_live, dormancy
  node src/agents/notion-sync.js  # upsert companies + jobs to Notion (supports --dry-run, --companies-only, --jobs-only)

Utility scripts
  node src/agents/notion-setup.js  # provision all DB properties (safe to re-run)
  node src/agents/notion-clear.js  # archive all pages in both DBs (destructive)

Data model
  companies.json: id, name, domain, funding_signals, company_profile, careers_page_url, careers_page_reachable, careers_page_discovery_method, ats_platform, ats_slug, dormant, consecutive_empty_scrapes
  jobs.json: id, company_id, job_title_raw, job_title_normalized, description_raw, source_url, location_raw, employment_type, job_function, seniority_level, location_type, mba_relevance_score, description_summary, climate_relevance_confirmed, climate_relevance_reason, first_seen_at, last_seen_at, removed_at, days_live, enrichment_prompt_version, enrichment_error

Notion integration
  Jobs and Companies databases mirror the JSON schema
  Jobs link to Companies via a Notion relation property
  Environment variables: NOTION_API_KEY, NOTION_COMPANIES_DB_ID, NOTION_JOBS_DB_ID (in .env.local, not committed)
  Dynamic schema mapping: notion-sync fetches DB property names at runtime and resolves via alias table — tolerant of renamed properties

Config / env
  GEMINI_API_KEY — shared key for all LLM agents (paid tier required for full runs)
  ENRICHMENT_FALLBACK_MODEL — default: gemini-1.5-flash
  Per-agent model overrides: OCR_MODEL, DISCOVERY_MODEL, EXTRACTION_MODEL, ENRICHMENT_MODEL

Current status (as of 2026-04-13)
  - All 8 slices implemented and committed
  - Test run completed on pitchbook-screenshot-test.png (~37 companies)
  - Discovery yield: 23/37 (62%) careers pages found; 14 not found (small/early-stage companies likely have none)
  - 13 jobs extracted; enrichment blocked on free-tier quota — needs paid GEMINI_API_KEY
  - Notion sync working: dynamic schema resolves properties correctly (false-positive warnings are cosmetic noise, not failures)
  - Next run requires: paid Gemini key in .env.local

Next meaningful work
  1. Add paid GEMINI_API_KEY and run full pipeline end-to-end
  2. Review QA output: enrichment error rate, climate relevance distribution
  3. Check ATS fingerprinting yield: how many "custom" companies resolve to a known ATS
  4. Add more Pitchbook screenshots → re-run OCR to grow companies.json

Open questions
  - ATS fingerprinting yield: will it meaningfully reduce "custom" classifications?
  - Discovery LLM fallback: how often does it fire vs. return NOT_FOUND (now tracked separately as llm_fallback_attempted)
  - Enrichment quality at scale: spot-check mba_relevance_score and climate_relevance_confirmed on 20+ jobs once enrichment runs cleanly

Postmortem — 2026-04-13

Summary:
- Good:
  - Modular, tested agents; atomic JSON writes; clear artifacts folder pattern.
  - ATS adapters and Notion sync worked after a quick schema fix.
- Bad / Blockers:
  - Many careers pages blocked by CAPTCHA/cookie walls or returned 403, causing large data loss during extraction.
  - LLM fragility: transient Gemini 503s and occasional parse failures led to partial enrichment.
  - Placeholder 'example' was present in companies.json and polluted scrape/run stats.
  - Notion schema mismatch initially blocked sync until DB props were added.
  - Enrichment Promise.all blasted quota — all jobs in a batch fired simultaneously.
  - scrape_runs.json entries missing status field (status: undefined).

Resolved since postmortem:
  - validateCompanies() preflight removes placeholders across all agents
  - Enrichment retries: 503 backoff, fallback model, --retry-errors flag
  - Enrichment uses rate-limited worker pool (no more Promise.all quota blast)
  - Notion dynamic schema mapping + canonical map split (no more false-positive warnings)
  - scrape_runs status field fixed
  - Ashby + Workday adapters added; provider-keyed concurrency
  - ATS fingerprinting slice added (Slice 3)
  - QA spot-check slice added (Slice 7)
  - Discovery LLM fallback: skips when no homepage HTML; tracks attempted vs. succeeded

Still open (medium-term):
  - Playwright fallback for CAPTCHA/JS-rendered pages (legal review first; nonprofit use is low-risk)
  - Observability: metrics and alerts for scrape success rate, enrichment failure rate
  - End-to-end smoke tests and CI

Future: Streaming LLM output
Currently all LLM calls are fire-and-wait — nothing visible until the call completes.

Goal: stream tokens in real time so progress is visible per-job in the terminal. Foundation for a future lightweight frontend (web UI or terminal dashboard) showing live pipeline progress.

Approach:
  - Provider-agnostic streamLLMText() wrapper: Gemini (generateContentStream), Anthropic (stream: true), others
  - Agents opt in per-call; no full rewrite needed
  - Log streamed output to stderr; stdout stays clean for JSON artifacts
