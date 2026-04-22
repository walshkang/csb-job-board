# Extract adapter expansion — outcome audit (2026-04-21)

Post-change summary for **Slice 4** ([extract-adapter-lanes-slices-2026-04-21.md](extract-adapter-lanes-slices-2026-04-21.md)): compare adapter coverage on the **HTML-only** artifact population against the pre-expansion baseline recorded in the lanes doc, and apply the **ship / no-ship** gate.

## Methodology

| Step | Command / source |
| --- | --- |
| Headroom (current) | `node scripts/audit-html-extract-adapter-headroom.js` |
| Compare + gate vs saved baseline | `node scripts/audit-html-extract-adapter-headroom.js --pre-snapshot=test/fixtures/adapter-headroom-pre-snapshot-2026-04-21.json` |
| Mark fixture regression (manual) | Add `--fixture-fp-regression` if adapter tests show new false positives on known-safe fixtures |
| Extract-path parity (optional) | `node scripts/audit-html-extract-adapter-baseline.js` — note: `htmlLlmCompanies` only increments when `EXTRACTION_LLM_FALLBACK=1` and shape is `other`; for default env, `htmlAdapterCompanies` still matches adapter success count on this population |

**Population:** validated `data/companies.json` rows with `artifacts/html/{id}.html` and no sibling `{id}.json` (same as Slice 0).

**Primary gate metric:** `htmlAdapterCompanies` = count of those rows where deterministic HTML adapters return at least one job. This matches headroom **`adapterHit`** when using the same `tryHtmlAdapters` stack as extraction.

## Before / after metrics

| Metric | Pre (lanes doc baseline) | Post (workspace run, 2026-04-21) | Delta |
| --- | ---: | ---: | ---: |
| HTML-only rows | 457 | 457 | 0 |
| `adapterHit` / `htmlAdapterCompanies` | 147 | 161 | **+14** |
| Misses | 310 | 296 | −14 |
| Adapter coverage % | 32.2 | 35.2 | +3.0 |

Pre values are frozen in [`test/fixtures/adapter-headroom-pre-snapshot-2026-04-21.json`](../../test/fixtures/adapter-headroom-pre-snapshot-2026-04-21.json). Post numbers should be re-recorded after adapter work stabilizes.

### Misses by shape (post snapshot)

From the latest headroom run at audit time:

| Shape | Miss count | High-signal misses (≥3 job-like hrefs) |
| --- | ---: | ---: |
| other | 167 | 18 |
| wordpress-careers-ish | 45 | 31 |
| webflow-dom | 42 | 13 |
| many-career-path-hrefs | 36 | 35 |
| greenhouse-embed-snippet | 2 | 0 |
| lever-embed-snippet | 1 | 0 |

## Known false positives (test fixtures)

**Signal:** `npm test` — focus on `test/html-adapters.test.js` and `test/extraction.test.js` (adapter_empty / negative paths).

| Check | Result (audit time) |
| --- | --- |
| Jest (adapter + extraction tests) | **Pass** — no new failures; no increase in extracted rows on fixtures that must stay empty |

If a change introduces spurious jobs on a fixture that should return `[]`, re-run with `--fixture-fp-regression` so the JSON `shipGate` reflects a fixture failure.

## Ship / no-ship gate

**Keep adapter changes only if both:**

1. **`htmlAdapterCompanies` improves by ≥ 40** (absolute) vs the agreed baseline.
2. **No increase in known false positives** on test fixtures (operationalized as passing the relevant Jest suite, or `--fixture-fp-regression` unset).

**Evaluation (this audit):**

| Criterion | Met? |
| --- | --- |
| Adapter delta ≥ +40 (147 → need ≥ 187) | **No** (+14) |
| Fixtures clean | **Yes** |

**Outcome: NO-SHIP** against the +40 bar with the current post metrics. Further adapter coverage or a revised baseline (with explicit stakeholder sign-off) is required to clear the gate.

Machine-readable gate output:

```bash
node scripts/audit-html-extract-adapter-headroom.js \
  --pre-snapshot=test/fixtures/adapter-headroom-pre-snapshot-2026-04-21.json
```

Inspect `shipGate` in the JSON (`pass`, `reasons`).

---

## Handoff (agents.md)

```
[STATUS]         SUCCESS
[FILES_MODIFIED] scripts/audit-html-extract-adapter-headroom.js; tests/audit-adapter-headroom.test.js; test/fixtures/adapter-headroom-pre-snapshot-2026-04-21.json; docs/archive/extract-adapter-expansion-audit-2026-04-21.md
[NEW_CONTRACTS]  compareHeadroomReports(before, after) → headroom deltas; evaluateExpansionShipGate({ htmlAdapterCompaniesBefore, htmlAdapterCompaniesAfter, fixtureFalsePositiveRegression, minAdapterDelta }) → { pass, reasons, ... }; CLI --pre-snapshot=, --fixture-fp-regression
[MESSAGE]        Slice 4 delivered: post-change audit doc, headroom compare + ship gate helpers with tests, frozen pre snapshot at 147/457. Current workspace post run: 161 adapter hits (+14 vs baseline); gate fails +40 threshold; fixtures green. Re-run headroom after further adapter work and update the “Post” table in this doc.
```
