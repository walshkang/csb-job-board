/**
 * Multi-provider LLM client — drop-in replacement path for gemini-text.js.
 * Dispatches to Gemini or Anthropic based on the `provider` argument.
 *
 * Exports:
 *   callLLM({ provider, apiKey, model, prompt, maxOutputTokens?, fallbackModel?, baseDelayMs? })
 *   streamLLM({ provider, apiKey, model, prompt, maxOutputTokens?, fallbackModel?, baseDelayMs?, onToken? })
 *   DailyQuotaError
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class DailyQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DailyQuotaError';
  }
}

// ---------------------------------------------------------------------------
// Gemini paths (ported from gemini-text.js, unchanged logic)
// ---------------------------------------------------------------------------

async function callGeminiText({ apiKey, model, prompt, maxOutputTokens = 8192, fallbackModel = null, baseDelayMs = 2000 }) {
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
  const genAI = new GoogleGenerativeAI(apiKey);
  const makeModel = (name) => genAI.getGenerativeModel({ model: name, generationConfig: { temperature: 0, maxOutputTokens } });

  const maxAttempts = 5;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await makeModel(model).generateContent(prompt);
      const text = result.response.text();
      if (!text || !String(text).trim()) throw new Error('Empty response from Gemini');
      return String(text).trim();
    } catch (err) {
      lastErr = err;
      const msg = String(err && err.message ? err.message : err);
      const isResourceExhausted = /RESOURCE_EXHAUSTED/i.test(msg);
      const hasRetryHint = /retry in [\d.]+s/i.test(msg);
      const isServiceUnavailable = /503|SERVICE_UNAVAILABLE/i.test(msg);

      if (isResourceExhausted && !hasRetryHint) {
        throw new DailyQuotaError(`Gemini daily quota exceeded (${model}): ${msg.slice(0, 200)}`);
      }

      const isRateLimited = /429|Too Many Requests/i.test(msg) || isResourceExhausted || isServiceUnavailable;
      if (!isRateLimited || attempt === maxAttempts - 1) throw err;

      const waitMs = Math.min(120000, Math.ceil(baseDelayMs * Math.pow(2, attempt)));
      await delay(waitMs);
    }
  }

  if (fallbackModel) {
    const result = await makeModel(fallbackModel).generateContent(prompt);
    const text = result.response.text();
    if (!text || !String(text).trim()) throw new Error('Empty response from Gemini (fallback)');
    return String(text).trim();
  }

  throw lastErr;
}

async function streamGeminiText({ apiKey, model, prompt, maxOutputTokens = 8192, fallbackModel = null, baseDelayMs = 2000, onToken }) {
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
  const emit = onToken || (chunk => process.stderr.write(chunk));
  const genAI = new GoogleGenerativeAI(apiKey);
  const makeModel = (name) => genAI.getGenerativeModel({ model: name, generationConfig: { temperature: 0, maxOutputTokens } });

  async function runStream(m) {
    const result = await m.generateContentStream(prompt);
    let text = '';
    for await (const chunk of result.stream) {
      const token = chunk.text();
      if (token) { emit(token); text += token; }
    }
    emit('\n');
    if (!text.trim()) throw new Error('Empty response from Gemini (stream)');
    return text.trim();
  }

  const maxAttempts = 5;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await runStream(makeModel(model));
    } catch (err) {
      lastErr = err;
      const msg = String(err && err.message ? err.message : err);
      const isResourceExhausted = /RESOURCE_EXHAUSTED/i.test(msg);
      const hasRetryHint = /retry in [\d.]+s/i.test(msg);
      const isServiceUnavailable = /503|SERVICE_UNAVAILABLE/i.test(msg);

      if (isResourceExhausted && !hasRetryHint) {
        throw new DailyQuotaError(`Gemini daily quota exceeded (${model}): ${msg.slice(0, 200)}`);
      }

      const isRateLimited = /429|Too Many Requests/i.test(msg) || isResourceExhausted || isServiceUnavailable;
      if (!isRateLimited || attempt === maxAttempts - 1) throw err;

      const waitMs = Math.min(120000, Math.ceil(baseDelayMs * Math.pow(2, attempt)));
      await delay(waitMs);
    }
  }

  if (fallbackModel) {
    return await runStream(makeModel(fallbackModel));
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// Anthropic path
// ---------------------------------------------------------------------------

function getAnthropicClient(apiKey) {
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    throw new Error('Anthropic SDK not installed — run: npm install @anthropic-ai/sdk');
  }
  return new Anthropic({ apiKey });
}

function isAnthropicRetryable(err) {
  const msg = String(err && err.message ? err.message : err);
  const status = err && err.status;
  return (
    /overloaded_error/i.test(msg) ||
    /rate_limit_error/i.test(msg) ||
    status === 429 ||
    status === 529 ||
    /529/i.test(msg)
  );
}

function isAnthropicBillingError(err) {
  const msg = String(err && err.message ? err.message : err);
  const status = err && err.status;
  return (
    status === 403 ||
    /billing/i.test(msg) ||
    /credit balance/i.test(msg) ||
    /payment/i.test(msg)
  );
}

async function callAnthropicText({ apiKey, model, prompt, maxOutputTokens = 8192, fallbackModel = null, baseDelayMs = 2000 }) {
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  const client = getAnthropicClient(apiKey);

  async function attempt(m) {
    const msg = await client.messages.create({
      model: m,
      max_tokens: maxOutputTokens,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content && msg.content[0] && msg.content[0].text;
    if (!text || !String(text).trim()) throw new Error('Empty response from Anthropic');
    return String(text).trim();
  }

  const maxAttempts = 5;
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await attempt(model);
    } catch (err) {
      lastErr = err;
      if (isAnthropicBillingError(err)) {
        throw new DailyQuotaError(`Anthropic billing/credit error (${model}): ${String(err.message).slice(0, 200)}`);
      }
      if (!isAnthropicRetryable(err) || i === maxAttempts - 1) throw err;
      const waitMs = Math.min(120000, Math.ceil(baseDelayMs * Math.pow(2, i)));
      await delay(waitMs);
    }
  }

  if (fallbackModel) {
    return await attempt(fallbackModel);
  }

  throw lastErr;
}

async function streamAnthropicText({ apiKey, model, prompt, maxOutputTokens = 8192, fallbackModel = null, baseDelayMs = 2000, onToken }) {
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  const emit = onToken || (chunk => process.stderr.write(chunk));
  const client = getAnthropicClient(apiKey);

  async function runStream(m) {
    const stream = await client.messages.stream({
      model: m,
      max_tokens: maxOutputTokens,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });
    let text = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
        const token = event.delta.text;
        if (token) { emit(token); text += token; }
      }
    }
    emit('\n');
    if (!text.trim()) throw new Error('Empty response from Anthropic (stream)');
    return text.trim();
  }

  const maxAttempts = 5;
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await runStream(model);
    } catch (err) {
      lastErr = err;
      if (isAnthropicBillingError(err)) {
        throw new DailyQuotaError(`Anthropic billing/credit error (${model}): ${String(err.message).slice(0, 200)}`);
      }
      if (!isAnthropicRetryable(err) || i === maxAttempts - 1) throw err;
      const waitMs = Math.min(120000, Math.ceil(baseDelayMs * Math.pow(2, i)));
      await delay(waitMs);
    }
  }

  if (fallbackModel) {
    return await runStream(fallbackModel);
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// Public API — with transparent telemetry
// ---------------------------------------------------------------------------

const { LLMTelemetry } = require('./utils/llm-telemetry');

/**
 * @param {{ provider: 'gemini'|'anthropic', apiKey: string, model: string, prompt: string,
 *           maxOutputTokens?: number, fallbackModel?: string, baseDelayMs?: number,
 *           _agent?: string }} opts
 * @returns {Promise<string>}
 */
async function callLLM(opts) {
  const telemetry = LLMTelemetry.instance();
  const span = telemetry.start(opts);
  const provider = opts.provider || 'gemini';
  try {
    const result = provider === 'anthropic'
      ? await callAnthropicText(opts)
      : await callGeminiText(opts);
    span.end({ success: true, response_chars: result.length });
    return result;
  } catch (err) {
    span.end({ success: false, error: err.message || String(err) });
    throw err;
  }
}

/**
 * @param {{ provider: 'gemini'|'anthropic', apiKey: string, model: string, prompt: string,
 *           maxOutputTokens?: number, fallbackModel?: string, baseDelayMs?: number,
 *           onToken?: (chunk: string) => void, _agent?: string }} opts
 * @returns {Promise<string>}
 */
async function streamLLM(opts) {
  const telemetry = LLMTelemetry.instance();
  const span = telemetry.start(opts);
  const provider = opts.provider || 'gemini';
  try {
    const result = provider === 'anthropic'
      ? await streamAnthropicText(opts)
      : await streamGeminiText(opts);
    span.end({ success: true, response_chars: result.length });
    return result;
  } catch (err) {
    span.end({ success: false, error: err.message || String(err) });
    throw err;
  }
}

module.exports = { callLLM, streamLLM, DailyQuotaError };
