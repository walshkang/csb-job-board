# Shape Up: Multi-Provider LLM Abstraction

**Appetite:** ~4 hours across slices
**Problem:** If a user only has an Anthropic key (no Gemini), the pipeline breaks at every agent except PDF OCR. The system should auto-detect which key is available and route all LLM calls accordingly.

**Current state:** 6 agents depend on `callGeminiText` from `src/gemini-text.js`. OCR already has a Gemini/Anthropic split for PDF mode but image mode is Gemini-only. Config (`src/config.js`) only wires Anthropic into the `ocr` block.

---

## Slices

### Slice A — `src/llm-client.js` + config changes (foundation)

**Must complete before:** all other slices
**Estimated size:** ~200 lines new code + ~30 lines config changes

**What to build:**

1. **`src/llm-client.js`** — drop-in replacement for `src/gemini-text.js` that dispatches by provider.

   Exports:
   - `callLLM({ provider, apiKey, model, prompt, maxOutputTokens?, fallbackModel?, baseDelayMs? })` → `Promise<string>`
   - `streamLLM({ provider, apiKey, model, prompt, maxOutputTokens?, fallbackModel?, baseDelayMs?, onToken? })` → `Promise<string>`
   - `DailyQuotaError` (re-export, same class)

   Provider dispatch:
   - `provider === 'gemini'` → use `@google/generative-ai` (existing logic from `gemini-text.js`)
   - `provider === 'anthropic'` → use `@anthropic-ai/sdk` (dynamic require, error if missing)

   Anthropic path must replicate:
   - Retry with exponential backoff on `overloaded_error`, `rate_limit_error`, 429, 529
   - `DailyQuotaError` equivalent (Anthropic doesn't have daily quota the same way — map to billing errors)
   - Fallback model support (try primary, fall back to secondary on persistent failure)
   - Streaming via `stream: true` on `messages.create`, iterate `message_stream` events

   Do NOT delete `gemini-text.js` yet — keep it as-is so agents can migrate incrementally.

2. **`src/config.js` changes:**

   Add global provider detection:
   ```js
   const LLM_PROVIDER = process.env.LLM_PROVIDER
     || (process.env.GEMINI_API_KEY ? 'gemini'
       : process.env.ANTHROPIC_API_KEY ? 'anthropic'
       : 'gemini');
   ```

   Add to each agent config block:
   ```js
   discovery: {
     provider: process.env.DISCOVERY_PROVIDER || LLM_PROVIDER,
     geminiKey: process.env.GEMINI_API_KEY || null,
     anthropicKey: process.env.ANTHROPIC_API_KEY || null,
     model: /* existing logic */,
     anthropicModel: process.env.DISCOVERY_ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
   },
   ```

   Pattern repeats for: `extraction`, `enrichment`, `categorizer`, `reviewer`.

   New `.env.local` keys to document:
   ```
   LLM_PROVIDER              # gemini | anthropic (auto-detects if omitted)
   ANTHROPIC_API_KEY          # enables Anthropic provider
   # Per-agent Anthropic model overrides:
   DISCOVERY_ANTHROPIC_MODEL
   EXTRACTION_ANTHROPIC_MODEL
   ENRICHMENT_ANTHROPIC_MODEL
   CATEGORIZER_ANTHROPIC_MODEL
   REVIEWER_ANTHROPIC_MODEL
   ```

**Acceptance criteria:**
- `callLLM({ provider: 'gemini', ... })` behaves identically to current `callGeminiText`
- `callLLM({ provider: 'anthropic', ... })` returns text from Claude with retry/backoff
- Config auto-detects: setting only `ANTHROPIC_API_KEY` in `.env.local` makes `LLM_PROVIDER` resolve to `'anthropic'`
- Existing `callGeminiText` still works (no agents broken during migration)

---

### Slice B — Migrate text-based agents (5 agents, parallelizable)

**Depends on:** Slice A
**All 5 sub-slices are independent of each other — run in parallel.**

Each agent migration follows the same pattern:
1. Replace `require('../gemini-text')` with `require('../llm-client')`
2. Replace `callGeminiText({ apiKey, model, prompt, ... })` with `callLLM({ provider: config.<agent>.provider, apiKey: config.<agent>.provider === 'anthropic' ? config.<agent>.anthropicKey : config.<agent>.geminiKey, model: config.<agent>.provider === 'anthropic' ? config.<agent>.anthropicModel : config.<agent>.model, prompt, ... })`
3. For streaming calls (`streamGeminiText`), replace with `streamLLM` using same pattern

A helper could reduce the boilerplate — e.g., `config.resolveAgent('discovery')` returns `{ provider, apiKey, model }` — but that's optional polish.

#### B1 — `src/agents/discovery.js`
- 1 call site: `callGeminiText` (LLM fallback for careers page URL guessing)
- No streaming

#### B2 — `src/agents/extraction.js`
- 1 call site: `callGeminiText` (extract jobs from HTML artifacts)
- No streaming

#### B3 — `src/agents/enricher.js`
- 2 call sites: `callGeminiText` (classify jobs — single and batch mode)
- Has `fallbackModel` — ensure Anthropic fallback model is wired
- No streaming

#### B4 — `src/agents/categorizer.js`
- 1 call site: `callGeminiText` (categorize company into taxonomy)
- Uses `config.enrichment.apiKey` and `config.enrichment.model` (piggybacks enrichment config) — decide whether to give categorizer its own config block or keep sharing
- No streaming

#### B5 — `src/agents/reviewer.js`
- 2 call sites: `callGeminiText` + `streamGeminiText`
- Streaming is used for the postmortem generation (visual progress in terminal)
- This is the only agent that uses streaming — handle `streamLLM` carefully

**Acceptance criteria per agent:**
- Agent runs with `GEMINI_API_KEY` only → uses Gemini (no behavior change)
- Agent runs with `ANTHROPIC_API_KEY` only → uses Anthropic
- Agent runs with both keys → respects `LLM_PROVIDER` or per-agent override
- `--dry-run` flag still works where applicable

---

### Slice C — OCR image mode Anthropic vision

**Depends on:** Slice A
**Can run in parallel with Slice B**

Currently `callGeminiOCR(imagePath)` in `src/agents/ocr.js` only supports Gemini vision. Add an Anthropic path.

**What to build:**

Add `callAnthropicOCR(imagePath)` alongside existing `callGeminiOCR`:
```js
async function callAnthropicOCR(imagePath) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.ocr.anthropicKey });
  const imageData = fs.readFileSync(imagePath).toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mediaType = ext === '.png' ? 'image/png' : 'image/jpeg';
  const promptText = fs.readFileSync(
    path.join(__dirname, '../prompts/ocr.txt'), 'utf8'
  );
  const msg = await client.messages.create({
    model: config.ocr.anthropicModel,
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageData } },
        { type: 'text', text: promptText },
      ],
    }],
  });
  return parseJSONResponse(msg.content[0].text);
}
```

Update the image processing loop in `main()` to dispatch:
```js
const ocrFn = config.ocr.provider === 'anthropic' ? callAnthropicOCR : callGeminiOCR;
const rows = await ocrFn(img);
```

**Acceptance criteria:**
- `OCR_PROVIDER=anthropic npm run ocr -- data/images` processes PNG/JPG screenshots via Claude vision
- PDF mode continues to work with both providers (already done)

---

### Slice D — Cleanup and docs

**Depends on:** Slices B and C complete
**Cannot be parallelized** (touches shared files)

1. Delete `src/gemini-text.js` once all agents are migrated
2. Update `context.md`:
   - Config/env section: document `LLM_PROVIDER`, `ANTHROPIC_API_KEY`, per-agent model overrides
   - Pipeline section: note multi-provider support
3. Update `data/images/README.md` if processing command changes
4. Update `.env.local` comments (already partly done in config.js header)

---

## Execution order

```
Slice A  (foundation — must go first)
  │
  ├── Slice B1  (discovery)     ─┐
  ├── Slice B2  (extraction)     │
  ├── Slice B3  (enricher)       ├── all parallel
  ├── Slice B4  (categorizer)    │
  ├── Slice B5  (reviewer)      ─┘
  │
  ├── Slice C   (OCR vision)    ── parallel with B
  │
  └── Slice D   (cleanup/docs)  ── after B + C done
```

**Critical path:** A → any one of B1-B5 → D
**Fastest completion:** A (sequential), then B1-B5 + C (all parallel), then D (sequential)

---

## Risk / de-scoping

- **If Anthropic SDK not installed:** `callLLM` should throw a clear message ("run npm install @anthropic-ai/sdk") rather than crash with a cryptic require error. Dynamic require, not a hard dependency.
- **Streaming parity:** If Anthropic streaming is too fiddly, B5 (reviewer) can batch instead of stream for the Anthropic path. Acceptable degradation.
- **responseSchema:** Gemini's structured output (`responseSchema`) has no Anthropic equivalent. The `parseJSONResponse` fallback already handles this — no extra work needed.
- **Cost difference:** Anthropic (Claude Haiku) is more expensive per token than Gemini Flash-Lite. Document the tradeoff in `.env.local` comments but don't gate on it.
