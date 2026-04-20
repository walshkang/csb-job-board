const { buildKeywordIndex, resolveByRule } = require('../src/agents/categorizer');

function companyWithKeywords(keywords) {
  return {
    id: 'c-test',
    name: 'TestCo',
    company_profile: { keywords },
  };
}

describe('categorizer rule pre-pass', () => {
  const taxonomy = [
    {
      'Tech Category Name': 'Wind',
      'Related Opportunity Area': 'Low-Emissions Generation',
      'Primary Sector': 'Electricity',
      keywords: ['offshore wind', 'wind turbines', 'wind power'],
    },
    {
      'Tech Category Name': 'Thermal',
      'Related Opportunity Area': 'Energy Storage & Demand Flexibility',
      'Primary Sector': 'Electricity',
      keywords: ['thermal energy storage', 'heat pumps'],
    },
  ];

  test('resolves with high confidence on unique winner', () => {
    const index = buildKeywordIndex(taxonomy);
    const result = resolveByRule(companyWithKeywords(['Wind Turbines', 'Offshore Wind']), index);
    expect(result).toBeTruthy();
    expect(result.category['Tech Category Name']).toBe('Wind');
    expect(result.confidence).toBe('high');
    expect(result.resolver).toBe('rule');
  });

  test('returns null on tie', () => {
    const index = buildKeywordIndex(taxonomy);
    const result = resolveByRule(companyWithKeywords(['wind power', 'heat pumps']), index);
    expect(result).toBeNull();
  });

  test('returns null when no keyword match', () => {
    const index = buildKeywordIndex(taxonomy);
    const result = resolveByRule(companyWithKeywords(['biofuel']), index);
    expect(result).toBeNull();
  });

  test('normalizes case and extra whitespace', () => {
    const index = buildKeywordIndex(taxonomy);
    const result = resolveByRule(companyWithKeywords(['  OFFSHORE   WIND  ']), index);
    expect(result).toBeTruthy();
    expect(result.category['Tech Category Name']).toBe('Wind');
  });

  test('deterministic across repeated runs', () => {
    const index = buildKeywordIndex(taxonomy);
    const company = companyWithKeywords(['OFFSHORE WIND', 'WIND TURBINES']);
    const first = resolveByRule(company, index);
    const second = resolveByRule(company, index);
    expect(first).toEqual(second);
  });
});
