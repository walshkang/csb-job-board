const { classifyLlmMessage } = require('../src/utils/pipeline-events');

describe('classifyLlmMessage', () => {
  test('classifies Google prepayment depleted error as provider billing', () => {
    const message = '[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: [429 Too Many Requests] Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.';
    expect(classifyLlmMessage(message)).toBe('llm_provider_billing');
  });

  test('classifies provider auth failures', () => {
    const message = '[GoogleGenerativeAI Error]: HTTP 403 Forbidden - API key not valid. Please pass a valid API key.';
    expect(classifyLlmMessage(message)).toBe('llm_provider_auth');
  });

  test('classifies provider rate limit failures', () => {
    const message = '[GoogleGenerativeAI Error]: 429 Too Many Requests. Rate limit exceeded.';
    expect(classifyLlmMessage(message)).toBe('llm_rate_limit');
  });

  test('returns null for non-provider/internal errors', () => {
    expect(classifyLlmMessage('TypeError: Cannot read properties of undefined')).toBeNull();
  });
});
