const { mapCategory } = require('../src/agents/taxonomy-mapper');
const categorizer = require('../src/agents/categorizer');
const pitchbookTaxonomyLookup = require('../src/utils/pitchbook-taxonomy-lookup');
const llmClient = require('../src/llm-client');

jest.mock('../src/agents/categorizer');
jest.mock('../src/utils/pitchbook-taxonomy-lookup');
jest.mock('../src/llm-client');
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn((pathStr, encoding) => {
    if (pathStr.includes('categorizer-wrds.txt')) {
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
    'Tech Category Name': 'Wind',
    'Primary Sector': 'Electricity',
    'Related Opportunity Area': 'Low-Emissions Generation',
    'keywords': ['wind', 'turbine']
  }
];

describe('Taxonomy Mapper (Slice 4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pitchbookTaxonomyLookup.loadPitchbookTaxonomyMap.mockReturnValue({
      emerging_spaces: { 'CleanTech / Solar': 'Solar' }
    });
  });

  test('Lane 1: Fast deterministic match (Emerging Space)', async () => {
    const company = {
      id: 'test-1',
      name: 'Solar Corp',
      emerging_spaces: ['CleanTech / Solar']
    };

    pitchbookTaxonomyLookup.cascadeLookup.mockReturnValue({
      category: 'Solar',
      confidence: 'high',
      resolver: 'emerging_space'
    });

    await mapCategory(company, {}, mockTaxonomy, { dryRun: false });

    expect(company.climate_tech_category).toBe('Solar');
    expect(company.primary_sector).toBe('Electricity');
    expect(company.opportunity_area).toBe('Low-Emissions Generation');
    expect(company.category_confidence).toBe('high');
    expect(company.category_resolver).toBe('emerging_space');
    expect(company.category_source).toBe('wrds_fast');
    
    expect(llmClient.callLLM).not.toHaveBeenCalled();
    expect(categorizer.categorizeCompany).not.toHaveBeenCalled();
  });

  test('Lane 2: Medium match (LLM on API description)', async () => {
    const company = {
      id: 'test-2',
      name: 'Battery Corp',
      wrds_company_id: '123',
      pitchbook_description: 'A'.repeat(100), // length >= 80
      pitchbook_industry_code: 'Energy Storage',
      pitchbook_verticals: ['Renewable Energy']
    };

    pitchbookTaxonomyLookup.cascadeLookup.mockReturnValue({
      category: null,
      confidence: null,
      resolver: 'industry_code',
      climate_relevant_hint: true
    });

    llmClient.callLLM.mockResolvedValue(JSON.stringify({
      climate_tech_category: 'Wind', // mock return
      primary_sector: 'Electricity',
      opportunity_area: 'Low-Emissions Generation',
      category_confidence: 'medium'
    }));

    await mapCategory(company, {}, mockTaxonomy, { dryRun: false });

    expect(llmClient.callLLM).toHaveBeenCalled();
    expect(company.climate_tech_category).toBe('Wind');
    expect(company.category_resolver).toBe('llm_wrds');
    expect(company.category_source).toBe('wrds_medium');
    expect(categorizer.categorizeCompany).not.toHaveBeenCalled();
  });

  test('Lane 3: Cold fallback (no WRDS data)', async () => {
    const company = {
      id: 'test-3',
      name: 'Legacy Corp'
      // No wrds_company_id, no description
    };

    pitchbookTaxonomyLookup.cascadeLookup.mockReturnValue(null);

    await mapCategory(company, {}, mockTaxonomy, { dryRun: false });

    expect(llmClient.callLLM).not.toHaveBeenCalled(); // mapCategory shouldn't call it
    expect(categorizer.categorizeCompany).toHaveBeenCalled();
    expect(company.category_source).toBe('cold');
  });

  test('Lane 3: Cold fallback (WRDS data, but description too short)', async () => {
    const company = {
      id: 'test-4',
      name: 'Short Desc Corp',
      wrds_company_id: '456',
      pitchbook_description: 'Too short' // length < 80
    };

    pitchbookTaxonomyLookup.cascadeLookup.mockReturnValue(null);

    await mapCategory(company, {}, mockTaxonomy, { dryRun: false });

    expect(llmClient.callLLM).not.toHaveBeenCalled();
    expect(categorizer.categorizeCompany).toHaveBeenCalled();
    expect(company.category_source).toBe('cold');
  });
});
