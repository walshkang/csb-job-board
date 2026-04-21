jest.mock('../src/llm-client', () => ({
  callLLM: jest.fn(),
}));

const { callLLM } = require('../src/llm-client');
const { batchCategorize, BATCH_MAX } = require('../src/agents/categorizer');

function mkEntry(id) {
  return {
    company: {
      id,
      name: `Company ${id}`,
      company_profile: {
        description: `Description for ${id}`,
        keywords: ['solar', 'storage'],
      },
    },
    rep: {
      job_title_normalized: 'Energy Analyst',
      job_function: 'Operations',
      description_summary: 'Works on energy systems',
    },
  };
}

describe('batchCategorize', () => {
  const taxonomy = [
    { 'Tech Category Name': 'Solar PV', 'Primary Sector': 'Electricity', 'Related Opportunity Area': 'Low-Emissions Generation', keywords: ['solar'] },
    { 'Tech Category Name': 'Storage', 'Primary Sector': 'Electricity', 'Related Opportunity Area': 'Energy Storage & Demand Flexibility', keywords: ['battery'] },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns mapped results for 5 companies', async () => {
    const entries = ['c1', 'c2', 'c3', 'c4', 'c5'].map(mkEntry);
    callLLM.mockResolvedValueOnce(JSON.stringify({
      results: entries.map((e, i) => ({
        company_id: e.company.id,
        category: 'Solar PV',
        confidence: 0.9 - i * 0.1,
        reason: 'keyword match',
      })),
    }));

    const map = await batchCategorize(entries, taxonomy, { provider: 'anthropic', apiKey: 'x', model: 'y' });
    expect(map.size).toBe(5);
    expect(map.get('c1')).toEqual({ category: 'Solar PV', confidence: 0.9, reason: 'keyword match' });
    expect(map.get('c5')).toEqual({ category: 'Solar PV', confidence: 0.5, reason: 'keyword match' });
  });

  test('marks missing company_id results as per-company failure', async () => {
    const entries = ['c1', 'c2', 'c3', 'c4', 'c5'].map(mkEntry);
    callLLM.mockResolvedValueOnce(JSON.stringify({
      results: entries
        .filter((e) => e.company.id !== 'c3')
        .map((e) => ({ company_id: e.company.id, category: 'Solar PV', confidence: 0.7, reason: 'ok' })),
    }));

    const map = await batchCategorize(entries, taxonomy, { provider: 'anthropic', apiKey: 'x', model: 'y' });
    expect(map.get('c3')).toEqual({ error: 'missing_result' });
    expect(map.get('c1')).toEqual({ category: 'Solar PV', confidence: 0.7, reason: 'ok' });
  });

  test('throws on malformed json', async () => {
    const entries = ['c1', 'c2'].map(mkEntry);
    callLLM.mockResolvedValueOnce('not-json');

    await expect(batchCategorize(entries, taxonomy, { provider: 'anthropic', apiKey: 'x', model: 'y' }))
      .rejects
      .toThrow(/JSON parse failed/);
  });

  test('throws when called with more than BATCH_MAX entries', async () => {
    const entries = Array.from({ length: BATCH_MAX + 1 }, (_, i) => mkEntry(`c${i + 1}`));
    await expect(batchCategorize(entries, taxonomy, { provider: 'anthropic', apiKey: 'x', model: 'y' }))
      .rejects
      .toThrow(/at most/);
    expect(callLLM).not.toHaveBeenCalled();
  });
});
