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
  Step order: standard paths (/careers, /jobs) → ATS slug guesses → homepage link scan → sitemap → LLM fallback (fires even without homepage HTML — uses company name + domain + derived slugs)
  Output: companies.json updated with careers_page_url, careers_page_reachable, careers_page_discovery_method, ats_platform

Slice 3 — ATS Fingerprinting
  npm run fingerprint
  Input: companies with careers_page_reachable === true
  Scans homepage + careers page HTML for Greenhouse / Lever / Ashby / Workday / Rippling / Jobvite / iCIMS / SmartRecruiters fingerprints
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

Slice 9 — Industry Categorization
  npm run categorize [--force] [--dry-run]
  Input: data/jobs.json + data/companies.json + data/climate-tech-map-industry-categories.json
  One LLM call per unique company (not per job) — result applied to all jobs for that company
  Writes: climate_tech_category, primary_sector, opportunity_area, category_confidence onto each job
  Skips companies already categorized unless --force; rate-limited pool (concurrency=3, delay=1000ms)
  Note: requires maxOutputTokens >= 4096 when using gemini-2.5-flash (thinking tokens consume budget)

Slice 10 — Observability
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
  LLM_PROVIDER — "gemini" | "anthropic"; auto-detects from available keys if omitted (GEMINI_API_KEY → gemini, ANTHROPIC_API_KEY → anthropic)
  GEMINI_API_KEY — shared key for all LLM agents (paid tier required for full runs)
  ANTHROPIC_API_KEY — enables Anthropic provider; setting this without GEMINI_API_KEY routes all agents through Claude
  ENRICHMENT_FALLBACK_MODEL — default: gemini-1.5-flash (Gemini only; ignored when provider is anthropic)
  Per-agent model overrides (Gemini): OCR_MODEL, DISCOVERY_MODEL, EXTRACTION_MODEL, ENRICHMENT_MODEL
  Per-agent model overrides (Anthropic, default claude-haiku-4-5-20251001): OCR_ANTHROPIC_MODEL, DISCOVERY_ANTHROPIC_MODEL, EXTRACTION_ANTHROPIC_MODEL, ENRICHMENT_ANTHROPIC_MODEL, CATEGORIZER_ANTHROPIC_MODEL, REVIEWER_ANTHROPIC_MODEL
  Per-agent provider overrides: OCR_PROVIDER, DISCOVERY_PROVIDER, EXTRACTION_PROVIDER, ENRICHMENT_PROVIDER, CATEGORIZER_PROVIDER, REVIEWER_PROVIDER

Current status (as of 2026-04-14)
  - 10 slices implemented and running end-to-end
  - 102 companies in companies.json; 19 reachable careers pages; 65 have domains but haven't been through discovery yet
  - 15 companies blocked by CAPTCHA/JS rendering — no jobs extractable without browser fingerprint spoofing
  - Jobs extracted from API adapters (Greenhouse, Lever, Ashby, Workday) and direct HTML where accessible
  - Enrichment, categorization, and observability working with gemini-2.5-flash (paid tier)
  - Key bug fixed: gemini-2.5-flash thinking tokens consume maxOutputTokens budget — all agents now use 4096+
  - Extraction prompt hardened: no hallucination of URLs or descriptions not present in HTML
  - Industry categorization (Slice 9): one LLM call per company, result applied to all jobs; scraped_description + job-samples now passed as context
  - Slice 9 fields (climate_tech_category, primary_sector, opportunity_area, category_confidence) synced to Notion Companies DB
  - Notion setup + sync alias tables updated for Slice 9 fields
  - Fingerprinter (Slice 3): now fetches and caches careers page HTML in addition to homepage; extracts scraped_description from both

Next meaningful work
  1. Re-run discovery (npm run discovery) — 65 companies with domains have never been processed; target selection bug now fixed
  2. Add more Pitchbook screenshots → re-run OCR to grow companies.json
  3. Run npm run reporter + npm run review after each full pipeline run

Open questions
  - ATS fingerprinting yield: will it meaningfully reduce "custom" classifications?
  - Discovery LLM fallback: how often does the no-HTML path fire vs. return NOT_FOUND? (llm_attempted now persisted to companies.json — check after next discovery run)
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
  - Discovery LLM fallback: now fires even without homepage HTML (name+domain+slugs); tracks attempted vs. succeeded; llm_attempted persisted to companies.json

Still open (medium-term):
  - End-to-end smoke tests and CI
  - Prompt proposal generation: reviewer --propose flag writes prompts/proposed/ diffs for human review
  - Fingerprinter: expanded ATS coverage — DONE (Rippling, Jobvite, iCIMS, SmartRecruiters added to detectFromHtml)
  - Dynamic rate limiting in enricher (track req/min, throttle on 429 rather than fixed delay)
  - Extraction: Ashby + Workday mappers — DONE (mapAshby/mapWorkday exist in extraction.js:83-114 and are wired at lines 275/277)

Multi-provider LLM support — DONE (2026-04-15)
src/llm-client.js is the single dispatch layer for all text agents. callLLM/streamLLM route to Gemini or Anthropic based on provider config. All agents migrated; gemini-text.js deleted. Setting only ANTHROPIC_API_KEY runs the full pipeline on Claude Haiku.

Project todos (session DB):
1. define-pitchbook-query — Define Pitchbook query: Decide and document exact PitchBook filters that define "climate company" (NAICS, keywords, investor tags). Produce reproducible query and example export.
2. [DONE] careers-page-discovery — Slice 2 implemented with heuristics, ATS slug guesses, LLM fallback, and reachable flag.
3. [DONE] ats-priority-adapters — Greenhouse, Lever, Ashby, Workday adapters implemented with provider-keyed concurrency.
4. categorizer-dry-run-review — Run TF‑IDF + LLM dry-run, review /tmp/tfidf_proposed_categories.json, and mark taxonomy entries needing human edits.
5. taxonomy-human-review — Coordinate human review of data/climate-tech-map-industry-categories.json; do not auto-apply changes until approved.
6. mba-rubric — Define MBA relevance rubric: write explicit scoring rubric and sample labeled examples for LLM prompting.
7. scraping-cadence-dormancy — Implement scraping cadence (3–5 days) and dormancy logic (consecutive empty scrapes >=6 → dormant).
8. notion-sync-qa — Notion sync dry-run & QA: run node src/agents/notion-sync.js --dry-run after categorize/enrich and verify property mappings.
9. analytics-metrics — Add analytics to compute days_live, funding_to_posting_lag, posting longevity buckets, and surface reporter metrics.
10. user-facing-filters — Design user-facing filters and mock a Notion view for MBA users (function, location, remote, seniority, MBA score).

Decision needed: company summary source
- We currently lack reliable PitchBook-exported company descriptions in the screenshots. Need to decide the canonical source for company_profile.description (pick one):
  1) PitchBook export/API (preferred if you have direct access — single definitive source)
  2) Playwright crawl of company home/about pages (best for coverage but CPU/time intensive)
  3) Google/SerpAPI knowledge snippets (requires API key and TOS compliance)
  4) Third-party data (Crunchbase / LinkedIn licensed data)

Action: record your preferred source and I will implement the prioritized retrieval path (caching, rate limits, and dry‑run before any writes).