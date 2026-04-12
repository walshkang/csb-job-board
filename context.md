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

