# Extraction Adapter Expansion — Lanes/Slices Prompts

Slices for deciding and implementing **3–4 new deterministic HTML adapters** before LLM fallback in extraction.

Grounded in current local artifact audit (2026-04-21):
- HTML-only artifacts: **457**
- Adapter hits: **147** (**32.2%**)
- Misses: **310**
- High-signal misses concentrated in:
  - `wordpress-careers-ish`: 45 (31 with >=3 job-like hrefs)
  - `webflow-dom`: 41 (13 with >=3 job-like hrefs)
  - `many-career-path-hrefs`: 37 (36 with >=3 job-like hrefs)

Potential recoverable headroom from those three buckets is ~**80** pages, taking adapter coverage from ~**32%** to ~**50%**.

## Agent level guidance

- **Haiku**: instrumentation, metrics, and scoped audit scripts.
- **Sonnet**: adapter implementations + extraction integration + nuanced tests.
- **Opus**: not needed for these slices.

## Dependency graph & parallelization

```text
Slice 0 (baseline harness, Haiku) ─┐
                                   ├── Slice 1 (Wix adapter, Sonnet) ─┐
                                   ├── Slice 2 (WordPress adapter, Sonnet) ─┼── Slice 4 (report + gate, Haiku)
                                   └── Slice 3 (Webflow adapter, Sonnet) ─┘
```

- **Wave A:** Slice 0
- **Wave B (parallel):** Slices 1 + 2 + 3
- **Wave C:** Slice 4

---

## Slice 0 — Baseline + adapter ROI harness (**Haiku**, foundation)

```text
SCOPE
- Add a reproducible script that reports:
  1) total HTML-only artifacts
  2) current adapter hits/misses
  3) misses by shape
  4) high-signal misses by shape (>=3 job-like hrefs)
- This is a metrics-only slice. No extraction behavior changes.

FILES IN SCOPE
- scripts/audit-html-extract-adapter-headroom.js (new)
- package.json (optional script entry)
- tests/ (new)

OUT OF SCOPE
- Any adapter logic changes
- orchestrator/extraction runtime behavior

DATA CONTRACT
- Script prints JSON:
  {
    totalHtmlOnly,
    adapterHit,
    misses,
    adapterCoveragePct,
    byShape: [{ shape, count, pctOfMisses, highSignalCount }]
  }

TDD (RED -> GREEN)
- tests/audit-adapter-headroom.test.js
  * fixture set with synthetic artifacts validates totals and shape bucketing
  * validates highSignalCount uses >=3 threshold

HANDOFF
- Standard agents.md format.
```

---

## Slice 1 — Wix static job extraction adapter (**Sonnet**, parallel)

```text
SCOPE
- Add deterministic extraction for Wix-rendered careers pages where jobs are present
  in static JSON/script blobs or anchor lists not captured by existing adapters.
- Integrate as a dedicated adapter before generic anchor-job-links.

FILES IN SCOPE
- src/agents/extraction/html-adapters/wix.js (new)
- src/agents/extraction/html-adapters/index.js
- src/agents/extraction/html-adapters/shared.js (only if tiny shared helper needed)
- tests/ (new)

OUT OF SCOPE
- LLM fallback behavior changes
- scraper/discovery/orchestrator changes

DATA CONTRACT
- Adapter module exports:
  { name, match(html, baseUrl), extract(html, baseUrl) }
- Output item schema unchanged:
  { job_title, url, location, employment_type, description }

TDD (RED -> GREEN)
- tests/extraction-html-adapter-wix.test.js
  * detects Wix pages via known fingerprints
  * extracts only explicit posting URLs (no bare /careers landing links)
  * dedupes by canonical URL
  * returns [] when only marketing links exist

ACCEPTANCE
- Adapter increases htmlAdapterCompanies on a replay audit run.

HANDOFF
- Standard agents.md format.
```

---

## Slice 2 — WordPress careers-page adapter improvements (**Sonnet**, parallel)

```text
SCOPE
- Improve deterministic extraction on wordpress-careers-ish pages:
  - parse JobPosting JSON-LD more robustly
  - collect job links from common WP block/list patterns
  - keep strict URL validation and deny non-job policy/nav pages

FILES IN SCOPE
- src/agents/extraction/html-adapters/anchor-job-links.js
- src/agents/extraction/html-adapters/shared.js
- tests/ (new)

OUT OF SCOPE
- New LLM prompt logic
- changes to non-HTML extraction paths

DATA CONTRACT
- No schema changes.
- Maintain existing behavior:
  - no hallucinated URLs
  - no synthetic descriptions

TDD (RED -> GREEN)
- tests/extraction-html-adapter-wordpress.test.js
  * fixture with WP careers page and explicit openings -> extracts postings
  * fixture with WP careers landing page and no openings -> []
  * denies /privacy, /terms, /contact, bare /careers links

ACCEPTANCE
- Miss count for wordpress-careers-ish decreases in headroom script output.

HANDOFF
- Standard agents.md format.
```

---

## Slice 3 — Webflow careers adapter improvements (**Sonnet**, parallel)

```text
SCOPE
- Improve deterministic extraction on webflow-dom pages:
  - parse CMS list/card links for job-like targets
  - support relative links and section-anchored listings
  - avoid header/footer/nav link pollution

FILES IN SCOPE
- src/agents/extraction/html-adapters/anchor-job-links.js
- src/agents/extraction/html-adapters/shared.js
- tests/ (new)

OUT OF SCOPE
- scraper-side rendering changes
- model/config changes

DATA CONTRACT
- Output schema unchanged.
- Keep URL appearance validation in source HTML.

TDD (RED -> GREEN)
- tests/extraction-html-adapter-webflow.test.js
  * webflow fixture with role cards -> extracts posting URLs
  * ignores generic company/about/resource links
  * dedupes repeated cards/links

ACCEPTANCE
- Miss count for webflow-dom decreases in headroom script output.

HANDOFF
- Standard agents.md format.
```

---

## Slice 4 — Outcome report + ship/no-ship gate (**Haiku**, depends on 1/2/3)

```text
SCOPE
- Produce a post-change audit summary that compares pre/post adapter performance.
- Add a clear gate for whether to keep the new adapters.

FILES IN SCOPE
- scripts/audit-html-extract-adapter-headroom.js (reuse/extend)
- docs/archive/extract-adapter-expansion-audit-2026-04-21.md (new report)

OUT OF SCOPE
- Additional adapter coding
- orchestrator logic changes

SHIP GATE
- Keep changes if BOTH:
  1) htmlAdapterCompanies improves by >= 40 pages (absolute)
  2) no increase in known false positives on test fixtures

TDD
- tests for any new compare/report helper functions

HANDOFF
- Standard agents.md format, including before/after metrics.
```

---

## How to execute

1. Run **Slice 0** first to lock baseline metrics.
2. Run **Slices 1–3 in parallel** (different files, minimal overlap risk).
3. Run **Slice 4** to compare metrics and decide ship/no-ship.
4. If gate passes, keep LLM fallback unchanged but expect fewer HTML LLM calls.
