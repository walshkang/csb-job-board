Project context — CSD Job Board

Purpose
Collect and enrich job listings for climate / clean-tech companies and store structured records in Airtable as the system of record. Data will originate from OCRed pitchbook screenshots, company websites, ATS APIs (Greenhouse, Lever), and plain HTML scraping. Work is organized into discrete "slices" to enable incremental delivery and independent iteration.

Build Slices

Slice 1 — Pitchbook OCR → Companies JSON
Input: screenshot image
Gemini 2.5 Flash-Lite does OCR → raw text/table JSON
Claude (or Gemma) maps columns → your Company schema
Output: companies.json with identity + funding signal + company profile fields populated
Validation: spot-check 10 companies against Pitchbook manually

Slice 2 — Careers Page Discovery
Input: companies.json
For each company: try {website_url}/careers, /jobs, check sitemap, then LLM fallback to guess URL from homepage HTML
Linkup or direct fetch to validate the URL returns 200
Output: companies.json updated with careers_page_url, careers_page_reachable, careers_page_discovery_method, ats_platform

Slice 3 — Job HTML Scraping
Input: companies with valid careers_page_url
Linkup fetches raw HTML from each careers page
Handle ATS-specific logic (Greenhouse API, Lever API are easier than scraping their HTML — worth detecting and using APIs where available)
Output: raw HTML stored per company, plus a scrape_runs record

Slice 4 — HTML → Jobs JSON
Input: raw HTML per company
Claude cleans and extracts into your Job schema
Populate: job_title_raw, source_url, location_raw, employment_type, description_raw, ats_platform
Dedup using description_hash + source_url
Output: jobs.json with identity + role details

Slice 5 — LLM Enrichment
Input: jobs.json with raw fields
Claude classifies: job_title_normalized, job_function, seniority_level, location_type, mba_relevance_score, description_summary, climate_relevance_confirmed
This is a separate slice because you'll iterate on these prompts independently
Output: enriched jobs.json

Slice 6 — Temporal Tracking + Lifecycle
This is your re-scrape loop: run Slices 3-4 on a schedule, update last_seen_at, detect removed_at, compute days_live, manage consecutive_empty_scrapes and dormancy transitions

Data model notes
- companies.json: canonical company id, name, domain, funding signals, company_profile fields, careers_page_url, ats_platform
- jobs.json: job id, company_id, job_title_raw, description_raw, source_url, location_raw, employment_type, timestamps (first_seen, last_seen)

Notion integration
- Notion acts as the backend: Jobs and Companies databases mirror the JSON schema
- Jobs link to Companies via a Notion relation property
- Use environment variables for NOTION_API_KEY, NOTION_COMPANIES_DB_ID, NOTION_JOBS_DB_ID; do not commit secrets
- Sync agent: src/agents/notion-sync.js (supports --companies-only, --jobs-only, --dry-run)

Validation and QA
- Each slice must include spot-check steps and sample-size validation criteria (e.g., spot-check 10–20 records)

Next steps (as of 2026-04-12)

Pipeline status
- Slices 1–6 and Notion sync are all implemented and committed
- OCR has been run: data/companies.json populated (~37 companies from test image)
- Discovery has been partially run; hit Gemini free-tier daily quota (20 req/day) on first full run

Immediate actions
1. Run discovery to completion
   - Free tier: run in batches with --limit=N across days, or enable billing in Google AI Studio
   - New step order: standard paths → ATS slug guesses → homepage link scan → sitemap → LLM fallback
   - LLM is now last resort; most companies should resolve without it
   - Daily quota now exits cleanly with progress saved

2. Run the full pipeline end-to-end for the first time
   npm run discovery
   npm run scrape
   npm run extract
   npm run enrich

3. Set up Notion databases
   - Create Companies and Jobs databases in Notion
   - Add all expected properties (see agents.md for field list)
   - Add NOTION_API_KEY, NOTION_COMPANIES_DB_ID, NOTION_JOBS_DB_ID to .env.local
   - Run: node src/agents/notion-sync.js --dry-run --verbose, then without --dry-run

4. Add more Pitchbook screenshots and re-run OCR to grow companies.json

Open questions
- Discovery yield: what % of companies are found via each method? Review methodCounts in summary log
- Enrichment quality: spot-check mba_relevance_score and climate_relevance_confirmed on 10-20 jobs
- Notion schema: confirm property names match what notion-sync.js expects before first live sync

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

Key lessons and high‑level improvements (prioritized):
1) Preflight & data hygiene (urgent): validate companies.json before runs; remove placeholders like 'example'; fail fast with clear errors.
2) Enrichment resiliency (urgent): implement retries with exponential backoff, alternate-model fallback, and strict JSON/schema validation of LLM outputs. Add a re‑enrichment scheduler for failed items.
3) Notion resilience (urgent): discover DB property names at runtime, map common aliases, and fall back gracefully with logging so syncs don't hard-fail.
4) Scraping strategy (short‑term): prefer ATS/API adapters (Greenhouse, Lever) and expand adapters before resorting to HTML scraping. Record method and failure reasons per company.
5) Scraping fallback (medium‑term): add a headless/browser scraping fallback (Playwright) for pages blocked by client-side protections — ensure legal review and respectful throttling.
6) Observability & ops (medium‑term): add metrics, dashboards, and alerts for scrape success rate, enrichment failure rate, LLM error patterns, and Notion upsert failures.
7) Testing & CI (medium‑term): add end‑to‑end smoke tests for a small sample dataset and CI checks for Notion sync.

Immediate next steps (short list):
- Remove 'example' from data/companies.json (data hygiene).
- Implement notion-sync dynamic schema mapping and re-run jobs-only sync (jobs were synced successfully after manual DB update).
- Implement enrichment retries/backoff and schedule re-enrichment for jobs with enrichment_error.
- Evaluate headless scraping for top blocked domains and plan legal/ops approach.
- Create tracked todos (session/plan.md + session SQL) and assign owners/PRs.

See session/plan.md for a prioritized todo list and owners.

Future: Streaming LLM output
Currently all LLM calls (OCR, discovery, enrichment, extraction) are fire-and-wait — the user sees nothing until the call completes. This creates a poor experience during long runs.

Goal: stream LLM thinking/output tokens in real time so progress is visible in the terminal. Each agent should surface per-job status lines (e.g. "Enriching [Company] — [job title]...") as tokens arrive rather than after the fact.

This is also the foundation for a future lightweight frontend (a simple web UI or terminal dashboard) that shows live pipeline progress: which company is being processed, current step, running counts of successes/failures, and enrichment scores as they come in.

Suggested approach:
- src/gemini-text.js is Gemini-specific; the abstraction should be provider-agnostic — a streamLLMText() wrapper that supports Gemini (generateContentStream), Anthropic (stream: true), and others
- Agents opt in per-call; no need to rewrite everything at once
- Log streamed output to stderr so stdout stays clean for JSON artifacts

Future: ATS fingerprinting + adapter expansion
Discovery currently classifies most careers pages as "custom" because it only checks URL patterns. Many climate-tech companies use Greenhouse, Lever, Ashby, or Workday under a custom domain — these all have public JSON endpoints that return clean structured data without scraping.

Goal: after fetching careers page HTML, scan for ATS fingerprints (Greenhouse iframe/embed, Lever API script tags, Ashby widget, Workday URL patterns) and update ats_platform accordingly. The scraper then routes to the right JSON API instead of parsing HTML, eliminating most CAPTCHA/403 failures.

Suggested approach:
- Add ATS fingerprint detection step in scraper.js (or as a post-discovery enrichment pass)
- Expand ATS adapter coverage: Greenhouse (boards.greenhouse.io/<slug>), Lever (jobs.lever.co/<slug>), Ashby (jobs.ashbyhq.com/<slug>), Workday
- Only fall back to HTML scraping (and eventually Playwright) for companies with no detectable ATS
