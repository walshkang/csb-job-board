# Top-miss expansion — extract adapter audit & ship gate (2026-04-21)

[Slice 4 from `docs/extract-adapter-top-miss-slices.md`](../extract-adapter-top-miss-slices.md): pre/post compare for the top-miss HTML adapter push, **ship / no-ship** decision, bucket-level context, and fixture false-positive check.

## Methodology

| Step | Command |
| --- | --- |
| Headroom (current) | `node scripts/audit-html-extract-adapter-headroom.js` |
| Compare + gate vs baseline | `node scripts/audit-html-extract-adapter-headroom.js --pre-snapshot=test/fixtures/adapter-headroom-pre-snapshot-2026-04-21.json` |
| Mark fixture FP regression (if observed) | Same command with `--fixture-fp-regression` |

**Population:** companies in `data/companies.json` with `artifacts/html/{id}.html` and no sibling `{id}.json` (HTML-only). **`htmlAdapterCompanies`** = count where `tryHtmlAdapters` returns ≥1 job; matches headroom **`adapterHit`**.

**Baseline file:** [`test/fixtures/adapter-headroom-pre-snapshot-2026-04-21.json`](../../test/fixtures/adapter-headroom-pre-snapshot-2026-04-21.json) (frozen `htmlAdapterCompanies: 147`, aggregate headroom, **`byShape: []`**).

## Before / after (workspace run, 2026-04-21)

| Metric | Pre (snapshot) | Post (this run) | Delta |
| --- | ---: | ---: | ---: |
| `totalHtmlOnly` | 457 | 457 | 0 |
| `adapterHit` / `htmlAdapterCompanies` | 147 | 151 | **+4** |
| `misses` | 310 | 306 | −4 |
| `adapterCoveragePct` | 32.2 | 33.0 | +0.8 |

## Per-shape misses (top-miss buckets)

The pre snapshot has **no** `byShape` breakdown, so **miss deltas vs baseline are N/A** in machine output (`byShapeTopMiss.baselineShapeBreakdownPresent: false`). Current **post** miss counts among misses for the four expansion shapes:

| Shape | Misses (post) |
| --- | ---: |
| wordpress-careers-ish | 45 |
| webflow-dom | 40 |
| many-career-path-hrefs | 44 |
| other | 171 |

**Tip:** for the next compare, re-save `--pre-snapshot` from a full `headroom` run that includes a populated `byShape` array so `compareTopMissByShape` can emit real `missesDelta` per row.

## Fixture false-positive regression

| Check | Result |
| --- | --- |
| Top-miss harness + targeted adapter tests (see below) | **36 tests passed** — no new failures; `--fixture-fp-regression` **not** used |

Jest focus:

- `test/extraction-html-adapter-top-miss-harness.test.js`
- `tests/extraction-html-adapter-webflow-top-miss.test.js`
- `tests/extraction-html-adapter-wordpress-top-miss.test.js`
- `tests/extraction-html-adapter-many-hrefs.test.js`
- `tests/extraction-html-adapter-other-high-signal.test.js`

**Fixture gate:** `shipGate.fixturesOk === true` (no known FP increase flagged for this run).

## Ship gate (Slice 4)

Keep top-miss adapter work **only if both** hold:

1. **`htmlAdapterCompanies` delta ≥ +40** vs the pre snapshot.
2. **No increased false positives** on the adapter fixture suite (operationalized here as passing the suites above, or a manual `--fixture-fp-regression` if regressions are confirmed).

| Criterion | Met? |
| --- | --- |
| Adapter delta ≥ +40 (147 → need ≥ 187) | **No** (+4) |
| No fixture FP regression (tests green) | **Yes** |

### Recommendation: **NO-SHIP**

`evaluateExpansionShipGate` output for this run: **`pass: false`** — failed on adapter delta, not on fixtures. Re-audit after further adapter work (or, if the product team formally moves the +40 bar or baseline, update the snapshot and re-run the same command).

---

## Handoff (agents.md)

```
[STATUS]         SUCCESS
[FILES_MODIFIED] scripts/audit-html-extract-adapter-headroom.js (compareTopMissByShape + JSON byShapeTopMiss);
                 test/audit-html-extract-adapter-headroom-compare.test.js;
                 docs/archive/extract-adapter-top-miss-audit-2026-04-21.md
[NEW_CONTRACTS]  compareTopMissByShape(before, after) → { baselineShapeBreakdownPresent, topMissRows } for
                 wordpress-careers-ish, webflow-dom, many-career-path-hrefs, other; exported next to
                 compareHeadroomReports / evaluateExpansionShipGate
[MESSAGE]        Slice 4 gate+report: vs pre snapshot 147→151 adapter companies (+4), gate fails +40;
                 top-miss fixture suites pass (no --fixture-fp-regression). Per-shape miss deltas N/A until
                 baseline JSON includes byShape. Ship recommendation NO-SHIP on adapter bar; fixtures OK.
```
