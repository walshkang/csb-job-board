# Pipeline Improvements — Slice Prompts

Slices for fixing telemetry bugs and adding resilience (retry, circuit breaker, batching, adaptive concurrency) to the orchestrator. Each slice is self-contained, TDD-driven (red → green), and follows the agents.md handoff protocol.

## Dependency graph & parallelization

```
Slice 1 (bugs) ─┐
                ├─ can run in parallel (no file overlap with Slice 2)
Slice 2 (retry + classification) ─┤
                                   ├──→ Slice 3 (circuit breaker)  ─┐
                                   ├──→ Slice 4 (batch categorize) ─┤
                                                                     ├──→ Slice 5 (adaptive concurrency)
```

- **Wave A (parallel):** Slices 1 + 2
- **Wave B (parallel, after 2 lands):** Slices 3 + 4
- **Wave C:** Slice 5

All slices: **Sonnet** is the right level. Slice 1 is borderline Haiku but the outcome-vocabulary touch makes Sonnet safer. No Opus needed — these are scoped refactors, not open-ended research.

---

## Slice 1 — Quick bug fixes (Sonnet, parallel with Slice 2)

```
SCOPE
- Fix two reporting bugs. No new features. No refactor beyond what the fixes require.

FILES IN SCOPE
- admin/public/index.html (progress bar math only)
- src/orchestrator.js (skipped_signature_match unification only)
- tests/ (new test files)

OUT OF SCOPE
- Full outcome-vocabulary refactor (deferred to later slice)
- Any other stage logic, UI sections, or config

BUGS

Bug A — progress bar overstates progress
- admin/public/index.html:154 computes pct as done/started. Because `started`
  only counts items that have entered the queue, the bar hits 100% every time
  the currently-running batch finishes, even when items remain queued.
- Fix: denominator should be started + queued + in_flight (i.e., total work
  the stage knows about right now). Verify with the telemetry payload fields
  already available: stats.started[stage], queue_depths[stage], in_flight[stage].

Bug B — skipped_signature_match is a phantom outcome
- src/orchestrator.js:356-361 treats 'skipped_signature_match' as its own
  outcome branch but emits an event with that string as the outcome name and
  increments stats.skipped. Telemetry consumers don't know this variant
  exists.
- Fix: in scrape stage (src/orchestrator.js:209-216), return
    { outcome: 'skipped', extra: { reason: 'signature_match', ... } }
  Remove the separate 'skipped_signature_match' branch in the queue handler.
  Event payload now carries reason: 'signature_match'.

TDD (RED → GREEN)

1. Write Jest tests FIRST, confirm they fail:
   - tests/orchestrator-skipped-signature.test.js
     * Stub scrapeCompany to return { skipped_signature_match: true, method, status_code }
     * Assert runStage('scrape', company) returns
         { outcome: 'skipped', extra: { reason: 'signature_match', ... } }
     * Assert stats.skipped increments and outcome emitted is 'skipped'
   - tests/progress-bar-math.test.js (or inline with jsdom if the suite supports)
     * Given stats.started[stage]=10, queue_depths[stage]=5, in_flight[stage]=2,
       done=3 (completed+no_result+failed+skipped), assert pct = round(3/17 * 100).

2. Run `npm test` — both must fail.

3. Implement the minimum change. Re-run — both pass.

HANDOFF
Use the [STATUS]/[FILES_MODIFIED]/[NEW_CONTRACTS]/[MESSAGE] format from agents.md.
```

---

## Slice 2 — Failure classification + retry with backoff (Sonnet, foundation)

```
SCOPE
- Formalize transient-vs-permanent failure classification.
- Add bounded exponential backoff retries for transient classes only.
- Emit retry events so telemetry can see attempts.

FILES IN SCOPE
- src/utils/pipeline-events.js (extend classifyFailure)
- src/orchestrator.js (retry wrapper around runStage; emit retry events)
- tests/

OUT OF SCOPE
- Circuit breaker (Slice 3)
- Any stage-specific behavior changes
- Config UI

DATA CONTRACT (write first, export)

// src/utils/pipeline-events.js
const FAILURE_CLASSES = Object.freeze({
  TRANSIENT_NETWORK: 'transient_network', // ECONNRESET, ETIMEDOUT, fetch network errors
  RATE_LIMIT:        'rate_limit',        // HTTP 429, provider rate-limit messages
  TIMEOUT:           'timeout',            // operation exceeded stage deadline
  AUTH:              'auth',               // 401/403, invalid API key
  CONFIG:            'config',             // missing prompt, missing agent config
  BAD_DATA:          'bad_data',           // malformed HTML, unparseable response
  UNKNOWN:           'unknown',
});
const TRANSIENT = new Set([FAILURE_CLASSES.TRANSIENT_NETWORK, FAILURE_CLASSES.RATE_LIMIT, FAILURE_CLASSES.TIMEOUT]);
function isTransient(failureClass) { return TRANSIENT.has(failureClass); }

Extend classifyFailure to return one of the FAILURE_CLASSES values based on
err.code, err.status, and message patterns. Keep it pure/testable.

RETRY POLICY
- Max attempts: 3 (configurable constant RETRY_MAX_ATTEMPTS in orchestrator.js)
- Backoff: 500ms * 2^attempt with ±20% jitter (so 500, 1000, 2000 nominal)
- Only retry if isTransient(failure_class). Otherwise fail immediately.
- Emit event outcome: 'retry' with { attempt, failure_class, next_delay_ms }
  BEFORE sleeping. Final failure still emits outcome: 'failure'.
- Do NOT advance the company on retry. The retry is within the same queue task.

TDD (RED → GREEN)

Write tests first:
- tests/failure-classification.test.js
  * classifyFailure(new Error('ECONNRESET'), ...) → transient_network
  * classifyFailure({ status: 429 }, ...) → rate_limit
  * classifyFailure({ status: 401 }, ...) → auth
  * classifyFailure(new Error('prompt unavailable'), ...) → config
  * isTransient returns true only for the transient set
- tests/retry-policy.test.js
  * Stub a stage handler that throws 2x with rate_limit then succeeds →
    runStage wrapper returns success, emits 2 retry events then 1 success
  * Stub one that throws auth → no retry, single failure event
  * Stub one that throws rate_limit 3x → retry event emitted 2 times (after
    attempts 1 and 2), final failure event on attempt 3

Run `npm test`: red. Implement. Re-run: green.

IMPLEMENTATION NOTES
- Put the retry loop inside the existing queues[stage].add() callback in
  orchestrator.js so concurrency accounting still works (one slot held for
  the whole retry sequence — this is intentional; it prevents a retry storm
  from stampeding).
- Use a Promise-based sleep, NOT setTimeout with callbacks, so the p-queue
  task awaits properly.

HANDOFF: standard format.
```

---

## Slice 3 — Circuit breaker per stage (Sonnet, parallel with Slice 4, after Slice 2)

```
SCOPE
- Per-stage rolling failure-rate breaker. When open, stage pauses new work and
  surfaces state to admin UI. Manual reset via API.

DEPENDS ON
- Slice 2 must be merged (needs failure-class vocabulary).

FILES IN SCOPE
- src/utils/circuit-breaker.js (new)
- src/orchestrator.js (consult breaker before enqueueing; expose state in
  snapshot payload)
- admin/server.js (POST /api/circuit/:stage/reset endpoint)
- admin/public/index.html (banner + reset button)
- tests/

OUT OF SCOPE
- Adaptive concurrency
- Any change to stage handler internals

DATA CONTRACT

// src/utils/circuit-breaker.js
class CircuitBreaker {
  constructor({ windowSize = 20, minSamples = 5, threshold = 0.5, cooldownMs = 60000 })
  record(outcome /* 'success' | 'failure' */)
  state() // 'closed' | 'open' | 'half_open'
  allow() // boolean — false when open and cooldown not elapsed; true for half_open (one probe)
  reset()
  snapshot() // { state, failureRate, samples, openedAt, nextProbeAt }
}

Rules:
- Only 'failure' outcomes count toward the rate (not no_result/skipped — those
  are legitimate results).
- Open when samples >= minSamples AND failureRate >= threshold.
- After cooldownMs, move to 'half_open'. Next record() decides: success → closed,
  failure → open again.
- allow() returns true when closed or half_open (allowing the probe); false when open.

SNAPSHOT EXTENSION
Add breakers: { [stage]: breaker.snapshot() } to the snapshot payload in
src/orchestrator.js.

UI
- When any breaker.state === 'open', render a red banner above the telemetry
  section: "Stage `X` paused — failure rate Y% (N samples). [Reset]".
- Reset button calls POST /api/circuit/:stage/reset.

TDD (RED → GREEN)

- tests/circuit-breaker.test.js
  * New breaker starts 'closed'
  * 3 failures below minSamples → still closed
  * 5 failures (>= minSamples, 100% rate) → open
  * allow() returns false when open
  * After cooldown → half_open, allow() returns true
  * Probe success in half_open → closed
  * Probe failure in half_open → open
  * reset() returns to closed, clears samples
- tests/orchestrator-breaker-integration.test.js
  * When breaker for a stage is open, enqueue() does not add a task
  * Stage records success/failure outcomes into its breaker

Run red → green.

HANDOFF: standard format. Note the new POST endpoint in [NEW_CONTRACTS].
```

---

## Slice 4 — Batch categorize (Sonnet, parallel with Slice 3, after Slice 2)

```
SCOPE
- Send 5–10 companies per categorizer LLM call instead of one.
- Retain per-company events (telemetry granularity must not regress).
- Partial-failure handling: if batch response can't be parsed per-company,
  retry failed companies individually.

DEPENDS ON
- Slice 2 must be merged (retry + classification).

FILES IN SCOPE
- src/agents/categorizer.js (add batchCategorize function; keep
  categorizeCompany as the single-company path)
- src/prompts/categorizer.txt (or new categorizer-batch.txt)
- src/orchestrator.js (new batching buffer for categorize stage only)
- tests/

OUT OF SCOPE
- Changing any other stage
- Changing the taxonomy
- Changing single-company categorize behavior (must still work for tests/other callers)

DATA CONTRACT

// src/agents/categorizer.js
async function batchCategorize(entries, taxonomy, llmConfig)
  // entries: [{ company, rep }], length 1..BATCH_MAX (=10)
  // returns: Map<company_id, { category, confidence, reason, error? }>

LLM RESPONSE FORMAT
Design the prompt so the model returns JSON:
{
  "results": [
    { "company_id": "...", "category": "...", "confidence": 0.xx, "reason": "..." },
    ...
  ]
}
Parse strictly. If a company_id is missing from results OR confidence/category
malformed, mark that company as failed in the returned map — do NOT throw for
the whole batch.

ORCHESTRATOR BATCHING (categorize stage only)
- Add a categorize-specific batching buffer with flush triggers:
  * batch size reached (10)
  * max wait timeout (2000ms since first entry added)
  * queue idle (onIdle flush)
- Each company task, when picked up, pushes into the buffer and awaits the
  batch's shared promise.
- On batch resolution, each task emits its own event (success/no_result) using
  the per-company result from the map.
- On per-company failure inside a successful batch call → retry that company
  individually via categorizeCompany (single-path fallback). This uses Slice 2
  retry semantics for free.

TDD (RED → GREEN)

- tests/batch-categorize.test.js
  * Stub LLM to return well-formed JSON for 5 companies → map has 5 entries
    with correct fields
  * Stub LLM to return JSON missing one company_id → that company marked failed,
    others succeed
  * Stub LLM to return malformed JSON → function throws (caller retries)
  * BATCH_MAX respected (calling with 11 throws or splits — pick one, document)
- tests/orchestrator-categorize-batching.test.js
  * 5 companies enqueued within the wait window → single batchCategorize call
  * Each company receives its own success event with its own extra.category
  * Timeout flush: 2 companies, no more arrive → batch flushes at wait cap
  * One company fails in batch → falls back to single-path categorizeCompany

Red → green.

IMPLEMENTATION NOTES
- Keep the single-path categorizeCompany fully working (other callers, tests).
- Preserve dryRun semantics: batch path also short-circuits in dryRun.
- Log tokens-saved estimate to stderr when batches flush (rough: 1 batch-call
  tokens vs N single-call tokens, using response.usage if available).

HANDOFF: standard format.
```

---

## Slice 5 — Adaptive concurrency (Sonnet, after 2 + 3)

```
SCOPE
- Per-stage concurrency auto-tunes within [min, max] based on rolling p95
  duration and queue depth. Scales down on error-rate spike.

DEPENDS ON
- Slices 2 and 3 merged (needs classification + breaker so we don't scale up
  a broken stage).

FILES IN SCOPE
- src/utils/adaptive-concurrency.js (new)
- src/orchestrator.js (wire controller to each queue; keep current values as
  defaults)
- tests/

OUT OF SCOPE
- UI changes beyond surfacing current concurrency in snapshot
- Changing any stage logic

DATA CONTRACT

// src/utils/adaptive-concurrency.js
class AdaptiveController {
  constructor({ stage, min, max, target, breaker })
    // target: { p95MaxMs, queueDepthTrigger }
  recordOutcome({ duration_ms, outcome })
  tick() // called every N seconds; mutates queue.concurrency
  snapshot() // { current, min, max, p95Ms, errorRate }
}

Rules (keep simple):
- If breaker open/half_open → do nothing (breaker owns the stage).
- Every tick (5s):
  * Compute p95 over last 60s, error rate over last 60s.
  * If queueDepth > queueDepthTrigger AND p95 stable (<= p95MaxMs) AND
    errorRate < 0.1 → concurrency = min(max, current + 1)
  * If errorRate >= 0.2 OR p95 > 1.5 * p95MaxMs → concurrency = max(min, current - 1)
  * Else no change.
- Snapshot extended with concurrency_current per stage.

DEFAULTS (initial)
- Keep current CONCURRENCIES as the starting current value. min = max(1, floor(current/2)).
  max = current * 2. Targets tuned per stage (tight p95 for network stages,
  looser for LLM stages — exact numbers in code).

TDD (RED → GREEN)

- tests/adaptive-concurrency.test.js
  * Simulate high queue depth + stable latency → current increments toward max
  * Simulate error spike → current decrements toward min
  * Breaker open → tick() is a no-op
  * Bounded by min and max (no under/overshoot)
- tests/orchestrator-adaptive-integration.test.js
  * Controller.tick() mutates queues[stage].concurrency

Red → green.

HANDOFF: standard format.
```

---

## How to execute

- **Wave A:** launch Slices 1 and 2 as two parallel agents — different files, no conflict.
- Wait for Slice 2 to land and expose classification exports.
- **Wave B:** launch Slices 3 and 4 in parallel — they touch different files (circuit-breaker utility + orchestrator vs categorizer agent + prompt + orchestrator). The overlap is `orchestrator.js`; if merges feel risky, serialize 3 then 4.
- **Wave C:** Slice 5 solo.
