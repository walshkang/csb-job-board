const { cascadeLookup } = require('../src/utils/pitchbook-taxonomy-lookup');

// Mock categorizer dependency since we only want to test the cascade logic
jest.mock('../src/agents/categorizer', () => ({
  resolveByRule: jest.fn(),
  buildKeywordIndex: jest.fn().mockReturnValue({})
}));

describe('pitchbook-taxonomy-lookup', () => {
  const mockPbMap = {
    emerging_spaces: {
      "CleanTech / Solar": "Solar",
      "AgTech / Precision Ag": "Precision Agriculture"
    },
    verticals: {
      "Renewable Energy": "Solar",
      "Carbon Capture & Storage": "Fossil Fuels with CCUS",
      "Climate Tech": null // Broad match
    },
    industry_codes: {
      "Wind": "Wind"
    },
    industry_groups: {
      "Energy Equipment & Services": null
    }
  };

  it('should match Emerging Space (Lane 1 step 1)', () => {
    const company = {
      emerging_spaces: ["CleanTech / Solar", "Some Other Tech"]
    };
    const result = cascadeLookup(company, mockPbMap);
    expect(result).toEqual({
      category: "Solar",
      confidence: "high",
      resolver: "emerging_space"
    });
  });

  it('should be case insensitive', () => {
    const company = {
      emerging_spaces: [" cleantech / solar "]
    };
    const result = cascadeLookup(company, mockPbMap);
    expect(result.category).toBe("Solar");
  });

  it('should fall back to Verticals if no Emerging Space match', () => {
    const company = {
      emerging_spaces: ["Unknown Tech"],
      pitchbook_verticals: ["Renewable Energy"]
    };
    const result = cascadeLookup(company, mockPbMap);
    expect(result).toEqual({
      category: "Solar",
      confidence: "high",
      resolver: "vertical"
    });
  });

  it('should fall back to Industry Code', () => {
    const company = {
      emerging_spaces: null,
      pitchbook_verticals: null,
      pitchbook_industry_code: "Wind"
    };
    const result = cascadeLookup(company, mockPbMap);
    expect(result).toEqual({
      category: "Wind",
      confidence: "medium",
      resolver: "industry_code"
    });
  });

  it('should return climate_relevant_hint for broad matches', () => {
    const company = {
      pitchbook_verticals: ["Climate Tech"] // Maps to null in our mock
    };
    const result = cascadeLookup(company, mockPbMap);
    expect(result).toEqual({
      category: null,
      confidence: null,
      resolver: "vertical",
      climate_relevant_hint: true
    });
  });

  it('should invoke resolveByRule as the final fallback', () => {
    const { resolveByRule } = require('../src/agents/categorizer');
    resolveByRule.mockReturnValue({
      category: { "Tech Category Name": "Biofuels" },
      confidence: "high",
      resolver: "rule"
    });

    const company = {
      pitchbook_keywords: ["biofuel", "green"]
    };
    
    const result = cascadeLookup(company, mockPbMap);
    
    expect(resolveByRule).toHaveBeenCalled();
    expect(result).toEqual({
      category: "Biofuels",
      confidence: "high",
      resolver: "rule"
    });
  });

  it('should return null if no matches at all', () => {
    const { resolveByRule } = require('../src/agents/categorizer');
    resolveByRule.mockReturnValue(null);

    const company = {
      emerging_spaces: ["Random"],
      pitchbook_verticals: ["Random"],
      pitchbook_industry_code: "Random",
      pitchbook_industry_group: "Random"
    };
    const result = cascadeLookup(company, mockPbMap);
    expect(result).toBeNull();
  });
});
