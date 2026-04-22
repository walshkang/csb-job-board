# Cold vs Warm Lanes — Slice Prompts

Slices for splitting the pipeline into two explicit flows: **cold lane** (net-new companies from PitchBook OCR, full research funnel) and **warm lane** (already in `companies.json`, just diff the known careers page). Mirrored on the jobs side as a tri-state per scrape: **existing / net-new / removed**.

Run **after** `docs/archive/pipeline-improvements-slices-2026-04-21.md` lands. Each slice is self-contained, TDD-driven (red → green), and follows the agents.md handoff protocol.

## Framing

Today `getStage()` routes every company through the same funnel based on field completeness. That implicitly handles "already-done" but conflates two very different jobs-to-be-done:

- **Cold lane**: full profile → discovery → fingerprint → scrape → extract → enrich → categorize. Research-heavy, LLM-heavy.
- **Warm lane**: careers URL, ATS platform, category already known. Only question is *what's new, what's gone, what's still there* on a known page. Should be mostly code, minimal LLM.

The schema already has `first_seen_at`, `last_seen_at`, `removed_at`, `days_live` — but `removed_at` is barely wired, and extract+enrich re-run indiscriminately on pages that didn't change. Making the lane a first-class tag lets telemetry, prompts, and scripts become legible (and cheaper).

## Dependency graph & parallelization

```
Slice A (lane tagging + router) ─┐
                                  ├── Slice B (scrape→diff tri-state jobs) ─┐
                                  │                                          ├── Slice C (warm extraction prompt)
                                  └── Slice D (lane-aware telemetry)─────────┘
Slice E (cold-batch seeding) ── standalone, any time
```

- **Wave 1:** Slice A solo (foundation, touches orchestrator + stages util).
- **Wave 2 (parallel):** B + D (different files).
- **Wave 3:** C (depends on B's URL-set contract).
- **Anytime:** E (seeding script, doesn't touch hot path).

All **Sonnet** except E (**Haiku**). No Opus — scoped refactors and prompt work, not open-ended research.

---

## Slice A — Lane tagging + router (Sonnet, foundation)

```
SCOPE
- Classify each company as 'cold' or 'warm' at the start of an orchestrator run.
- Thread `lane` through pipeline events so every downstream slice can branch on it.
- No behavior change yet — warm lane still runs every stage. This slice only makes
  the lane visible and testable.

FILES IN SCOPE
- src/utils/pipeline-stages.js (add classifyLane + tests)
- src/orchestrator.js (tag company object with lane; include in events)
- src/utils/pipeline-events.js (accept/pass-through `lane` field on events)
- tests/

OUT OF SCOPE
- Any stage gating based on lane (later slices)
- UI changes (Slice D)
- Prompt changes (Slice C)

DATA CONTRACT

// src/utils/pipeline-stages.js
function classifyLane(company) // returns 'cold' | 'warm'
  // cold: profile_attempted_at is blank (never been through intake)
  // warm: otherwise

Event payload: every { company_id, stage, outcome, ... } event gains
`lane: 'cold' | 'warm'`.

TDD (RED → GREEN)
- tests/classify-lane.test.js
  * {} → 'cold'
  * { profile_attempted_at: null } → 'cold'
  * { profile_attempted_at: '2026-01-01...' } → 'warm'
- tests/orchestrator-lane-events.test.js
  * Event emitted for a freshly-ingested PB company has lane='cold'
  * Event emitted for a company with profile_attempted_at set has lane='warm'

HANDOFF: standard agents.md format.
```

---

## Slice B — Scrape-diff tri-state jobs (Sonnet, depends on A)

```
SCOPE
- After a warm-lane scrape, diff the current job-URL set against last-known URLs
  to classify each job as existing | net_new | removed.
- Set removed_at on disappeared jobs; skip extract+enrich when zero net_new AND
  no existing-job description_hash changes.
- Cold lane: everything is net_new by definition — no diff needed, but still tag.

FILES IN SCOPE
- src/agents/scraper.js (emit { job_urls: [...] } in scrape result)
- src/agents/extraction.js (consume prior-URL set; mark removed jobs)
- src/orchestrator.js (compute diff between artifacts snapshot and prior jobs.json
  slice for that company_id before enqueuing extract)
- tests/

OUT OF SCOPE
- Warm-specific extraction prompt (Slice C)
- Any UI surfacing (Slice D)

DATA CONTRACT

// scrape result (extended)
{ outcome, method, status_code, body_size_kb,
  job_urls: string[]  // deduped, canonicalized URLs visible on the current page
}

// orchestrator derives:
{ existing_ids: Set, net_new_urls: Set, removed_ids: Set }

// jobs.json semantics
- existing: last_seen_at = now
- net_new: full extract+enrich path
- removed: removed_at = now (only if currently null); days_live = removed_at - first_seen_at

RULES
- If lane='warm' AND net_new_urls is empty AND no description_hash churn →
  emit outcome='skipped' with reason='no_delta', skip extract+enrich stages for
  this company.
- If lane='cold' → existing_ids is always empty; no removal pass.
- Removal pass never runs on scrape failure (don't mark jobs removed because we
  couldn't reach the page).

TDD (RED → GREEN)
- tests/scrape-diff.test.js
  * Given prior URLs {A,B,C} and current {B,C,D} → existing={B,C}, net_new={D}, removed={A}
  * Scrape outcome='failure' → no removal classification
- tests/extraction-removed-at.test.js
  * Job present in prior, absent in current, scrape succeeded → removed_at set
  * Job previously marked removed and reappears → removed_at cleared, last_seen_at bumped
- tests/orchestrator-no-delta-short-circuit.test.js
  * Warm company, empty net_new, same hashes → extract+enrich events outcome='skipped'/reason='no_delta'
  * Cold company → always runs extract

HANDOFF: standard.
```

---

## Slice C — Warm-lane extraction prompt (Sonnet, depends on B)

```
SCOPE
- Add a narrower extraction prompt for warm-lane LLM fallback that takes the
  existing-URL set as context and returns ONLY deltas.
- Adapter path is unchanged (adapters are deterministic; they list everything
  and the orchestrator diffs).
- Cold lane continues to use existing extraction.txt.

FILES IN SCOPE
- src/prompts/extraction-warm.txt (new)
- src/agents/extraction.js (select prompt based on lane + presence of existing-URL set)
- tests/

OUT OF SCOPE
- Changing cold-lane prompt
- Changing adapter logic

DATA CONTRACT
extractCompanyJobs(company, html, { lane, existingJobUrls }) → jobs[]

PROMPT DESIGN (extraction-warm.txt)
- Given: careers page HTML + JSON array of existing canonical job URLs we've
  already extracted in prior runs.
- Task: return ONLY jobs whose source_url is NOT in the existing set, OR
  whose title/description has materially changed.
- Output contract identical to extraction.txt so downstream is unchanged.

TDD (RED → GREEN)
- tests/extraction-warm-prompt-select.test.js
  * lane='warm' with existingJobUrls → uses extraction-warm.txt
  * lane='cold' → uses extraction.txt
  * lane='warm' but existingJobUrls is empty → falls back to extraction.txt
- Live prompt test (fixture HTML + stubbed LLM returning mock deltas) verifies
  delta-only parsing works.

IMPLEMENTATION NOTES
- Do NOT rely on the warm prompt for removal detection — the orchestrator URL
  diff (Slice B) owns that. Warm prompt is only for "what's new, what changed".
- Token-savings log to stderr: prompt tokens with vs without existing-URL context.

HANDOFF: standard.
```

---

## Slice D — Lane-aware telemetry + reporter (Sonnet, parallel with B)

```
SCOPE
- Split snapshot counters by lane in the admin UI.
- Reporter output shows: new_companies_onboarded, companies_refreshed,
  jobs_net_new, jobs_removed, jobs_unchanged — per run.

FILES IN SCOPE
- src/orchestrator.js (snapshot payload: stats_by_lane)
- admin/public/index.html (render split)
- src/agents/reporter.js (new summary fields)
- tests/

OUT OF SCOPE
- Alerting, thresholds, any logic gating on the numbers

DATA CONTRACT

snapshot.stats_by_lane = {
  cold: { started, completed, failed, skipped, ... per stage },
  warm: { ... }
}

report.summary.jobs = { net_new, existing, removed }
report.summary.companies = { cold_onboarded, warm_refreshed }

TDD
- tests/snapshot-lane-split.test.js
  * Mixed cold+warm run → counters partition correctly
- tests/reporter-jobs-tristate.test.js
  * Summary reflects net_new/existing/removed from the run's events

HANDOFF: standard.
```

---

## Slice E — Cold-batch seeding script (Haiku, standalone)

```
SCOPE
- A script that takes the output of a fresh OCR run and stamps companies with
  a cohort tag so cold-batch runs are auditable over time.

FILES IN SCOPE
- scripts/seed-cold-batch.js (new)
- tests/

CONTRACT
- Reads data/companies.json
- For companies with profile_attempted_at blank, sets
  cold_batch_id = `pb_${yyyy-mm-dd}` (or flag-provided label)
- Idempotent: re-running with same label is a no-op

TDD
- tests/seed-cold-batch.test.js
  * Blank profile_attempted_at + no cold_batch_id → tagged
  * Already tagged → untouched
  * profile_attempted_at set → untouched (they're warm now)

HANDOFF: standard.
```

---

## How to execute

1. **Wave 1 — Slice A** (1 agent, Sonnet). Lane is a prerequisite for everything else and touches the shared stages util.
2. **Wave 2 — Slices B + D in parallel** (2 agents, Sonnet). Different files; D is reporting-only so merge risk is low.
3. **Wave 3 — Slice C** (1 agent, Sonnet). Needs B's `existingJobUrls` wiring.
4. **Anytime — Slice E** (1 agent, Haiku). Can land before Wave 1 if you want the cohort tag applied retroactively.
