/**
 * Shared text-only Gemini calls for agents (discovery, extraction, enrichment).
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Thrown when the daily quota is exhausted — retrying won't help.
class DailyQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DailyQuotaError';
  }
}

/**
 * @param {{ apiKey: string, model: string, prompt: string, maxOutputTokens?: number, fallbackModel?: string, baseDelayMs?: number }} opts
 * @returns {Promise<string>}
 */
async function callGeminiText({ apiKey, model, prompt, maxOutputTokens = 8192, fallbackModel = null, baseDelayMs = 2000 }) {
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
  const genAI = new GoogleGenerativeAI(apiKey);
  const m = genAI.getGenerativeModel({
    model,
    generationConfig: {
      temperature: 0,
      maxOutputTokens,
    },
  });

  const maxAttempts = 5;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await m.generateContent(prompt);
      const text = result.response.text();
      if (!text || !String(text).trim()) throw new Error('Empty response from Gemini');
      return String(text).trim();
    } catch (err) {
      lastErr = err;
      const msg = String(err && err.message ? err.message : err);
      const isResourceExhausted = /RESOURCE_EXHAUSTED/i.test(msg);
      const hasRetryHint = /retry in [\d.]+s/i.test(msg);
      const isServiceUnavailable = /503|SERVICE_UNAVAILABLE/i.test(msg);

      // Daily quota: RESOURCE_EXHAUSTED with no per-minute retry hint.
      // Retrying is pointless — bubble up immediately.
      if (isResourceExhausted && !hasRetryHint) {
        throw new DailyQuotaError(`Gemini daily quota exceeded (${model}): ${msg.slice(0, 200)}`);
      }

      const isRateLimited = /429|Too Many Requests/i.test(msg) || isResourceExhausted || isServiceUnavailable;
      if (!isRateLimited || attempt === maxAttempts - 1) throw err;

      // exponential backoff: baseDelayMs * 2^attempt, capped at 120s
      const waitMs = Math.min(120000, Math.ceil(baseDelayMs * Math.pow(2, attempt)));
      await delay(waitMs);
    }
  }

  // if we reached here, primary model exhausted attempts
  if (fallbackModel) {
    try {
      const fbModel = genAI.getGenerativeModel({
        model: fallbackModel,
        generationConfig: {
          temperature: 0,
          maxOutputTokens,
        },
      });
      const result = await fbModel.generateContent(prompt);
      const text = result.response.text();
      if (!text || !String(text).trim()) throw new Error('Empty response from Gemini (fallback)');
      return String(text).trim();
    } catch (fbErr) {
      // surface fallback error
      throw fbErr;
    }
  }

  throw lastErr;
}

/**
 * Streaming variant — same retry/fallback contract as callGeminiText.
 * Tokens are emitted via onToken(chunk) as they arrive; full text is returned.
 * Default onToken writes to stderr so stdout stays clean for JSON artifacts.
 *
 * @param {{ apiKey: string, model: string, prompt: string, maxOutputTokens?: number, fallbackModel?: string, baseDelayMs?: number, onToken?: (chunk: string) => void }} opts
 * @returns {Promise<string>}
 */
async function streamGeminiText({ apiKey, model, prompt, maxOutputTokens = 8192, fallbackModel = null, baseDelayMs = 2000, onToken }) {
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
  const emit = onToken || (chunk => process.stderr.write(chunk));
  const genAI = new GoogleGenerativeAI(apiKey);

  async function runStream(m) {
    const result = await m.generateContentStream(prompt);
    let text = '';
    for await (const chunk of result.stream) {
      const token = chunk.text();
      if (token) {
        emit(token);
        text += token;
      }
    }
    emit('\n');
    if (!text.trim()) throw new Error('Empty response from Gemini (stream)');
    return text.trim();
  }

  const makeModel = (name) => genAI.getGenerativeModel({ model: name, generationConfig: { temperature: 0, maxOutputTokens } });

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
    try {
      return await runStream(makeModel(fallbackModel));
    } catch (fbErr) {
      throw fbErr;
    }
  }

  throw lastErr;
}

module.exports = { callGeminiText, streamGeminiText, DailyQuotaError };
