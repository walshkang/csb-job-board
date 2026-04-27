const fs = require('fs');
const path = require('path');
const { mapCategory } = require('../src/agents/taxonomy-mapper');
const categorizer = require('../src/agents/categorizer');
const pitchbookTaxonomyLookup = require('../src/utils/pitchbook-taxonomy-lookup');
const llmClient = require('../src/llm-client');

jest.mock('../src/agents/categorizer');
jest.mock('../src/llm-client');

jest.mock('../src/utils/pitchbook-taxonomy-lookup', () => {
  const original = jest.requireActual('../src/utils/pitchbook-taxonomy-lookup');
  return {
    ...original,
    loadPitchbookTaxonomyMap: jest.fn(() => ({
      emerging_spaces: {
        'CleanTech / Solar': 'Solar'
      },
      verticals: {},
      industry_codes: {},
      industry_groups: {},
      industry_sectors: {}
    }))
  };
});

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn((pathStr, encoding) => {
    if (pathStr.includes('categorizer-wrds.txt') || pathStr.includes('categorizer.txt')) {
      return 'Mock Prompt {categories_list}';
    }
    return jest.requireActual('fs').readFileSync(pathStr, encoding);
  }),
}));

const mockTaxonomy = [
  {
    'Tech Category Name': 'Solar',
    'Primary Sector': 'Electricity',
    'Related Opportunity Area': 'Low-Emissions Generation',
    'keywords': ['solar', 'photovoltaic']
  },
  {
    'Tech Category Name': 'Electrochemical',
    'Primary Sector': 'Electricity',
    'Related Opportunity Area': 'Energy Storage',
    'keywords': ['battery', 'storage']
  }
];

describe('Dual-Lane Integration (Slice 7)', () => {
  let companies;

  beforeAll(() => {
    const fixturePath = path.join(__dirname, 'fixtures', 'wrds-sample-companies.json');
    companies = JSON.parse(jest.requireActual('fs').readFileSync(fixturePath, 'utf8'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('E2E: Three-lane flow correct assignments', async () => {
    // Deep copy to prevent state leakage
    const solarCorp = JSON.parse(JSON.stringify(companies[0]));
    const batteryTech = JSON.parse(JSON.stringify(companies[1]));
    const legacyCorp = JSON.parse(JSON.stringify(companies[2]));

    // 1. Solar Corp -> Lane 1 (Fast)
    await mapCategory(solarCorp, {}, mockTaxonomy, { dryRun: false });
    expect(solarCorp.category_source).toBe('wrds_fast');
    expect(solarCorp.climate_tech_category).toBe('Solar');
    expect(solarCorp.category_resolver).toBe('emerging_space');
    expect(llmClient.callLLM).not.toHaveBeenCalled();
    expect(categorizer.categorizeCompany).not.toHaveBeenCalled();

    jest.clearAllMocks();

    // 2. Battery Tech -> Lane 2 (Medium) 
    llmClient.callLLM.mockResolvedValue(JSON.stringify({
      climate_tech_category: 'Electrochemical',
      primary_sector: 'Electricity',
      opportunity_area: 'Energy Storage',
      category_confidence: 'high'
    }));

    await mapCategory(batteryTech, {}, mockTaxonomy, { dryRun: false });
    expect(batteryTech.category_source).toBe('wrds_medium');
    expect(batteryTech.climate_tech_category).toBe('Electrochemical');
    expect(batteryTech.category_resolver).toBe('llm_wrds');
    expect(llmClient.callLLM).toHaveBeenCalled();
    expect(categorizer.categorizeCompany).not.toHaveBeenCalled();

    jest.clearAllMocks();

    // 3. Legacy Corp -> Lane 3 (Cold)
    await mapCategory(legacyCorp, {}, mockTaxonomy, { dryRun: false });
    expect(legacyCorp.category_source).toBe('cold');
    // It delegates to categorizer.categorizeCompany, which is mocked
    expect(llmClient.callLLM).not.toHaveBeenCalled(); 
    expect(categorizer.categorizeCompany).toHaveBeenCalled();
  });
});
