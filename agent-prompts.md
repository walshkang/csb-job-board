# Worker Agent Prompts

Five independent tasks (A, B, C, D, F) can be fired in parallel.
Task G depends on A completing first.

---

## Agent A — Centralize ATS detection

Refactor ATS platform detection in /Users/walsh.kang/Documents/GitHub/csb-job-board into a shared utility.

Context: URL-based ATS slug extraction is duplicated across three files with diverging logic:
- src/agents/discovery.js (extractGreenhouseToken, extractLeverSlug, etc. — URL-based)
- src/agents/scraper.js (same four functions, lines 92–162 — URL-based, nearly identical)
- src/agents/fingerprinter.js (detectFromHtml — HTML-based, already clean)

Task:
1. Create src/utils/ats-detect.js exporting detectATSFromUrl(url) → { platform, slug } | null
   - Consolidate the four extractor functions from scraper.js (they're the canonical version)
   - platform values: 'greenhouse' | 'lever' | 'ashby' | 'workday' | null
2. Replace the four extractor functions in scraper.js with calls to detectATSFromUrl
3. Replace the equivalent functions in discovery.js with calls to detectATSFromUrl
4. Do not touch fingerprinter.js (HTML-based detection is separate and already clean)
5. No behavior changes — same logic, same outputs, just deduplicated

Run the existing tests to verify nothing breaks: npm test

---

## Agent B — Use cached HTML artifacts in scraper

Eliminate redundant HTTP fetches in /Users/walsh.kang/Documents/GitHub/csb-job-board.

Context: The fingerprinter (src/agents/fingerprinter.js) already fetches and writes:
  artifacts/html/{company_id}.homepage.html
  artifacts/html/{company_id}.careers.html
The scraper (src/agents/scraper.js, scrapeCompany function) then independently re-fetches the same careers URL for direct_html companies, ignoring what fingerprinter already saved.

Task: In scrapeCompany(), before the direct_html fetch path, check if artifacts/html/{company_id}.html or artifacts/html/{company_id}.careers.html already exists and was written recently (within the last 24 hours via mtime). If so, read it from disk instead of making an HTTP request. Still write the result as the canonical {company_id}.html artifact (no change to downstream extraction).

Only apply this to the direct_html provider path — Greenhouse/Lever/Ashby/Workday API paths should still hit their APIs every time.

Do not change fingerprinter.js. Do not change extraction.js.

---

## Agent C — Raise HTML truncation limit for custom sites

Fix silent job loss due to HTML truncation in /Users/walsh.kang/Documents/GitHub/csb-job-board/src/agents/extraction.js.

Context: runExtraction() at line 129 truncates HTML to MAX_HTML_CHARS = 12000 before sending to the LLM. This is fine for ATS JSON paths (Greenhouse, Lever, Ashby, Workday) but loses jobs on custom sites with 30+ listings. The caller extractCompanyJobs() knows which path was used (json vs html artifact).

Task:
1. Raise MAX_HTML_CHARS to 24000
2. When truncation fires (html.length > MAX_HTML_CHARS), log a single stderr line: [extraction] {companyId} HTML truncated {actual}→24000 chars
3. No other behavior changes

---

## Agent D — Add extraction attempt timestamp

Add last_extraction_attempt_at tracking in /Users/walsh.kang/Documents/GitHub/csb-job-board/src/orchestrator.js.

Context: In the extract stage handler (orchestrator.js around line 188), last_extracted_at is only set on success (line 190: c.last_extracted_at = new Date().toISOString()). There's no way to distinguish "never attempted" from "tried and failed 3 times" when looking at a company record.

Task: Set c.last_extraction_attempt_at = new Date().toISOString() at the top of the extract branch in runStage(), before the await extractCompanyJobs call, regardless of outcome. Do not change last_extracted_at behavior.

Also add last_extraction_attempt_at to the data model comment in context.md under "companies.json:" fields.

---

## Agent F — QA summary at pipeline end

Wire QA output into the orchestrator shutdown in /Users/walsh.kang/Documents/GitHub/csb-job-board.

Context: src/agents/qa.js has a standalone run() function that reads companies.json + jobs.json and prints warnings to stderr. It's never called by the orchestrator. The printSummary() function at orchestrator.js line 349 already prints per-stage stats at shutdown.

Task: After the existing printSummary() call in the shutdown() function, call a lightweight inline summary (do NOT import all of qa.js — it has its own main() and file I/O):
- Count jobs with enrichment_error set → log if > 10%
- Count companies with climate_tech_category missing or "None" → log count
- Count jobs total vs enriched (has job_title_normalized) → log coverage %

Read from the in-memory `companies` array and `initialJobs` array already loaded in orchestrator scope — no extra file reads. Print to stderr with a "== qa summary ==" header matching the existing style.

---

## Agent G — Playwright default for discovery (depends on A)

Enable Playwright fallback in discovery by default for SPA shells.

Context: src/agents/discovery.js uses Playwright only when --playwright flag is passed. The scraper (scraper.js) already auto-detects SPA shells via link-density check (fewer than 4 `<a href>` tags on a page >5KB) and triggers Playwright automatically. Discovery should apply the same heuristic so careers URLs found via static scan aren't SPA shells that return no useful links.

Prerequisite: Agent A must be complete (src/utils/ats-detect.js exists).

Task:
1. In the homepage link scan step of discovery.js, apply the same SPA-shell heuristic the scraper uses: if the fetched page is >5KB but has <4 anchor tags, trigger a Playwright fetch instead before scanning for careers links
2. This should fire without any CLI flag — make it the default behavior
3. Reuse fetchRenderedHtml from src/utils/browser.js (already imported in scraper.js)
4. Do not change the --playwright flag behavior (it should remain as a way to force Playwright for the entire discovery run)
