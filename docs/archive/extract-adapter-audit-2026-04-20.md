# Extract adapter vs LLM audit — 2026-04-20

Snapshot for **Prompt 8** (extract call volume: adapter path vs LLM). Compare with [extract-html-shape-audit.md](../extract-html-shape-audit.md).

## Instrumentation

Orchestrator extract outcomes now include:

- `html_extract_path`: `json` \| `adapter` \| `llm` \| `xml_or_sitemap` \| omitted when extract did not run a classified path
- `html_adapter_name`: present when `html_extract_path === 'adapter'` (e.g. `anchor-job-links`)

Implemented in [`src/agents/extraction.js`](../../src/agents/extraction.js) (return value) and [`src/orchestrator.js`](../../src/orchestrator.js) (pipeline event `extra`).

## Baseline parity (HTML-only, no-op LLM)

Script: `node scripts/audit-html-extract-adapter-baseline.js`

Population: validated `data/companies.json` rows with `artifacts/html/{id}.html` and **no** sibling `{id}.json`. Uses `extractCompanyJobs` with a no-op `callFn` so the LLM is never invoked; counters match the historical audit methodology.

| Metric | Value (this run) |
| --- | ---: |
| HTML-only rows | 302 |
| `htmlAdapterCompanies` | 92 |
| `htmlLlmCompanies` | 209 |
| Adapter share of (adapter + LLM) | **30.6%** |

The prior doc snapshot used **301** HTML-only rows (~30.6% share); the extra row reflects artifact churn. The ratio matches the earlier measurement.

## Pipeline events (latest JSONL)

Script: `node scripts/audit-extract-adapter-from-events.js`

Latest file by sort order (same as [`scripts/pipeline-report.js`](../../scripts/pipeline-report.js)): `data/runs/pipeline-events-20260420-211909-f9mw.jsonl`.

| Metric | Value |
| --- | ---: |
| Extract-stage events in that file | 0 |

That run did not record extract-stage attempts, so there is nothing to tally for adapter vs LLM from events yet. After a full pipeline pass that reaches extract, re-run the script; rows **without** `html_extract_path` are labeled as emitted before this instrumentation.

## Reproduction

```bash
node scripts/audit-html-extract-adapter-baseline.js
node scripts/audit-extract-adapter-from-events.js
node scripts/audit-extract-adapter-from-events.js --all   # all retained JSONL files
```
