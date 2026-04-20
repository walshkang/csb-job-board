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

## Gate (from [shape-dehallucinate.md](./shape-dehallucinate.md))

**Decision: GO** — The top three coarse buckets alone cover **≥50%** of LLM-eligible HTML artifacts, so implementing DOM-first extraction with LLM fallback is justified.

The long-tail **`other`** bucket (many JS-rendered or non-listing pages) cannot be collapsed without larger DOM/JS investments; those continue to rely on the LLM.

## Implemented adapters

Live under [`src/agents/extraction/html-adapters/`](../src/agents/extraction/html-adapters/):

- **`anchor-job-links`** — Cheerio anchor walk for job-like URLs (full artifact up to 2MB cap; listings often appear below the LLM’s 12k truncation window). Merges **JSON-LD `JobPosting`** blocks when present. Skips bare `/careers`-style landing URLs as standalone “jobs.”
- Base URL normalization: careers/domain strings without `https://` are prefixed so relative links resolve (`normalizeHtmlBaseUrl` in extraction agent).

Non-HTML XML sitemaps saved as `.html` are detected and skipped without calling the LLM.

## Measured LLM avoidance (same artifact set)

Method: iterate validated `data/companies.json`, call `extractCompanyJobs` with a **no-op** `callFn` (no real LLM), using on-disk `artifacts/html/{id}.html`.

**Snapshot:** `htmlAdapterCompanies` ≈ **92**, `htmlLlmCompanies` ≈ **209**, over **301** HTML-only rows (~**30.6%** fewer LLM invocations than an adapter-free run).

This is **below** the stretch acceptance of “≥50% reduction in extract LLM calls,” because a large fraction of artifacts have no stable job URLs in static HTML (SPAs, cookie walls, wrong page captured, etc.). The pipeline still meets the **gate** to ship adapters; the numeric target should be re-checked after scrape quality improvements.

## How to reproduce

```bash
node scripts/audit-html-extract-shapes.js
npm run extract   # prints "HTML adapter companies" and "HTML LLM companies" at the end
```

Optional: `EXTRACTION_ADAPTER_HTML_MAX` caps parsed HTML size (default 2_000_000 chars).
