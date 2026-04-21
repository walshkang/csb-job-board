# HTML extract shape audit (Slice 5 — gate for DOM adapters)

**Run:** 2026-04-20  
**Artifact root:** `artifacts/html/` (local scrape output; directory is gitignored)  
**Script:** [`scripts/audit-html-extract-shapes.js`](../scripts/audit-html-extract-shapes.js)

## Population

Files counted: canonical `{company_id}.html` where **no** sibling `{company_id}.json` exists. Auxiliary files (`*.playwright.html`, `*.homepage.html`, `*.careers.html`) are excluded.

These files are the only ones that can reach the HTML branch in [`src/agents/extraction.js`](../src/agents/extraction.js) (JSON mappers take precedence when `.json` exists).

## Shape buckets (representative snapshot)

From one full artifact tree on this machine:

| Rank | Shape | Count | Share |
|------|-------|-------|-------|
| 1 | other | 132 | 43.7% |
| 2 | many-career-path-hrefs | 75 | 24.8% |
| 3 | wordpress-careers-ish | 42 | 13.9% |
| 4 | webflow-dom | 39 | 12.9% |
| 5 | shopify | 7 | 2.3% |
| … | (greenhouse / lever / notion / xml sitemap, …) | … | … |

**Total LLM-eligible HTML files:** 302  

**Top 3 shapes cumulative:** 249 / 302 (**82.5%**)

Context and follow-up work (adapter-first extract, LLM fallback flag): [profile-stage-slice.md](./profile-stage-slice.md) (Slice 6b).

## Gate (from [shape-dehallucinate.md](./shape-dehallucinate.md))

**Decision: GO** — The top three coarse buckets alone cover **≥50%** of LLM-eligible HTML artifacts, so implementing DOM-first extraction with LLM fallback is justified.

The long-tail **`other`** bucket (many JS-rendered or non-listing pages) cannot be collapsed without larger DOM/JS investments; those continue to rely on the LLM.

## Implemented adapters

Live under [`src/agents/extraction/html-adapters/`](../src/agents/extraction/html-adapters/):

- **`anchor-job-links`** — Cheerio anchor walk for job-like URLs (full artifact up to 2MB cap; listings often appear below the LLM’s 12k truncation window). Merges **JSON-LD `JobPosting`** blocks when present. Skips bare `/careers`-style landing URLs as standalone “jobs.”
- Base URL normalization: careers/domain strings without `https://` are prefixed so relative links resolve (`normalizeHtmlBaseUrl` in extraction agent).

Non-HTML XML sitemaps saved as `.html` are detected and skipped without calling the LLM.

## Measured extract path (HTML-only, same artifact set)

Method: `node scripts/audit-html-extract-adapter-baseline.js` — iterate validated `data/companies.json`, call `extractCompanyJobs` with a **no-op** `callFn`, using on-disk `artifacts/html/{id}.html` (canonical `.html`, no sibling `.json`).

**Snapshot (2026-04-20, default env — `EXTRACTION_LLM_FALLBACK` unset / off):**

| Metric | Value |
| --- | ---: |
| HTML-only rows | **302** |
| `htmlAdapterCompanies` (adapters returned ≥1 job) | **92** |
| `htmlLlmCompanies` | **0** |
| Adapter success **share of HTML-only artifacts** | **92 / 302 ≈ 30.5%** |
| Remaining rows (no adapter jobs; `adapter_empty`, XML/sitemap, etc.) | **210** |

With fallback **off**, the LLM is not invoked for HTML-only artifacts unless `EXTRACTION_LLM_FALLBACK=1` and the classified shape is `other` (see Slice 6b in [profile-stage-slice.md](./profile-stage-slice.md)).

**Historical comparison (pre–Slice 6b, LLM always eligible after adapters):** `htmlAdapterCompanies` **92**, `htmlLlmCompanies` **209** over **301** HTML-only rows — adapter share of **(adapter + LLM)** ≈ **30.6%**.

Adapter success share of artifacts is still **below** the stretch “≥50%” bar, because many pages have no stable job URLs in static HTML (SPAs, cookie walls, wrong page captured, etc.). The pipeline still meets the **gate** to ship adapters; re-check after scrape quality improvements or broader adapter coverage.

## How to reproduce

```bash
node scripts/audit-html-extract-shapes.js
node scripts/audit-html-extract-adapter-baseline.js
npm run extract   # prints "HTML adapter companies" and "HTML LLM companies" at the end
```

Optional: `EXTRACTION_ADAPTER_HTML_MAX` caps parsed HTML size (default 2_000_000 chars). Set `EXTRACTION_LLM_FALLBACK=1` to allow the LLM for `other`-bucket HTML when adapters return no jobs.
