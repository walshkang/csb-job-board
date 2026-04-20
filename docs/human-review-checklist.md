# Human review checklist

Use this when changing prompts, taxonomy, Notion, or heuristics. It ties **where to look**, **what is assumed**, and **open questions** so reviews stay grounded in the repo rather than tribal memory.

---

## MBA relevance (`low` | `medium` | `high`)

**Canonical definition** lives in `src/prompts/enrichment.txt` (model instructions) and should match how humans filter in Notion.

| Tier | Prompt rubric (authoritative for the LLM) | Reader-facing summary (README) |
|------|---------------------------------------------|----------------------------------|
| **high** | Strategy, business development, product leadership, GM, operations leadership, venture/finance roles | Prioritize — strategy, BD, product leadership, GM, ops leadership, venture/finance |
| **medium** | Product management, marketing leadership, partnerships, supply chain leadership, and adjacent business-oriented roles | Worth reviewing — PM, marketing leadership, partnerships, supply chain |
| **low** | Primarily technical/IC roles or early-career roles that are less typical for MBA recruiting | Primarily technical or entry-level; less typical for MBA recruiting |

**Examples in the prompt** (vet these; they train reviewer intuition as much as the model):

- VP Business Development @ clean energy → `high`
- Junior Frontend Engineer @ climate startup → `low`
- Account Manager @ solar hardware → `medium` (function `sales`, not “manager with reports”)
- Customer Support Specialist → `low`
- Associate General Counsel (non-climate company) → `low`, `climate_relevance_confirmed=false`
- Director, Analytics Engineer (non-climate) → `medium`, `climate_relevance_confirmed=false`

**Open questions / assumptions**

- **Overlap:** Many roles span tiers (e.g. senior PM vs IC PM). The prompt does not define hard boundaries; expect drift unless you add labeled edge cases.
- **Legal / counsel:** Example maps AGC → `low` for MBA; confirm that matches your program’s recruiting focus.
- **Data / analytics leadership:** Single example uses `medium` at director level for a non-climate company — climate vs non-climate is orthogonal to MBA tier in the schema; confirm that is intended.
- **Code vs model:** `src/agents/enricher.js` coerces invalid or missing `mba_relevance` to **`low`**. That is a product assumption (“conservative default”).
- **Seniority:** `resolveDeterministic()` can override **seniority** from title regexes; it does **not** set MBA tier — MBA is entirely from the model (or prior stored value) except coercion.

After any rubric change: bump `ENRICHMENT_PROMPT_VERSION` in `src/agents/enricher.js` and plan a re-enrich (`npm run enrich -- --force`) if historical jobs should be re-tagged.

---

## Prompt templates (vet wording, examples, JSON contract)

| File | Consumer | Review focus |
|------|-----------|--------------|
| `src/prompts/extraction.txt` | `src/agents/extraction.js` | URL/description anti-hallucination, HTML edge cases |
| `src/prompts/enrichment.txt` | `src/agents/enricher.js` | All field rules + examples; schema must match `sanitize()` |
| `src/prompts/enrichment-batch.txt` | Batch enrich path in `enricher.js` | Parity with single-job semantics |
| `src/prompts/categorizer.txt` | `src/agents/categorizer.js` | Match priority, `"None"` behavior, confidence |
| `src/prompts/ocr.txt`, `src/prompts/ocr-pdf.txt` | `src/agents/ocr.js` | Layout assumptions, PDF noise and truncation |
| `src/prompts/reviewer.txt` | `src/agents/reviewer.js` | What postmortems optimize for |
| `src/prompts/optimization.txt` | `scripts/optimize-prompts.js` | What “better” means for automated prompt edits |

**Assumptions**

- Enrichment description in prompt is capped (strip HTML, then slice) — see `enrichJob` / `enrichJobBatch` in `enricher.js`.
- Extraction HTML is truncated at `MAX_HTML_CHARS` in `extraction.js` — large career pages lose tail listings unless that constant changes.

---

## Taxonomy and keywords

| Asset | Review focus |
|-------|----------------|
| `data/climate-tech-map-industry-categories.json` | `Tech Category Name`, opportunity area, primary sector, **`keywords`**, `short_description`; overlaps and typos affect rule-based categorization |

**Code coupling:** `src/agents/categorizer.js` builds a keyword index from this file; `resolveByRule()` assigns a category when exactly one top-scoring category wins. **Assumption:** PitchBook `company_profile.keywords` entries match taxonomy keyword strings after normalization (case, spacing) — near-miss strings do not match.

**Open questions**

- Who approves taxonomy edits before merge? (`context.md` tracks this as taxonomy-human-review.)
- Should ambiguous multi-category keyword ties always fall through to the LLM? (Current behavior: yes.)

---

## Code enums and heuristics (stay aligned with prompts + Notion)

| Location | Review focus |
|----------|----------------|
| `src/agents/enricher.js` — `JOB_FUNCTIONS`, `SENIORITY_LEVELS`, `MBA_RELEVANCE`, `sanitize()` | Allowed values and fallbacks (`other`, `unknown`, `low`) |
| `src/agents/enricher.js` — `resolveDeterministic()` | Title/location regexes for seniority, employment type, location type |
| `src/agents/categorizer.js` | Shortlist size, overlap scoring, rule resolver |
| `src/agents/notion-sync.js` — `normalizeSelectName()` | Notion select **option spelling** must match what Notion UI defines |

---

## Notion

| Location | Review focus |
|----------|----------------|
| `src/agents/notion-setup.js` | Property types; Jobs `MBA Relevance` options are seeded as `low` / `medium` / `high` |
| Notion databases (outside repo) | All other select options for categories, job function, seniority, etc., must exist and match synced strings |

Run `node src/agents/notion-sync.js --dry-run` after pipeline changes to validate mappings (`context.md`).

---

## Artifacts and QA outputs

| Output | Use |
|--------|-----|
| `data/postmortems/*.md` | Reviewer narrative quality |
| `data/runs/*.json` | Regression signal across runs |
| `npm run` / `node src/agents/qa.js` | Spot-check counts, enrichment errors, reachable companies with zero jobs |
| `data/prompt-history/`, `data/benchmarks/` | If using `scripts/optimize-prompts.js` — human gate before promoting prompt text |

---

## Tests and fixtures

| Path | Review focus |
|------|----------------|
| `test/fixtures/sample.html` | Representative extraction HTML |
| `test/extraction.test.js`, `test/test-enricher-helpers.js` | Expected behavior when rubrics change |

---

## Product and architecture notes (non-runtime)

| Doc | Use |
|-----|-----|
| `docs/shape-dehallucinate.md` | Planned slices affecting prompts and categorizer |
| `README.md` | Operator docs, MBA table, versioning |
| `context.md` | Backlog todos (PitchBook query definition, labeled MBA examples, categorizer dry-run JSON, etc.) |

**Note:** `context.md` mentions a future `reviewer --propose` flow writing `prompts/proposed/`; that is not implemented in `src/agents/reviewer.js` today.

---

## Suggested review order

1. **MBA + enrichment** — `enrichment.txt` examples and README table vs your program’s hiring reality.  
2. **Climate flag** — false positive/negative rate on a random sample of `climate_relevance_confirmed` / reasons.  
3. **Categories** — sample of `climate_tech_category` vs PitchBook keywords and company profile.  
4. **Extraction** — URL and title integrity on custom HTML companies.  
5. **Notion** — dry-run sync and select option parity.

When something is ambiguous, record the **decision**, **example jobs**, and whether the **prompt**, **taxonomy**, or **code** should change — this doc is the index; the source of truth remains the linked files.
