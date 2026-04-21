# Profile slice baseline — 2026-04-20

Baseline snapshot for the profile-stage slice: stage distribution from `scripts/pipeline-status.js` and discovery telemetry from the most recent orchestrator events file. Use this to compare after shipping slice changes.

## Pipeline status (`node scripts/pipeline-status.js`)

Captured 2026-04-20 (local run).

```
Pipeline status  9:12:58 PM
  companies.json: 13m 16s ago
  ⚠  No save in 13m 16s ago — orchestrator idle or stuck?

Stage breakdown  (total 855)
  discovery     320  ███████████░░░░░░░░░░░░░░░░░░░ 37.4%
  fingerprint     0  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 0.0%
  scrape          0  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 0.0%
  extract        13  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 1.5%
  categorize    231  ████████░░░░░░░░░░░░░░░░░░░░░░ 27.0%
  done          291  ██████████░░░░░░░░░░░░░░░░░░░░ 34.0%

Discovery
  processed:    535/855
  reachable:    329
  unreachable:  206

Jobs in data/jobs.json: 388
```

## Events source

Orchestrator JSONL logs live under **`data/runs/pipeline-events-{run_id}.jsonl`** (not `artifacts/`). Latest retained file by lexicographic sort (same convention as `scripts/pipeline-report.js`):

| Field | Value |
| --- | --- |
| File | `pipeline-events-20260417-101453-nbmm.jsonl` |
| Path | `data/runs/pipeline-events-20260417-101453-nbmm.jsonl` |
| `run_id` | `20260417-101453-nbmm` |

## Discovery events — totals

| Metric | Count |
| --- | ---: |
| Discovery events in file | 191 |
| `outcome: success` | 116 |
| `outcome: no_result` | 75 |
| `outcome: failure` | 0 |

## By `method` (all discovery events)

| `method` | Count |
| --- | ---: |
| `standard_pattern` | 92 |
| `not_found` | 74 |
| `homepage_link_scan` | 14 |
| `ats_slug` | 6 |
| `sitemap` | 4 |
| *(missing)* | 1 |

`not_found` appears as `careers_page_discovery_method` when no careers URL was resolved; it clusters with `no_result` rows below.

## By `failure_class` (discovery only)

| `failure_class` | Count |
| --- | ---: |
| *(any)* | **0** |

`failure_class` is emitted on **`outcome: failure`** (thrown errors after `classifyFailure` in the orchestrator). This run had **no discovery failures**, so the histogram is empty.

For **`no_result`**, the orchestrator records **`reason`** (not `failure_class`). Baseline for those 75 events:

| `reason` | Count |
| --- | ---: |
| `llm_not_found` | 60 |
| `llm_validation_failed` | 11 |
| `llm_homepage` | 3 |
| `not_found` | 1 |

The single `reason: not_found` row is the discovery event with no `method` field (see “missing” row in the method table).

### `no_result` cross-tab: `method` × `reason`

| `method` | `reason` | Count |
| --- | --- | ---: |
| *(missing)* | `not_found` | 1 |
| `not_found` | `llm_not_found` | 60 |
| `not_found` | `llm_validation_failed` | 11 |
| `not_found` | `llm_homepage` | 3 |

---

*Generated to establish a pre-slice baseline for comparing stage tallies and discovery outcome distributions after profile-stage work.*
