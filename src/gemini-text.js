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
 * @param {{ apiKey: string, model: string, prompt: string, maxOutputTokens?: number }} opts
 * @returns {Promise<string>}
 */
async function callGeminiText({ apiKey, model, prompt, maxOutputTokens = 8192 }) {
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

      // Daily quota: RESOURCE_EXHAUSTED with no per-minute retry hint.
      // Retrying is pointless — bubble up immediately.
      if (isResourceExhausted && !hasRetryHint) {
        throw new DailyQuotaError(`Gemini daily quota exceeded (${model}): ${msg.slice(0, 200)}`);
      }

      const isRateLimited = /429|Too Many Requests/i.test(msg) || isResourceExhausted;
      if (!isRateLimited || attempt === maxAttempts - 1) throw err;
      let waitMs = 45000;
      const retryIn = msg.match(/retry in ([\d.]+)s/i);
      if (retryIn) waitMs = Math.ceil(parseFloat(retryIn[1]) * 1000) + 1500;
      await delay(Math.min(waitMs, 120000));
    }
  }
  throw lastErr;
}

module.exports = { callGeminiText, DailyQuotaError };
