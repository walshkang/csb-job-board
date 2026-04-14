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
  Note: scraper trusts ats_platform from this slice for provider routing; URL extraction is fallback only

Slice 4 — Scrape / Fetch
  npm run scrape
  Input: companies with careers_page_reachable === true
  Routes by ats_platform: Greenhouse API → Lever API → Ashby API → Workday API → direct HTML
  Provider-keyed concurrency (per-provider rate limits)
  Playwright fallback: direct HTML responses that are 4xx, <5KB, or non-HTML are retried with headless Chromium
  Playwright saves artifacts as {company_id}.playwright.html; skips if body matches known blocker patterns
  Output: artifacts/html/{company_id}.json|html + scrape_runs.json entries (with status field)

Slice 5 — Extraction
  npm run extract
  Input: artifacts per company
  LLM extracts jobs into Job schema; dedupes by source_url + description_hash
  Output: data/jobs.json with identity + role details

Slice 6 — LLM Enrichment
  npm run enrich [--retry-errors] [--force] [--batch-size=N] [--concurrency=N] [--batch-mode]
  Input: jobs.json with raw fields
  Gemini classifies: job_title_normalized, job_function, seniority_level, location_type, mba_relevance_score, description_summary, climate_relevance_confirmed
  Rate-limited worker pool (concurrency=3, delay=1500ms); exponential backoff on 429/503; fallback model on persistent failure
  --batch-mode: sends 5 jobs per LLM call instead of 1; reduces API calls 5x; individual failures within a batch fall back to --retry-errors
  Description HTML stripped before truncation to maximize signal within the 8000-char window
  Output: enriched jobs.json

Slice 7 — QA Spot-check
  npm run qa
  Read-only. Checks enrichment error rate, climate relevance distribution, missing fields. Prints [WARN] for anomalies. Run before Notion sync.

Slice 8 — Temporal Tracking + Notion Sync
  node src/agents/temporal.js     # update last_seen_at, removed_at, days_live, dormancy
  node src/agents/notion-sync.js  # upsert companies + jobs to Notion (supports --dry-run, --companies-only, --jobs-only)

Slice 9 — Observability
  npm run reporter   # aggregates scrape_runs.json + companies.json + jobs.json → data/runs/YYYY-MM-DD-HH.json + data/runs/latest.json
  npm run review     # reads latest.json + samples failures → calls Gemini → writes data/postmortems/YYYY-MM-DD.md
  Reporter: per-provider scrape success rates, discovery yield, ATS distribution, enrichment error rate, climate relevance %, MBA score avg
  Reviewer: LLM-written postmortem; requires GEMINI_API_KEY; outputs markdown with what went well, failures, worst stage, one prompt suggestion

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

Current status (as of 2026-04-14)
  - 9 slices implemented; Playwright fallback, batch enrichment, and observability added since first test run
  - Test run completed on pitchbook-screenshot-test.png (~37 companies)
  - Discovery yield: 23/37 (62%) careers pages found; 14 not found (small/early-stage companies likely have none)
  - 13 jobs extracted; enrichment blocked on free-tier quota — needs paid GEMINI_API_KEY
  - Notion sync working: dynamic schema resolves properties correctly
  - Scraper now routes by fingerprinter-detected ats_platform; Playwright fallback fires on 4xx / <5KB / non-HTML responses
  - Observability: npm run reporter → run summary JSON; npm run review → LLM postmortem markdown
  - Enricher: --batch-mode sends 5 jobs per LLM call; HTML stripped before truncation

Next meaningful work
  1. Add paid GEMINI_API_KEY and run full pipeline end-to-end
  2. Run npm run reporter then npm run review after first enriched run
  3. Add more Pitchbook screenshots → re-run OCR to grow companies.json
  4. Check ATS fingerprinting yield: how many "custom" companies resolve to a known ATS

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
  - End-to-end smoke tests and CI
  - Prompt proposal generation: reviewer --propose flag writes prompts/proposed/ diffs for human review
  - Fingerprinter: expand ATS coverage (Rippling, Jobvite, iCIMS, Smartrecruiters)
  - Dynamic rate limiting in enricher (track req/min, throttle on 429 rather than fixed delay)
  - Extraction: Ashby + Workday mappers (gap — artifacts produced but no mapper to extract jobs from them)

Future: Streaming LLM output
Currently all LLM calls are fire-and-wait — nothing visible until the call completes.

Goal: stream tokens in real time so progress is visible per-job in the terminal. Foundation for a future lightweight frontend (web UI or terminal dashboard) showing live pipeline progress.

Approach:
  - Provider-agnostic streamLLMText() wrapper: Gemini (generateContentStream), Anthropic (stream: true), others
  - Agents opt in per-call; no full rewrite needed
  - Log streamed output to stderr; stdout stays clean for JSON artifacts
