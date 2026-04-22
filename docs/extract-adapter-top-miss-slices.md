# Extraction Adapter Expansion — Top-Miss Bucket Slice Prompts

Prompts for parallel worker agents to complete priority **#1**: improve deterministic extraction coverage for the largest remaining HTML-only miss buckets.

Grounded in current headroom output (2026-04-21):
- HTML-only artifacts: **457**
- Adapter hits: **161** (**35.2%**)
- Misses: **296**
- Highest miss buckets:
  - `other`: **167** (18 high-signal)
  - `wordpress-careers-ish`: **45** (31 high-signal)
  - `webflow-dom`: **42** (13 high-signal)
  - `many-career-path-hrefs`: **36** (35 high-signal)

## Agent level guidance

- **Haiku**: fixture curation, audit harness updates, metric/report slices.
- **Sonnet**: adapter logic and extraction integration with strict safety tests.
- **Opus**: not needed.

## Dependency graph & parallelization

```text
Slice 0 (bucket fixture harness, Haiku) ─┐
                                         ├── Slice 1 (wordpress, Sonnet) ─┐
                                         ├── Slice 2 (webflow, Sonnet) ───┼── Slice 4 (gate + report, Haiku)
                                         └── Slice 3 (many-hrefs/other, Sonnet) ─┘
```

- **Wave A:** Slice 0
- **Wave B (parallel):** Slices 1 + 2 + 3
- **Wave C:** Slice 4

---

## Slice 0 — Top-miss fixture harness (**Haiku**, foundation)

```text
SCOPE
- Build a deterministic fixture set that represents the current top miss buckets:
  wordpress-careers-ish, webflow-dom, many-career-path-hrefs, and a narrow "other-high-signal" subset.
- Add tests/helpers so adapter work can be validated without replaying the full corpus.

FILES IN SCOPE
- test/fixtures/html-adapters/top-miss/ (new fixture files + metadata manifest)
- test/extraction-html-adapter-top-miss-harness.test.js (new)
- scripts/audit-html-extract-adapter-headroom.js (optional: add --fixtures-only mode)

OUT OF SCOPE
- Any adapter extraction logic changes
- orchestrator/scraper behavior changes

DATA CONTRACT
- Manifest JSON shape:
  {
    "fixtures": [
      { "id": "...", "shape": "...", "expected_min_jobs": 0|n, "must_not_match": ["/privacy", ...] }
    ]
  }

TDD (RED -> GREEN)
- Harness test fails when fixture metadata is missing or malformed.
- Harness validates each fixture can be loaded and shape-tagged consistently.

HANDOFF
- Standard agents.md format.
```

---

## Slice 1 — WordPress adapter expansion (**Sonnet**, parallel)

```text
SCOPE
- Improve deterministic extraction for wordpress-careers-ish misses:
  - stronger JobPosting JSON-LD parsing variants
  - WP block/list anchor extraction for explicit openings
  - strict deny-policy for non-job links

FILES IN SCOPE
- src/agents/extraction/html-adapters/anchor-job-links.js
- src/agents/extraction/html-adapters/shared.js
- tests/extraction-html-adapter-wordpress-top-miss.test.js (new)

OUT OF SCOPE
- LLM fallback prompt logic
- scraper/discovery/orchestrator changes

DATA CONTRACT
- Output schema unchanged:
  { job_title, url, location, employment_type, description }
- URL safety unchanged:
  only URLs present in source HTML; deny policy/nav/legal/contact links.

TDD (RED -> GREEN)
- Add failing tests for:
  * WP fixture with explicit openings -> extracts postings
  * WP careers landing with no opening detail -> []
  * deny /privacy /terms /contact and bare /careers links
  * dedupe repeated links/cards

ACCEPTANCE
- `wordpress-careers-ish` miss count decreases in headroom report.

HANDOFF
- Standard agents.md format.
```

---

## Slice 2 — Webflow adapter expansion (**Sonnet**, parallel)

```text
SCOPE
- Improve deterministic extraction for webflow-dom misses:
  - parse CMS collection/listing cards robustly
  - support relative/detail-page links
  - suppress header/footer/nav noise

FILES IN SCOPE
- src/agents/extraction/html-adapters/anchor-job-links.js
- src/agents/extraction/html-adapters/shared.js
- tests/extraction-html-adapter-webflow-top-miss.test.js (new)

OUT OF SCOPE
- browser rendering/scraper changes
- model/config changes

DATA CONTRACT
- Output schema unchanged.
- Preserve no-hallucination URL appearance checks.

TDD (RED -> GREEN)
- Add failing tests for:
  * Webflow fixture with role cards -> extracts explicit posting URLs
  * ignores generic company/resource/about links
  * dedupes repeated card instances

ACCEPTANCE
- `webflow-dom` miss count decreases in headroom report.

HANDOFF
- Standard agents.md format.
```

---

## Slice 3 — Many-hrefs + high-signal "other" extraction pass (**Sonnet**, parallel)

```text
SCOPE
- Recover deterministic coverage from:
  1) `many-career-path-hrefs` pages with dense job-like link clusters
  2) constrained high-signal subset of `other` where >=3 job-like hrefs appear
- Add conservative heuristics only; bias toward precision over recall.

FILES IN SCOPE
- src/agents/extraction/html-adapters/anchor-job-links.js
- src/agents/extraction/html-adapters/shared.js
- tests/extraction-html-adapter-many-hrefs.test.js (new)
- tests/extraction-html-adapter-other-high-signal.test.js (new)

OUT OF SCOPE
- New provider-specific adapters beyond existing extraction architecture
- LLM fallback behavior

DATA CONTRACT
- Output schema unchanged.
- Keep strict URL filtering:
  - must look job-like
  - must appear in source
  - must not match denylist (policy/legal/blog/press/contact/etc)

TDD (RED -> GREEN)
- Add failing tests for:
  * many-career-path-hrefs fixture returns explicit posting URLs
  * high-signal other fixture returns job links only
  * negative fixtures with mixed nav/content return []
  * known false-positive fixture remains negative

ACCEPTANCE
- `many-career-path-hrefs` miss count decreases.
- High-signal portion of `other` shows measurable miss reduction with no new fixture regressions.

HANDOFF
- Standard agents.md format.
```

---

## Slice 4 — Gate + ship report for top-miss push (**Haiku**, depends on 1/2/3)

```text
SCOPE
- Run pre/post comparison for top-miss expansion and produce ship/no-ship decision.
- Capture bucket deltas and false-positive regression status.

FILES IN SCOPE
- scripts/audit-html-extract-adapter-headroom.js (reuse/extend compare mode)
- docs/archive/extract-adapter-top-miss-audit-2026-04-21.md (new report)
- tests/ for any new compare helper logic

OUT OF SCOPE
- Additional adapter coding
- orchestrator pipeline changes

SHIP GATE
- Keep changes only if BOTH:
  1) htmlAdapterCompanies delta >= +40 (vs pre snapshot)
  2) no increased false positives on adapter fixture suite

REPORT CONTENT
- Before/after:
  * totalHtmlOnly, adapterHit, misses, adapterCoveragePct
  * per-shape miss deltas for wordpress-careers-ish, webflow-dom, many-career-path-hrefs, other
  * fixture regression summary
  * final ship/no-ship recommendation

HANDOFF
- Standard agents.md format with gate outcome.
```

---

## How to execute

1. Run **Slice 0** to lock reproducible fixtures for top miss buckets.
2. Run **Slices 1–3 in parallel** (shared file overlap expected; pre-partition by function blocks or serialize final merge).
3. Run **Slice 4** to evaluate gate and decide ship/no-ship.
