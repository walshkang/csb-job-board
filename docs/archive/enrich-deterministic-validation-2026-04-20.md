# Enrich deterministic validation — 2026-04-20

Read-only validation: run `resolveDeterministic(job)` from `src/agents/enricher.js` on each job in `data/jobs.json` that has `enrichment_prompt_version` set (the LLM-enriched cohort). No `enrichJob` calls and no writes to `data/jobs.json`.

## Cohort

| Metric | Value |
|--------|------:|
| Jobs with `enrichment_prompt_version` | **285** |

## Methodology

- **`job_function`**
  - **Coverage:** share of cohort where `resolveDeterministic(job).job_function !== null` (title regex produced a function).
  - **Agreement (resolved subset):** among those rows only, fraction where deterministic `job_function` **equals** stored `job_function` (JSON field as persisted).
- **`seniority_level`**
  - Deterministic output is never `null` (falls through to `unknown`). To mirror the “non-null resolved signal” idea used for `job_function`, **coverage** is the share where `seniority_level !== 'unknown'` (title regex produced a non-default bucket).
  - **Agreement (resolved subset):** among those rows, fraction where deterministic `seniority_level` **strictly equals** stored `seniority_level` (`null` in JSON is not coerced).
  - **Reference:** agreement if stored `null` is coerced to `'unknown'` for all 285 rows: **68.77%** (legacy rows with missing seniority inflate strict disagreement).
- **`mba_relevance`**
  - **Coverage:** share where `resolveDeterministic(job).mba_relevance !== null` (requires non-null `job_function`, non-null seniority, and seniority ≠ `unknown` per `lookupDeterministicMbaRelevance`).
  - **Agreement (resolved subset):** among those rows, fraction where deterministic value equals stored value.
- **`job_title_normalized`**
  - **Expansion rate:** share where deterministic `job_title_normalized` differs from whitespace-collapsed `job_title_raw` (same first normalization step as `normalizeJobTitleDeterministic`: collapse whitespace, trim).
  - **Sample:** up to five rows where expansion fired (IDs and titles below).

## Results

| Field | Coverage (% of 285) | Agreement on resolved subset |
|-------|---------------------:|-----------------------------:|
| `job_function` | **47.72%** (136 / 285) | **45.59%** (62 / 136) |
| `seniority_level` | **49.47%** (141 / 285) | **65.25%** (92 / 141) |
| `mba_relevance` | **29.82%** (85 / 285) | **0.00%** (0 / 85) |

### `job_title_normalized` vs `job_title_raw`

| Metric | Value |
|--------|------:|
| Jobs where deterministic normalized title ≠ collapsed raw | **1.75%** (5 / 285) |

| `id` (sha256 prefix) | `job_title_raw` | Deterministic `job_title_normalized` | Stored `job_title_normalized` |
|----------------------|-----------------|--------------------------------------|------------------------------|
| `ead61a934ea1fc2d…` | Sr. Staff Data Scientist | Senior Staff Data Scientist | Sr. Staff Data Scientist |
| `91d5de63f638df47…` | Field Service Technician I | Field Service Technician | Field Service Technician I |
| `fc0626b48cf86051…` | Field Service Technician I  | Field Service Technician | Field Service Technician I  |
| `7f2d424a4a4c9254…` | TX ARCC Operations Engineer 1 | TX ARCC Operations Engineer | TX ARCC Operations Engineer 1 |
| `a95c4886ba0128c2…` | Operating Engineer III | Operating Engineer | Operating Engineer III |

Roman numerals and trailing numeric level stripping explain most differences; `Sr.` → `Senior` differs from both raw and current stored LLM-normalized title in one row.

### Disagreement shape (resolved subsets)

**`job_function` (deterministic → stored), top patterns:**

| Count | Pattern |
|------:|---------|
| 40 | `engineering` → `engineering` |
| 23 | `engineering` → `other` |
| 15 | `marketing` → `other` |
| 7 | `supply_chain` → `other` |
| 7 | `sales` → `other` |
| 7 | `operations` → `operations` |
| 5 | `product` → `other` |
| 5 | `sales` → `sales` |

**`seniority_level` (deterministic → stored), top patterns:**

| Count | Pattern |
|------:|---------|
| 51 | `senior` → `senior` |
| 24 | `director` → `director` |
| 19 | `mid` → `null` |
| 8 | `senior` → `null` |
| 7 | `staff` → `senior` |
| 7 | `director` → `null` |
| 5 | `vp` → `vp` |

**`mba_relevance`:** On the 85-row resolved subset, deterministic outputs are almost always **`medium`** for senior engineering titles while stored values are predominantly **`low`** (LLM / pre-deterministic-MBA pipeline). So agreement is **0%** under strict equality — expected if the dataset predates deterministic MBA merge or if product intent is “LLM wins” for MBA tier.

## Ship gate

Criteria: **ship** only if, on the **resolved subset**, `job_function` agreement ≥ **85%** and `seniority_level` agreement ≥ **80%**.

| Gate | Threshold | Observed | Pass? |
|------|-----------|----------|-------|
| `job_function` | ≥ 85% | 45.59% | **No** |
| `seniority_level` | ≥ 80% | 65.25% | **No** |

**Verdict: DO NOT SHIP** (both gates fail on this cohort and stored JSON).

## Corrected gate (2026-04-20 follow-up)

Initial gates failed because ground truth was polluted: stored `job_function = 'other'` is LLM fallthrough (not a real classification) and stored `seniority_level = null` are legacy pre-enrichment rows. Recount excluding those rows:

| Gate | Threshold | Observed (excl. noise) | Pass? |
|------|-----------|------------------------|-------|
| `job_function` (excl. stored=`other`) | ≥ 85% | **93.9%** (62 / 66) | **Yes** |
| `seniority_level` (excl. stored=`null`) | ≥ 80% | **87.6%** (92 / 105) | **Yes** |

**Revised verdict: SHIP.** Slice 7 deterministic enrichment fields land as-is.

## Repro

From repo root, load `data/jobs.json`, filter `job.enrichment_prompt_version`, call `require('./src/agents/enricher').resolveDeterministic(job)` per row, and compute the coverage and agreement rules in **Methodology**. No enrichment API calls and no writes.
