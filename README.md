CSB Job Board

Automatically finds and tracks job listings at climate-tech companies — pulled from Pitchbook, enriched with AI, and synced to a Notion database you can search and filter.

**What you get:** A live Notion database of open roles at climate/clean-tech companies, each tagged with job function, seniority, location type, an MBA relevance score (0–100), and a climate relevance flag. New runs update existing records and mark removed jobs.

---

## Prerequisites

- **Pitchbook access** — to export company screenshots
- **Gemini API key** (paid tier) — powers OCR, job classification, and discovery. Get one at [aistudio.google.com](https://aistudio.google.com)
- **Notion account** — two databases: one for Companies, one for Jobs. Run the setup script once to provision them (see Setup below)
- **Node.js 18+** — check with `node --version`

---

## Setup (one time)

**1. Clone and install**
```bash
git clone <repo-url>
cd csb-job-board
npm install
```

**2. Create your `.env.local` file**

Copy the example and fill in your keys:
```bash
cp config.example.json .env.local.example   # if needed
```

Create `.env.local` with:
```
GEMINI_API_KEY=your-key-here
NOTION_API_KEY=your-notion-integration-key
NOTION_COMPANIES_DB_ID=your-companies-db-id
NOTION_JOBS_DB_ID=your-jobs-db-id
```

To get Notion credentials: create an internal integration at [notion.so/my-integrations](https://notion.so/my-integrations), share both databases with it, and copy the database IDs from the page URLs.

**3. Provision Notion databases**
```bash
node src/agents/notion-setup.js
```
This adds all required properties to your Notion databases. Safe to re-run.

---

## Running the pipeline

Each step builds on the previous. Run them in order.

### Step 1 — Import companies from Pitchbook
```bash
npm run ocr -- data/images
```
Put your Pitchbook screenshot(s) in `data/images/` first. The AI reads each image and extracts company names, domains, and funding signals into `data/companies.json`. Add more screenshots any time and re-run to grow the list.

### Step 2 — Find careers pages
```bash
npm run discovery
```
For each company, tries to find its careers page URL. Checks standard paths (`/careers`, `/jobs`), known ATS patterns (Greenhouse, Lever, Ashby, Workday), homepage links, and falls back to AI if needed. Updates `companies.json` with the URL and whether it's reachable.

### Step 3 — Identify job platforms
```bash
npm run fingerprint
```
Detects which applicant tracking system (ATS) each company uses. This lets the next step pull structured data from APIs instead of scraping raw HTML — much more reliable.

### Step 4 — Fetch job listings
```bash
npm run scrape
```
Pulls job listings from each company's careers page. Uses official APIs for Greenhouse, Lever, Ashby, and Workday when available. Falls back to HTML scraping, with a headless browser as a last resort for JavaScript-rendered pages.

### Step 5 — Extract jobs
```bash
npm run extract
```
Parses the raw API responses and HTML into a structured list of jobs saved to `data/jobs.json`.

### Step 6 — Classify and enrich
```bash
npm run enrich
```
The AI classifies each job:
- **Job function** (engineering, product, sales, strategy, etc.)
- **Seniority** (intern → c-suite)
- **Location type** (remote / hybrid / on-site)
- **MBA relevance score** (0–100): 80+ = strategy/biz dev/product leadership; 60–79 = PM/marketing/partnerships; below 40 = primarily technical IC roles
- **Climate relevance** (confirmed true/false with a reason)
- **2–3 sentence summary**

For large job lists, use `--batch-mode` to send 5 jobs per AI call (5x faster, lower cost):
```bash
npm run enrich -- --batch-mode
```

To re-classify jobs that errored on a previous run:
```bash
npm run enrich -- --retry-errors
```

### Step 7 — QA check
```bash
npm run qa
```
Checks for enrichment errors, missing fields, and unusual distributions before syncing. Prints warnings if something looks off.

### Step 8 — Update job status
```bash
node src/agents/temporal.js
```
Marks jobs as active or removed, tracks how long each listing has been live, and flags companies that haven't posted in a while.

### Step 9 — Sync to Notion
```bash
node src/agents/notion-sync.js
```
Upserts all companies and jobs to Notion. Existing records are updated, not duplicated. Use `--dry-run` to preview without writing:
```bash
node src/agents/notion-sync.js --dry-run
```

---

## After a run: observability

```bash
npm run reporter   # generates data/runs/latest.json with per-stage success rates
npm run review     # AI writes a postmortem to data/postmortems/YYYY-MM-DD.md
```

The postmortem identifies which stage had the worst yield, what failed, and suggests one concrete prompt improvement.

---

## Re-running (keeping data fresh)

You don't need to re-run every step each time. Common patterns:

**Add new companies** — drop more Pitchbook screenshots in `data/images/`, then run steps 1 → 2 → 3 → 4 → 5 → 6 → 8 → 9.

**Refresh job listings only** — run steps 4 → 5 → 6 → 8 → 9 (skips OCR and discovery).

**Just re-enrich** — if you update the enrichment prompt or want to re-classify: `npm run enrich -- --force`

---

## Reading results in Notion

**MBA Relevance Score** filters for the most actionable roles:
- 80–100: prioritize — strategy, BD, product leadership, GM, ops leadership
- 60–79: worth reviewing — PM, marketing, partnerships
- Below 40: primarily technical; less typical for MBA recruiting

**Climate Relevance Confirmed** — filter to `true` to exclude companies with no climate/energy connection.

**Days Live** — how long the posting has been open. Useful for prioritizing timely applications.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Missing GEMINI_API_KEY` | Add key to `.env.local`; paid tier required |
| Enrichment errors on many jobs | Run `npm run enrich -- --retry-errors` |
| Notion sync fails with property errors | Re-run `node src/agents/notion-setup.js` |
| Careers page not found for a company | Normal for early-stage companies with no jobs page |
| Scrape returns empty for a company | Company may use CAPTCHA; check `data/scrape_runs.json` for that company |

---

## Data files

```
data/
  companies.json        company list with careers page URLs and ATS info
  jobs.json             enriched job listings
  scrape_runs.json      log of each scrape attempt
  runs/                 per-run summary JSONs + latest.json
  postmortems/          AI-written run postmortems
artifacts/
  html/                 raw scraped content per company (large, gitignored)
src/
  agents/               one file per pipeline step
  prompts/              AI prompt templates (editable to tune classification)
```

---

## Security

Never commit `.env.local`. It contains API keys and is gitignored by default.
