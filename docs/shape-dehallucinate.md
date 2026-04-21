# Shape Up: De-hallucinate & Tighten the Pipeline

**Status (2026-04-20):**

| Slice | Status | Commit(s) |
|---|---|---|
| 0 — MBA score → tiers | ✅ Shipped | `34be8b7`, `6ce47b6` (prompt regression fix 1.3.1), `b81204e` (strict mapping 1.3.2) |
| 1 — Categorizer keyword pre-pass | ✅ Shipped | `7724eb4` |
| 2 — ATS scrape signature gate | ✅ Shipped | `364444a` |
| 3 — Enrich deterministic pre-pass | 🟡 Pending | — |
| 4 — Kill discovery LLM fallback | ✅ Shipped | `134fba1` |
| 5 — HTML extract adapters | ✅ Shipped (audit justified: top 3 shapes = 82.5%) | `ae4c939` |

**Open work:**
- Full `npm run enrich -- --force` on v1.3.2 to validate prompt fixes across all 388 jobs.
- Slice 3 (deterministic pre-pass for `seniority_level`, `employment_type`, `location_type`).

**Lessons:** Slice 0's prompt rewrite unintentionally weakened the `job_function` and `seniority_level` guidance alongside the MBA change. Caught only after a partial re-enrich showed 83% "other" job_function and 44% null seniority. Fixed in 1.3.1; 1.3.2 added a tiebreaker ladder to enforce mutual exclusivity. **When editing a shared prompt, diff the full file — not just the section you intend to change.**

---

**Appetite:** ~1 day across slices
**Problem:** The pipeline invokes LLMs for work that can be code-driven, which costs money, adds latency, and introduces hallucinations (phantom careers URLs, drifting MBA scores, 0–100 numbers with no real precision). It also lacks a dedup gate — every run re-scrapes and re-enriches companies whose job list hasn't changed.

**Goals:**
1. Remove LLM calls where deterministic code does the job equally well.
2. Add an "already scraped?" gate so recurring runs skip unchanged companies end-to-end.
3. Re-examine Extract and Enrich schemas to see what the LLM actually needs to produce.

**Current state (audit results):**
- Discovery LLM fallback: **3 successful URLs out of 824 companies (0.36%)** — not worth the hallucination risk.
- Categorize: 1 LLM call per company; PitchBook `keywords` field is highly structured and maps cleanly to the fixed taxonomy.
- Enrich: LLM classifies 7 fields; `seniority_level`, `employment_type`, `location_type` are largely regex-resolvable from title/location strings.
- MBA relevance: 0–100 score implies false precision; Notion filters use 4 tiers anyway.
- No dedup: every run re-scrapes + re-extracts + re-enriches every company, even if the job list is identical.

---

## Model tier guidance

Smallest model that works. For this pipeline:

- **Haiku (`claude-haiku-4-5`) / Gemini Flash-Lite** — default for pipeline work. All agents currently run here and should stay here.
- **Sonnet (`claude-sonnet-4-6`) / Gemini Flash** — only if Haiku evals show quality loss on a specific slice. None expected.
- **Opus (`claude-opus-4-7`)** — reserved for one-off shaping/review work (like writing this doc), **not** pipeline agents.

Per-slice agent tier is called out below under **Model tier**. Default is Haiku unless stated.

---

## Slices

### Slice 0 — MBA relevance: score → low/medium/high

**Model tier:** Haiku (unchanged — pipeline agent)
**Parallel with:** 1, 2, 4
**Blocks:** 3 (final enrich schema must be settled first)

**Problem:** 0–100 score implies precision the LLM can't deliver. Notion filters already bucket into tiers (80+, 60–79, 40–59, <40). Same job re-enriched swings ±10 points today.

**What to build:**
1. Rewrite MBA rubric section of `src/prompts/enrichment.txt` to emit `mba_relevance: "low" | "medium" | "high"`. Drop the 4th tier — <40 and 40–59 both mean "skip" in practice.
2. Rename field in `src/agents/enricher.js` (`mba_relevance_score` → `mba_relevance`), bump `ENRICHMENT_PROMPT_VERSION`.
3. Notion schema: change property from Number to Select with 3 options. Update `src/agents/notion-setup.js` and `notion-sync.js`.
4. README: rewrite MBA scoring table into 3 tiers.

**Migration:** `npm run enrich -- --force` re-enriches all jobs. Notion property swap is destructive — dry-run first, confirm backup, then apply.

**Acceptance:**
- New jobs get `low | medium | high` only.
- Notion Jobs DB filter is a Select, not a numeric range.
- No downstream consumer references `mba_relevance_score`.

---

### Slice 1 — Categorizer keyword pre-pass

**Model tier:** Haiku (only on rule-miss)
**Parallel with:** 0, 2, 4
**Blocks:** nothing

**Problem:** 1 LLM call per company (824+ today) to assign a fixed taxonomy category, when PitchBook `keywords` is already normalized and the taxonomy itself is a small JSON file. Most companies should resolve by rule.

**What to build:**
1. In `src/agents/categorizer.js`, at module load, build an inverted index from `data/climate-tech-map-industry-categories.json`: `keyword → [category_id, ...]`.
2. New `resolveByRule(company) → { category, confidence } | null`:
   - Match company's PitchBook keywords (case-insensitive) against the index.
   - If one category wins cleanly (majority of matches), return it with `confidence: "high"`.
   - If two+ categories tie, return `null` (fall through to LLM).
3. Wire before the existing LLM call. LLM only fires on `null` result.
4. Emit telemetry: `{ resolver: "rule" | "llm", category, confidence }` per company.

**Measure:** % resolved by rule; agreement rate vs. current LLM labels on the 824 existing companies (run `--force` with both paths, diff the output).

**Run sequence:**
1. Save a baseline snapshot before rule-first deploy:
   - `cp data/companies.json data/companies.baseline.json`
2. Run categorizer with `--force` after rule-first lands:
   - `npm run categorize -- --force`
3. Save candidate snapshot:
   - `cp data/companies.json data/companies.rule-first.json`
4. Compare baseline vs rule-first:
   - `npm run categorize:compare -- data/companies.baseline.json data/companies.rule-first.json`
   - Report is also saved under `data/runs/categorize-compare-*.json`.

**Acceptance:**
- ≥60% of companies resolve by rule (if lower, the index needs tuning before shipping).
- Rule/LLM agreement ≥90% on the overlap set.
- `--force` run produces deterministic category for rule-resolved companies across re-runs.

---

### Slice 2 — ATS scrape signature gate

**Model tier:** N/A (no LLM)
**Parallel with:** 0, 1, 4
**Blocks:** 3 is cleaner if this lands first (so enricher skip logic already exists)

**Problem:** On recurring runs, most companies have identical job-ID sets from one run to the next. We still re-scrape, re-extract, re-enrich everything. Biggest $ saver.

**Routing rule:** URL tells us the ATS via `ats_platform` (set by fingerprinter in Step 4).
- `ats_platform ∈ {greenhouse, lever, ashby, workday, workable, recruitee, teamtailor, bamboohr}` → gate fires.
- `ats_platform ∈ {null, custom, unknown}` → skip gate, scrape normally. Raw HTML churns on trivial diffs (timestamps, CSRF tokens); signature gating isn't worth it.

**What to build:**
1. After each successful ATS scrape, compute `signature = sha256(sort(normalized_job_urls).join("\n"))`, where each normalized URL is `origin + pathname` (lowercase host/path, strip query/hash, trim trailing slash). Store on `companies.json`: `last_scrape_signature`, `last_scraped_at`.
2. Before scraping an ATS-gated company, fetch the ATS API job-ID list (cheap — one call, no body payloads), compute signature, compare to stored. If equal: short-circuit, stamp `last_seen_at` on existing jobs, skip extract + enrich.
3. Orchestrator: emit `stage: "scrape", outcome: "skipped_signature_match"` event so reporter can count savings.
4. Temporal stage (Step 9) must still run to update `last_seen_at`/`removed_at`.

**Acceptance:**
- Second consecutive run on an unchanged ATS company makes 1 API call (list job IDs), no extract, no enrich.
- Temporal dormancy tracking still works (no false "removed" flags from skipped companies).
- Raw-HTML companies are unaffected.

---

### Slice 3 — Enrich deterministic pre-pass

**Model tier:** Haiku (reduced LLM surface)
**Parallel with:** 4
**Depends on:** 0 (final field set)
**Preferably after:** 2 (gate skip logic already present)

**Problem:** Enrich calls the LLM for 7 fields; three of them are mechanical string matches.

**What to build:**
1. New `resolveDeterministic(job)` in `src/agents/enricher.js`:
   - `seniority_level`: regex on `job_title_raw` — `/\b(intern|internship)\b/i` → `intern`; `/\b(VP|vice president)\b/i` → `vp`; `/\b(director)\b/i` → `director`; `/\b(senior|sr\.?|staff|principal|lead)\b/i` → `senior`; `/\b(junior|jr\.?|associate|entry)\b/i` → `entry`; else `null`.
   - `employment_type`: regex on title + description — `/\bintern(ship)?\b/i` → `intern`; `/\bcontract|contractor|consultant\b/i` → `contract`; `/\bpart[- ]time\b/i` → `part_time`; default `full_time`.
   - `location_type`: regex on `location_raw` — `/\bremote\b/i` → `remote`; `/\bhybrid\b/i` → `hybrid`; non-empty location → `on_site`; else `unknown`.
2. Remove those three fields from `src/prompts/enrichment.txt`. Keep LLM output schema: `{ job_title_normalized, job_function, mba_relevance, climate_relevance_confirmed, climate_relevance_reason }`.
3. `job_function` stays in LLM — too fuzzy for regex. Revisit after measuring.
4. Bump `ENRICHMENT_PROMPT_VERSION` (coordinate with Slice 0 to re-force once, not twice).

**Acceptance:**
- ≥95% of jobs get all three deterministic fields without LLM involvement.
- LLM prompt shrinks by ~40% (token count check).
- Re-enrich of current job set produces same distribution on the three fields (spot-check diff).

---

### Slice 4 — Kill discovery LLM fallback

**Model tier:** N/A (removal)
**Parallel with:** everything
**Blocks:** nothing

**Problem:** LLM guesses careers URLs from name+domain when the 4 code methods fail. Audit shows 3/824 hits (0.36%). The 3 that do work could as easily be hallucinations that happened to 200 on a HEAD check — not worth the confusion.

**What to build:**
1. Delete LLM fallback branch in `src/agents/discovery.js`.
2. Delete `src/prompts/discovery-nohtml.txt`.
3. When all 4 code methods miss, mark `careers_page_discovery_method: "not_found"`, `careers_page_reachable: false`, move on.
4. Remove `discovery.anthropicModel` and related keys from `src/config.js` and README.

**Acceptance:**
- No LLM calls in `discovery.js`.
- 206+ existing `not_found` companies are unaffected; only the 3 `llm_fallback` companies flip to `not_found` (acceptable — the URLs were low-confidence anyway).

---

### Slice 5 (stretch) — Extract HTML adapters

**Model tier:** Haiku (remains as fallback)
**Parallel with:** all, once audit is done
**Gate on:** data audit before committing

**Problem:** Extract calls the LLM on any non-ATS HTML artifact. Many of those are probably a handful of custom-site shapes (Notion-hosted pages, Webflow career sites, generic `<a href*="/job/">` listings). Writing 2–3 small adapters would cut LLM extract calls substantially.

**What to build:**
1. **Audit first:** group `artifacts/html/*.html` files (the ones that currently hit the LLM) by DOM shape. Count hits per shape.
2. If top 2–3 shapes cover ≥50% of HTML extract calls, write small DOM-selector adapters before the LLM fallback. Otherwise: long tail, skip this slice.
3. Adapters live in `src/agents/extraction/` as `html-adapters/*.js`, each exporting `{ match(html, url): boolean, extract(html, url): Job[] }`.
4. LLM stays as the final fallback — don't remove it.

**Acceptance:**
- Audit report exists and justifies the slice (or kills it).
- If built: ≥50% reduction in extract LLM calls on a re-run of current artifacts.

---

## Parallel execution plan

**Wave A (start concurrently):** 0, 1, 2, 4
- 0 and 3 share the enrich prompt; 0 ships first, 3 follows in Wave B so we re-force once.
- 1, 2, 4 touch disjoint files — true parallel.

**Wave B:** 3 (after 0 merges)

**Wave C:** 5 only after data audit justifies it.

**Single re-enrichment run** at end of Wave B: `npm run enrich -- --force` picks up both the MBA tier change (Slice 0) and the schema shrink (Slice 3).

---

## Out of scope

- Replacing OCR with code — vision/PDF layout genuinely needs the LLM.
- Replacing Reviewer — it's a postmortem writer; that's its job.
- Multi-provider expansion — handled in `shape-multi-provider-llm.md`.
- Taxonomy edits — `climate-tech-map-industry-categories.json` is human-reviewed; don't auto-tune it to fit the rule-based categorizer. If rule hit-rate is low, the problem is the matcher, not the taxonomy.
