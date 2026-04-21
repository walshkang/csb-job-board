Project context — CSB Job Board

Purpose
Collect and enrich job listings for climate / clean-tech companies and store structured records in Notion as the system of record. Data originates from OCRed Pitchbook screenshots, company websites, ATS APIs (Greenhouse, Lever, Ashby, Workday), and plain HTML scraping. Work is organized into discrete slices that form a DAG and can be run independently.

Pipeline (current architecture)

Note: The pipeline distinguishes 'cold' and 'warm' lanes to optimize processing and token spend. See docs/lanes-slices.md for details and the slice breakdown.

Slice 1 — Pitchbook OCR → companies.json
  npm run ocr -- data/images
  Input: directory of Pitchbook PDFs (primary) or screenshot images (fallback)
  PDF mode: Tabula (tabula.jar, stream mode) extracts table rows deterministically — no LLM.
    Scans page 1 by text to locate the column header row (skipping PitchBook nav chrome above it),
    maps cells to columns by x-coordinate, strips leading row numbers from company name cells.
  Screenshot mode: LLM vision OCR via src/prompts/ocr.txt
  Output: data/companies.json with identity + funding signals + company_profile

Slice 9 — Industry Categorization
  npm run categorize [--force] [--dry-run]
  Input: data/companies.json (+ optional data/jobs.json) + data/climate-tech-map-industry-categories.json
  One LLM call per unique company (not per job) — result applied to all jobs for that company
  Writes: climate_tech_category, primary_sector, opportunity_area, category_confidence onto each company and its jobs
  Can be run immediately after OCR — uses PitchBook keywords, HQ, and company metadata; jobs.json is optional
  Skips companies already categorized unless --force; rate-limited pool (concurrency=3, delay=1000ms)
  Note: requires maxOutputTokens >= 4096 when using gemini-2.5-flash (thinking tokens consume budget)

Slice 2 — Careers Page Discovery
  npm run discovery
  Input: data/companies.json
  Step order: standard paths (/careers, /jobs, 8 total, probed in parallel via Promise.any) → ATS slug guesses → homepage link scan → sitemap → LLM fallback (fires even without homepage HTML — uses company name + domain + derived slugs; capped at 3 concurrent)
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
  Gemini classifies: job_title_normalized, job_function, seniority_level, location_type, mba_relevance, description_summary, climate_relevance_confirmed
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



Slice 10 — Observability
  npm run reporter   # aggregates scrape_runs.json + companies.json + jobs.json → data/runs/YYYY-MM-DD-HH.json + data/runs/latest.json
  npm run review     # reads latest.json + samples failures → calls Gemini → writes data/postmortems/YYYY-MM-DD.md
  Reporter: per-provider scrape success rates, discovery yield, ATS distribution, enrichment error rate, climate relevance %, MBA relevance tier distribution
  Reviewer: LLM-written postmortem; requires GEMINI_API_KEY; outputs markdown with what went well, failures, worst stage, one prompt suggestion

Utility scripts
  node src/agents/notion-setup.js  # provision all DB properties (safe to re-run)
  node src/agents/notion-clear.js  # archive all pages in both DBs (destructive)

Data model
  companies.json: id, name, domain, funding_signals, company_profile, careers_page_url, careers_page_reachable, careers_page_discovery_method, ats_platform, ats_slug, dormant, consecutive_empty_scrapes
  jobs.json: id, company_id, job_title_raw, job_title_normalized, description_raw, source_url, location_raw, employment_type, job_function, seniority_level, location_type, mba_relevance, climate_relevance_confirmed, climate_relevance_reason, first_seen_at, last_seen_at, removed_at, days_live, enrichment_prompt_version, enrichment_error

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
  2. Add more Pitchbook PDFs → re-run OCR → re-run categorize → run discovery through sync.
  3. Run npm run reporter + npm run review after each full pipeline run

Open questions
  - ATS fingerprinting yield: will it meaningfully reduce "custom" classifications?
  - Discovery LLM fallback: how often does the no-HTML path fire vs. return NOT_FOUND? (llm_attempted now persisted to companies.json — check after next discovery run)
  - Enrichment quality at scale: spot-check mba_relevance and climate_relevance_confirmed on 20+ jobs once enrichment runs cleanly

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
10. user-facing-filters — Design user-facing filters and mock a Notion view for MBA users (function, location, remote, seniority, MBA relevance).

Streaming orchestrator (concurrent pipeline)

The linear per-stage CLIs above each iterate all 551 companies before the next CLI starts; one slow company blocks the rest. The orchestrator at src/orchestrator.js (npm run pipeline) instead runs all five stages (discovery → fingerprint → scrape → extract → categorize) concurrently with per-stage p-queue caps, so each company flows through independently and head-of-line blocking is gone. Enrichment stays separate (per-job, not per-company) for now.

Per-stage concurrency caps: profile=6, discovery=12, fingerprint=4, scrape=5, extract=4, enrich=6, categorize=10. (Bumped from discovery=8/enrich=3/categorize=3 on 2026-04-20 after observing LLM-stage backpressure — categorize had 229 queued mid-run. Earlier reduction from 15/5/8 on 2026-04-17 was to prevent OOM; LLM stages are not memory-bound and can scale higher.) The individual `npm run <stage>` scripts still work unchanged; the orchestrator just composes them.

Categorize gate (2026-04-20): companies reaching the categorize stage with no rep job AND a company_profile.description shorter than 80 chars are skipped (`outcome: 'skipped', extra.reason: 'insufficient_signal'`) rather than burning an LLM call that returns "None". Drops no_result rate and token spend on hopeless inputs.

Provider vs pipeline failure separation (2026-04-20): src/utils/pipeline-events.js::classifyLlmMessage pattern-matches LLM provider error strings (Gemini/Anthropic/Claude) and returns one of llm_provider_billing | llm_provider_auth | llm_rate_limit. Categorize no_result events now carry failure_class + error_origin: 'provider' when the cause is a provider response. The admin stage-detail panel stacks new banners (rose for billing/quota, sky for rate limits, orange for auth) on AI-driven stages so provider outages are visible instantly and not mistaken for pipeline bugs. pipeline-report.js aggregates no_result reasons as category_error:{failure_class} so provider issues show up by class in the dashboards.

Stage state is derived, not stamped as a new field, so agents and orchestrator stay coherent. src/utils/pipeline-stages.js::getStage inspects the company record (careers_page_discovery_method, careers_page_reachable, ats_platform, fingerprint_attempted_at, last_scraped_at, last_extracted_at, climate_tech_category) and returns which stage should run next. Companies with careers_page_reachable === false skip straight to categorize. Crash-resume is automatic — startup calls getStage for every company and enqueues it into the matching queue.

Three-state outcomes per stage (not binary):
  success    — data advanced (e.g. careers_page_reachable flipped true; ats_platform detected; jobs.length > 0; climate_tech_category set and not "None")
  no_result  — stage ran cleanly but produced nothing (discovery found nothing, LLM returned "None", extract got 0 jobs). Discovery and fingerprint still advance on no_result; scrape/extract/categorize stay put for the next run to retry.
  failure    — exception thrown. Company does not advance.

The orchestrator emits these as JSONL events with the classifier from src/utils/pipeline-events.js (classes: timeout, dns, http_4xx, http_5xx, blocked, llm_parse_fail, llm_rate_limit, empty_result, unknown) and writes live queue depths + throughput to data/runs/orchestrator-snapshot.json every 5s. Event files are at data/runs/pipeline-events-{run_id}.jsonl with retention=30.

Observability surfaces:
  scripts/pipeline-status.js         — stage counts across all companies in companies.json (file-derived, works without orchestrator running)
  scripts/pipeline-report.js         — event aggregates: ok/no_result/fail/skip per stage, p50/p95, failure classes, no-result reasons, slowest 10, recent failures; --watch, --all, --company=
  scripts/discovery-status.js        — discovery-specific view (pre-orchestrator; still works)
  data/runs/orchestrator-snapshot.json — live queue depths, in-flight counts, throughput-per-min

Planned improvements (tracked here, not yet implemented)

Orchestrator resilience (2026-04-20) — see docs/pipeline-improvements-slices.md
  Sliced prompts for red/green TDD execution. Dependency graph:
    Slice 1 (telemetry bug fixes: progress-bar math, skipped_signature_match unification) — parallelizable
    Slice 2 (failure-class vocabulary + retry with exponential backoff for transient classes) — foundation
    Slice 3 (per-stage circuit breaker with manual reset, admin UI banner) — after Slice 2
    Slice 4 (batch categorize: 5–10 companies per LLM call, partial-failure fallback) — after Slice 2, parallel with Slice 3
    Slice 5 (adaptive concurrency: auto-tune within [min,max] based on p95 + error rate) — after 2 + 3
  All sized for Sonnet. Wave A = {1, 2} parallel; Wave B = {3, 4} parallel; Wave C = 5.

Company description source & timing (NEW)
  - Objective: Move company description generation from job-level extraction to company-level categorization.
  - Rationale: Job listings are often a poor source for general company summaries.
  - Implementation options:
    - Dedicated agent to crawl home/about pages (best coverage).
    - No description until retrieval process is more robust (safety first).
  - Status: Planned for Slice 9 integration.

Categorization quality
  Problem: LLM frequently returns "None" / low confidence even when PitchBook keywords clearly signal a sector. Current smoke tests show >50% no_result rate on categorize.
  Hypotheses:
    a) Prompt underweights PitchBook keywords — taxonomy descriptions dominate the LLM's attention.
    b) Taxonomy entries (~90 categories) are too granular → "None" is the safest answer under ambiguity.
    c) Representative job is missing or weak for pre-scrape companies; the synthesized description (just company name) gives the LLM nothing to work with.
  Sketch of improvements, ordered by appetite:
    1. Instrument no_result rate per category and per input-quality bucket (has_jobs vs synthesized_only) to confirm hypothesis before changing prompts.
    2. Shortlist candidate categories deterministically first (keyword/embedding match against taxonomy) — feed only top 5–10 to the LLM instead of all 90. Should cut "None" rate and token cost.
    3. Add a two-stage prompt: stage 1 picks the primary_sector (coarse, ~10 options), stage 2 picks the climate_tech_category within that sector. Easier decisions per call.
    4. Confidence-aware pipeline: record LLM confidence; below a threshold (e.g. "low") route to a human-review queue (new file data/review_queue/categories.jsonl) instead of silently accepting.
    5. Fallback to TF-IDF over PitchBook keywords when LLM returns "None" with no synthesized job context — better than null.

Scraping quality
  Problem: scrape stage frequently no_results for direct HTML / Playwright fallback companies. ATS-API paths (Greenhouse, Lever, Ashby, Workday) are reliable; the long tail is where listings live in custom job boards, iframed boards, or JS-rendered pages not covered by our current Playwright configuration.
  Hypotheses:
    a) Playwright fallback waits are too short for heavy SPAs (Workday-clones, Workable, BambooHR).
    b) We don't detect additional ATS platforms we already see in the wild (Workable, Recruitee, Teamtailor, Rippling, iCIMS beyond our current fingerprints).
    c) Some pages need a click-through (view more, load more, iframe entry) we don't currently perform.
    d) Careers URL found by discovery is a hub page linking out to the actual ATS — we scrape the hub, get nothing useful.
  Sketch of improvements:
    1. Failure-class histogram per scrape no_result (we now emit status_code, byte_length, error) — build it from pipeline-events to see which tail is largest before writing code.
    2. Expand fingerprint detection: Workable (apply.workable.com), Recruitee (*.recruitee.com), Teamtailor (*.teamtailor.com), BambooHR (*.bamboohr.com/jobs), iCIMS. Each should route to a known-good scraper (API or HTML pattern).
    3. Secondary discovery: if careers_page_url looks like a hub (no detectable ATS and <5 links below it), LLM-assisted follow-link step ("which of these links is the actual jobs list?").
    4. Playwright tuning: longer networkidle wait for SPAs, explicit scroll-to-bottom for infinite-scroll boards, click-handling for "show more jobs".
    5. Per-company scrape-method memory: once we successfully scrape a company one way, prefer that method on next run instead of re-detecting.
    6. Structured "scrape_health" per company: last_method, last_success, consecutive_empty_scrapes (already on the record) — use consecutive_empty_scrapes >= N to demote into a slower cadence rather than re-scraping every run.

OOM fix — 2026-04-17

Root causes identified and patched:
  1. GoogleGenerativeAI + Anthropic SDK clients instantiated per LLM call — 20+ concurrent calls created separate client objects with their own HTTP pools, never GC'd fast enough. Fixed: module-level cache by API key in llm-client.js.
  2. Orchestrator concurrencies too aggressive: discovery=15, scrape=8. Fixed: discovery→8, fingerprint→4, scrape→5.
  3. Default Node heap (~1.5GB) undersized for 551-company run. Fixed: --max-old-space-size=4096 in pipeline script.

Audit findings — 2026-04-17

Improvements ordered by impact. Parallelization notes where independent.

[A] ATS detection centralization (medium effort, low risk — can do in parallel with anything)
  Problem: URL-based ATS detection re-implemented separately in discovery.js, fingerprinter.js, and scraper.js with slightly different regex. Drift will cause silent misrouting.
  Fix: single shared util/ats-detect.js (detectATS(url, html?) → { platform, slug }). Wire discovery + scraper to use it; fingerprinter already does HTML-based detection so it becomes a strict superset.

[B] Homepage/careers HTML cached once per run (medium effort — independent of A/C)
  Problem: discovery fetches homepage, then fingerprinter re-fetches the same URL independently. ~551 redundant HTTP requests per full run.
  Fix: orchestrator passes cached HTML artifacts from fingerprint stage into scrape stage. Already partially done (fingerprinter writes {id}.homepage.html + {id}.careers.html); scraper just needs to read those instead of re-fetching.

[C] HTML truncation ceiling too low for custom sites (small effort — independent)
  Problem: extraction.js truncates HTML to 12,000 chars before LLM call. Custom/non-ATS pages with 30+ jobs routinely exceed this; jobs past the cutoff are silently lost. ATS API paths (Greenhouse, Lever, Ashby, Workday) are unaffected.
  Fix: raise MAX_HTML_CHARS to 24,000 for direct_html / playwright_html methods; keep low limit for ATS JSON (no HTML to send). Add a log line when truncation fires so we can measure impact.
  Note: increases LLM token cost for the ~30% of companies on custom sites.

[D] Extraction attempt timestamp (tiny effort — independent)
  Problem: last_extracted_at only set on success. Can't distinguish "never attempted" from "tried and failed" — makes retry analysis hard.
  Fix: add last_extraction_attempt_at set at start of extract stage regardless of outcome.

[E] Dormant company auto-revival (small effort)
  Problem: temporal.js sets dormant=true after 5 empty scrapes but nothing ever unsets it, even if a company relaunches hiring.
  Fix: add a periodic re-discovery pass for dormant companies (e.g. once every 30 days) that resets dormant=false if careers page becomes reachable again.

[F] QA wired into pipeline end (tiny effort — independent)
  Problem: npm run qa is manual-only. Enrichment error rate and climate relevance anomalies go unnoticed until a human runs it.
  Fix: call qa logic (or print equivalent summary) at end of orchestrator shutdown, writing to stderr. No blocking — just visibility.

[G] Playwright default for discovery (medium effort — depends on A)
  Problem: discovery uses Playwright only with --playwright flag. Scraper auto-detects SPA shells and triggers Playwright; discovery doesn't, so careers URLs found via static scan may be SPA shells that return no useful links.
  Fix: enable Playwright fallback in discovery by default for any homepage that returns <4 links (same heuristic scraper uses).

Parallelization plan:
  Can start simultaneously right now: A + B + C + D + F
  Depends on A first: G
  Independent medium-term: E

Decision needed: company summary source
- Decision reached: Move generation to Categorization stage.
- Current Path: Evaluating either a dedicated "About Page" crawler agent or deferring descriptions entirely until retrieval is high-confidence.ng descriptions entirely until retrieval is high-confidence.