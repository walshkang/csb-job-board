CSB Job Board

A pipeline that collects climate/clean-tech job listings from Pitchbook screenshots, company careers pages, and ATS APIs, then syncs structured records to Notion.

## Pipeline overview

| Slice | Agent | npm script | Status |
|-------|-------|-----------|--------|
| 1 — OCR → companies.json | `src/agents/ocr.js` | `npm run ocr -- data/images` | Done |
| 2 — Careers page discovery | `src/agents/discovery.js` | `npm run discovery` | Done |
| 3 — HTML scraping | `src/agents/scraper.js` | `npm run scrape` | Done |
| 4 — HTML → jobs.json | `src/agents/extraction.js` | `npm run extract` | Done |
| 5 — LLM enrichment | `src/agents/enricher.js` | `npm run enrich` | Done |
| 6 — Temporal tracking | `src/agents/temporal.js` | `node src/agents/temporal.js` | Done |
| — Notion sync | `src/agents/notion-sync.js` | `node src/agents/notion-sync.js` | Done |

## Setup

Copy `.env.local.example` to `.env.local` and fill in your keys:

```
GEMINI_API_KEY=...
NOTION_API_KEY=...
NOTION_COMPANIES_DB_ID=...
NOTION_JOBS_DB_ID=...
```

Install dependencies:

```bash
npm install
```

## Model configuration

All model and key settings live in `src/config.js`. Override per-agent models in `.env.local`:

```
# Per-agent overrides (uncomment to switch)
# OCR_MODEL=gemini-2.5-flash-lite
# DISCOVERY_MODEL=gemini-2.5-flash
# EXTRACTION_MODEL=gemini-2.5-flash
# ENRICHMENT_MODEL=gemini-2.5-flash

# Or override all at once
# GEMINI_MODEL=gemini-2.0-flash
```

## Running the pipeline

```bash
# 1. OCR Pitchbook screenshots → data/companies.json
npm run ocr -- data/images

# 2. Discover careers page URLs
npm run discovery

# 3. Scrape careers pages → artifacts/html/
npm run scrape

# 4. Extract jobs from HTML → data/jobs.json
npm run extract

# 5. Enrich jobs with LLM classification
npm run enrich

# 6. Update temporal fields (run after each re-scrape)
node src/agents/temporal.js

# Sync to Notion
node src/agents/notion-sync.js
```

## Tests

```bash
npm test
```

## Data layout

```
data/
  companies.json       canonical company list
  jobs.json            enriched job listings
  scrape_runs.json     log of each scrape run
artifacts/
  html/                raw HTML/JSON per company (gitignored)
src/
  agents/              one file per slice
  prompts/             LLM prompt templates
  config.js            central model/key config
  gemini-text.js       shared Gemini API helper
```

## Security

Never commit `.env.local` or any file containing API keys.
