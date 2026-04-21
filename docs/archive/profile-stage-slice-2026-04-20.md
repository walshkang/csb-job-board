# Profile stage + extract code-ify (Slice 6)

**Archived:** 2026-04-20 — completed slice documentation.

**Appetite:** ~1 day, two vertical slices  
**Status:** ✅ Slice 6a + 6b shipped (2026-04-20)

## Problem

1. Company description is collected as a side-effect of `fingerprintCompany` (homepage scrape for ATS detection). Description quality is inconsistent, and discovery has no signal about where the careers link lives.
2. Discovery falls back to standard paths / sitemap only — no use of homepage/`about` nav hints, which is where weird-custom-careers-URL companies advertise their careers link.
3. HTML→JSON in extract still calls the LLM for shapes already covered by adapters (see [extract-html-shape-audit-2026-04-20.md](./extract-html-shape-audit-2026-04-20.md)) and for deterministic JSON-LD.

## Goals

1. Add a `profile` stage between OCR and discovery that fetches `/`, `/about`, `/about-us` once, writes `company_profile.description` + `careers_hints[]`.
2. Feed `careers_hints` into discovery as the first candidate list, before standard paths.
3. Strip homepage-scrape-for-description out of fingerprinter — fingerprint does ATS detection only.
4. Promote HTML adapters to primary for extract; LLM becomes fallback for unknown shapes only.

## Non-goals

- No changes to categorize prompt or enrich schema.
- No new ATS detectors.
- No retry logic inside the profile stage — one shot, log + advance.

---

## Slice 6a — Profile stage

### Baseline to capture before coding

> **Prompt 0 (baseline, Haiku):** Run `scripts/pipeline-status.js` and save the current stage tally. Then, on the last run's events file (`artifacts/pipeline-events-*.jsonl`), count discovery outcomes by `method` and `failure_class`. Save to `docs/archive/profile-slice-baseline-YYYY-MM-DD.md`. We need this to prove the slice moves the needle.

### Prompts

> **Prompt 1 (Sonnet):** Add `'profile'` to `STAGES` in `src/utils/pipeline-stages.js` between `discovery` and `fingerprint` — wait, reconsider: `profile` must run **before** `discovery` because discovery consumes its output. Insert at index 0. Update `getStage` so a company advances out of `profile` once `profile_attempted_at` is set. Do not touch any other stage logic.

> **Prompt 2 (Sonnet):** Create `src/agents/profile.js` exporting `profileCompany(company, opts)`. It fetches `company.url`, `company.url + '/about'`, `company.url + '/about-us'` in parallel using the existing `fetchRenderedHtml` helper from `src/utils/browser.js`. Short timeout (5s), static-HTML first, render fallback only if all three return <200 bytes of visible text. Writes:
> - `company.company_profile.description` — first non-empty `<meta name="description">` or first paragraph >80 chars from `/about` > `/about-us` > `/`.
> - `company.careers_hints` — array of `{url, text, location}` where `location ∈ 'header'|'footer'|'nav'|'body'`, pulled from anchors whose href or text matches `/careers?|jobs?|join[- ]us|work[- ]with[- ]us|hiring|open[- ]roles/i`. Dedupe by resolved absolute URL.
> - `company.profile_attempted_at` (ISO timestamp).
> Do not overwrite an existing non-empty description.

> **Prompt 3 (Sonnet):** Wire the stage into `src/orchestrator.js`: add `profile` to `CONCURRENCIES` (start at 6), add a `runStage` branch that calls `profileCompany` and returns `success` if a description OR ≥1 hint was found, else `no_result`. `no_result` should still advance (profile is best-effort, like fingerprint).

> **Prompt 4 (Sonnet):** In `src/agents/discovery.js`, before the `STANDARD_PATHS` loop, try each URL in `company.careers_hints` (already absolute). On success, set `careers_page_discovery_method = 'profile_hint'` and record which hint location matched so we can audit later.

> **Prompt 5 (Sonnet):** Strip the homepage-scrape-for-description block from `src/agents/fingerprinter.js` (lines ~185-243 per current HEAD — verify by reading). Fingerprinter keeps ATS detection only. `company_profile.scraped_description` reads are replaced by `company_profile.description` in callers: check `src/agents/categorizer.js:157`, `src/orchestrator.js:213`, and `src/agents/notion-sync.js:235-238`. Pick ONE field name — prefer `description` — and update all references in a single pass.

> **Prompt 6 (Sonnet):** Backfill script: `scripts/backfill-profile.js` iterates `data/companies.json` where `profile_attempted_at` is blank, runs `profileCompany` at concurrency 6, saves every 20 companies atomically. Dry-run flag required.

### Validation

> **Prompt 7 (Haiku):** On 20 sampled companies (`--limit 20 --stages profile,discovery`), compare discovery success rate and method mix against Prompt 0's baseline. Update `docs/archive/profile-stage-slice-2026-04-20.md` with the numbers under a new `## Results` section. Ship only if `profile_hint` is non-trivial OR description quality on spot-check beats the old `scraped_description`.

---

## Results

**Captured:** 2026-04-20 (local).

### Protocol

- Command: `npm run pipeline -- --limit 20 --stages profile,discovery` (first 20 rows in `data/companies.json`).
- To exercise **both** stages after the profile stage landed, profile and discovery fields were cleared for those 20 rows (including `profile_attempted_at`, prior discovery outputs, and `company_profile.description` so profile could refill).
- **Orchestrator note:** On the first run, only **12** discovery events were written before shutdown while **8** companies were still between profile completion and discovery (`data/runs/pipeline-events-20260420-211855-fw18.jsonl`). A second pass completed the remaining discovery attempts (`pipeline-events-20260420-211909-f9mw.jsonl`). Totals below use the **combined outcome** for all 20 companies (final per-company state before restoring `companies.json` from backup).

### Prompt 0 baseline (see [profile-slice-baseline-2026-04-20.md](./profile-slice-baseline-2026-04-20.md))

| Metric | Baseline (historical JSONL) |
| --- | ---: |
| Discovery lines in file | 191 |
| `outcome: success` | 116 (**60.7%** of discovery lines) |
| `outcome: no_result` | 75 (**39.3%**) |
| `outcome: failure` | 0 |

**Method mix (all discovery lines, n=191)**

| `method` | Count | Share |
| --- | ---: | ---: |
| `standard_pattern` | 92 | 48.2% |
| `not_found` | 74 | 38.7% |
| `homepage_link_scan` | 14 | 7.3% |
| `ats_slug` | 6 | 3.1% |
| `sitemap` | 4 | 2.1% |
| *(missing)* | 1 | 0.5% |

### Prompt 7 sample (n=20)

| Metric | This run |
| --- | ---: |
| Careers page **reachable** | **13 / 20 (65.0%)** |
| **Unreachable / not found** | **7 / 20 (35.0%)** |

**Method mix (n=20, one row per company)**

| `careers_page_discovery_method` | Count | Share |
| --- | ---: | ---: |
| `profile_hint` | 12 | **60.0%** |
| `not_found` | 7 | 35.0% |
| `standard_pattern` | 1 | 5.0% |

`profile_hint` did not exist in the Prompt 0 taxonomy; in this sample it accounts for **12 of 13** successful discoveries (**92%** of successes).

### Description spot-check (vs `company_profile.scraped_description` before reset)

Compared backup `scraped_description` to post-profile `description` for the same 20 rows: many companies previously had **no** scraped blurb; profile often filled from `/about` or meta description (e.g. Vaire, Biomass Controls, Sedron). Mixed quality elsewhere: some new blurbs are cleaner than careers-page scrapes (e.g. Avalanche, Heat2Power); some are weaker or wrong (e.g. TeraWatt meta empty while old scrape had text; Flex description reads like a generic moving company—likely domain/content collision). Net: not uniformly better than `scraped_description`, but profile adds signal where fingerprint never wrote a blurb.

### Ship gate (Prompt 7)

- **`profile_hint`:** **12 / 20** companies resolved the careers URL via `profile_hint` — **non-trivial** and satisfies the ship criterion on that branch.
- **Spot-check:** Descriptions are improved in several cases but not universally; not required for ship given the `profile_hint` result.

**Recommendation:** **Ship** Slice 6a from a discovery-metrics perspective; follow up on orchestrator idle ordering so a single `--stages profile,discovery` pass always emits 20 discovery events, and on description sourcing edge cases (wrong-site meta, empty meta).

---

## Slice 6b — Extract: LLM → code (gated on 6a)

### Prompts

> **Prompt 8 (Haiku):** Audit current extract call volume. On the latest events file, count extract outcomes where `htmlAdapterCompanies` handled it vs LLM. Today's baseline is ~30.6% adapter share over 301 HTML-only rows (see [extract-html-shape-audit-2026-04-20.md](./extract-html-shape-audit-2026-04-20.md)). Save current numbers.

> **Prompt 9 (Opus):** In `src/agents/extraction.js`, change the control flow so HTML adapters are tried first, and the LLM call is only invoked when every adapter returns zero jobs AND the shape bucket is `other`. Don't delete the LLM path — gate it behind `EXTRACTION_LLM_FALLBACK=1` (default off). Failed-adapter-known-shape rows become `no_result` with `extract_failure_reason = 'adapter_empty'`.

> **Prompt 10 (Sonnet):** Extend adapters to cover the next long-tail shapes surfaced in the audit (Shopify, Greenhouse, Lever, Notion) as pure Cheerio functions under `src/agents/extraction/html-adapters/`. Add one adapter per commit.

> **Prompt 11 (Haiku):** Run `npm run extract` on the full artifact tree with LLM fallback OFF. Expected: adapter share >70%, remainder logged as `no_result: adapter_empty`. File a follow-up if >20% of `other`-bucket pages look like legitimate listings the adapters missed.

### Validation

> **Prompt 12 (Haiku):** Update [extract-html-shape-audit-2026-04-20.md](./extract-html-shape-audit-2026-04-20.md) with the new coverage numbers and link this doc from it.

---

## Rollback

- Slice 6a: revert the `profile` insertion in `pipeline-stages.js` + the orchestrator branch; fingerprinter still reads the old field if we keep the rename behind an alias for one release.
- Slice 6b: `EXTRACTION_LLM_FALLBACK=1` restores the previous behavior without a code change.

## Open questions

- Should `profile` run on every pipeline invocation or cache for N days? Default: cache by `profile_attempted_at`, re-run when older than 90 days.
- Does `careers_hints` belong on the company or as a separate artifact? Default: inline on company; it's small (<1KB typical) and colocates with discovery inputs.
