/**
 * Tests for WRDS Ingest Agent (Slice 3)
 *
 * All WRDS connectivity is mocked — tests validate:
 *   - Row-to-schema mapping (field parsing, domain normalization, delimiter split)
 *   - High-water mark computation
 *   - Merge logic (dedup by domain, update vs add, field preservation)
 *   - Dry-run produces no file writes
 *   - --full flag ignores high-water mark
 *   - Missing credentials skip gracefully
 */

// Mock wrds-pool before requiring the agent
jest.mock('../src/utils/wrds-pool', () => ({
  connect: jest.fn().mockResolvedValue(),
  query: jest.fn().mockResolvedValue({ rows: [] }),
  close: jest.fn().mockResolvedValue(),
}));

// Mock config with test credentials
jest.mock('../src/config', () => ({
  wrds: {
    sshHost: 'ssh.test',
    sshPort: 22,
    pgHost: 'pg.test',
    pgPort: 9737,
    username: 'testuser',
    password: 'testpass',
    database: 'wrds',
    schema: 'pitchbk',
    table: 'company',
  },
}));

// Mock file I/O via ocr-utils
jest.mock('../src/agents/ocr-utils', () => ({
  slugify: jest.fn(str =>
    str.toString().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[-\s]+/g, '-')
  ),
  deterministicId: jest.fn(str => `det-${str.toLowerCase().replace(/\s+/g, '-')}`),
  loadExistingCompanies: jest.fn().mockResolvedValue([]),
  saveCompanies: jest.fn().mockResolvedValue(),
}));

const wrdsPool = require('../src/utils/wrds-pool');
const ocrUtils = require('../src/agents/ocr-utils');
const {
  run,
  splitDelimited,
  normalizeDomain,
  computeHighWaterMark,
  mapRowToCompanyFields,
  mergeWrdsRecords,
  COLUMNS,
} = require('../src/agents/wrds-ingest');

// ---------------------------------------------------------------------------
// Unit tests: helpers
// ---------------------------------------------------------------------------

describe('splitDelimited', () => {
  it('splits comma-separated values', () => {
    expect(splitDelimited('Solar, Wind, Battery')).toEqual(['Solar', 'Wind', 'Battery']);
  });

  it('splits pipe-separated values', () => {
    expect(splitDelimited('Solar|Wind|Battery')).toEqual(['Solar', 'Wind', 'Battery']);
  });

  it('splits semicolon-separated values', () => {
    expect(splitDelimited('Solar;Wind;Battery')).toEqual(['Solar', 'Wind', 'Battery']);
  });

  it('handles mixed delimiters', () => {
    expect(splitDelimited('Solar, Wind|Battery;Fuel Cells')).toEqual([
      'Solar', 'Wind', 'Battery', 'Fuel Cells',
    ]);
  });

  it('trims whitespace', () => {
    expect(splitDelimited('  Solar , Wind  ')).toEqual(['Solar', 'Wind']);
  });

  it('returns null for empty/null input', () => {
    expect(splitDelimited(null)).toBeNull();
    expect(splitDelimited('')).toBeNull();
    expect(splitDelimited('   ')).toBeNull();
  });

  it('returns null for only-delimiter input', () => {
    expect(splitDelimited(',,,;')).toBeNull();
  });
});

describe('normalizeDomain', () => {
  it('strips http protocol', () => {
    expect(normalizeDomain('http://www.example.com')).toBe('www.example.com');
  });

  it('strips https protocol', () => {
    expect(normalizeDomain('https://example.com')).toBe('example.com');
  });

  it('strips trailing path', () => {
    expect(normalizeDomain('https://www.example.com/about')).toBe('www.example.com');
  });

  it('strips query string and fragment', () => {
    expect(normalizeDomain('https://example.com?foo=1#bar')).toBe('example.com');
  });

  it('handles bare domain', () => {
    expect(normalizeDomain('example.com')).toBe('example.com');
  });

  it('returns null for falsy input', () => {
    expect(normalizeDomain(null)).toBeNull();
    expect(normalizeDomain('')).toBeNull();
  });
});

describe('computeHighWaterMark', () => {
  it('returns epoch when no companies have wrds_last_updated', () => {
    expect(computeHighWaterMark([{ id: 'a' }, { id: 'b' }])).toBe('1970-01-01');
  });

  it('returns the latest wrds_last_updated', () => {
    const companies = [
      { id: 'a', wrds_last_updated: '2026-01-01T00:00:00.000Z' },
      { id: 'b', wrds_last_updated: '2026-04-15T00:00:00.000Z' },
      { id: 'c', wrds_last_updated: '2026-03-01T00:00:00.000Z' },
    ];
    expect(computeHighWaterMark(companies)).toBe('2026-04-15T00:00:00.000Z');
  });

  it('ignores companies without wrds_last_updated', () => {
    const companies = [
      { id: 'a' },
      { id: 'b', wrds_last_updated: '2026-02-01T00:00:00.000Z' },
    ];
    expect(computeHighWaterMark(companies)).toBe('2026-02-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: mapRowToCompanyFields
// ---------------------------------------------------------------------------

describe('mapRowToCompanyFields', () => {
  const sampleRow = {
    companyid: 'PB123456',
    companyname: 'SolarCorp',
    website: 'https://www.solarcorp.com/about',
    description: 'A leading solar technology company.',
    descriptionshort: 'Solar tech.',
    keywords: 'solar, renewable energy, panels',
    emergingspaces: 'CleanTech / Solar, Climate Tech',
    verticals: 'Renewable Energy',
    allindustries: 'Solar, Clean Technology',
    primaryindustrycode: 'Solar',
    primaryindustrygroup: 'Energy Equipment & Services',
    primaryindustrysector: 'Energy',
    employees: 150,
    hqlocation: 'San Francisco, CA',
    hqcity: 'San Francisco',
    hqstate_province: 'CA',
    hqcountry: 'United States',
    yearfounded: 2020,
    totalraised: 25.5,
    ownershipstatus: 'Privately Held (backing)',
    lastfinancingdate: '2026-01-15',
    lastfinancingsize: 10.0,
    lastfinancingdealtype: 'Series A',
    lastupdated: '2026-04-20T00:00:00Z',
  };

  it('maps all WRDS fields correctly', () => {
    const result = mapRowToCompanyFields(sampleRow);

    expect(result.wrds_company_id).toBe('PB123456');
    expect(result.name).toBe('SolarCorp');
    expect(result.domain).toBe('www.solarcorp.com');
    expect(result.pitchbook_description).toBe('A leading solar technology company.');
    expect(result.pitchbook_industry_code).toBe('Solar');
    expect(result.pitchbook_industry_group).toBe('Energy Equipment & Services');
    expect(result.pitchbook_industry_sector).toBe('Energy');
  });

  it('parses comma-separated emerging_spaces into array', () => {
    const result = mapRowToCompanyFields(sampleRow);
    expect(result.emerging_spaces).toEqual(['CleanTech / Solar', 'Climate Tech']);
  });

  it('parses verticals into array', () => {
    const result = mapRowToCompanyFields(sampleRow);
    expect(result.pitchbook_verticals).toEqual(['Renewable Energy']);
  });

  it('parses keywords into array', () => {
    const result = mapRowToCompanyFields(sampleRow);
    expect(result.pitchbook_keywords).toEqual(['solar', 'renewable energy', 'panels']);
  });

  it('builds funding_signals from last financing data', () => {
    const result = mapRowToCompanyFields(sampleRow);
    expect(result.funding_signals).toHaveLength(1);
    expect(result.funding_signals[0]).toEqual({
      date: '2026-01-15',
      deal_type: 'Series A',
      size_mm: 10.0,
      total_raised_mm: 25.5,
    });
  });

  it('builds HQ from structured fields', () => {
    const result = mapRowToCompanyFields(sampleRow);
    expect(result.company_profile.hq).toBe('San Francisco, CA, United States');
  });

  it('falls back to hqlocation when structured fields are empty', () => {
    const row = { ...sampleRow, hqcity: null, hqstate_province: null, hqcountry: null };
    const result = mapRowToCompanyFields(row);
    expect(result.company_profile.hq).toBe('San Francisco, CA');
  });

  it('converts lastupdated to ISO string', () => {
    const result = mapRowToCompanyFields(sampleRow);
    expect(result.wrds_last_updated).toBe('2026-04-20T00:00:00.000Z');
  });

  it('handles missing optional fields gracefully', () => {
    const minRow = { companyname: 'MinCo', lastupdated: null };
    const result = mapRowToCompanyFields(minRow);
    expect(result.name).toBe('MinCo');
    expect(result.domain).toBeNull();
    expect(result.emerging_spaces).toBeNull();
    expect(result.pitchbook_description).toBeNull();
    expect(result.wrds_last_updated).toBeNull();
    expect(result.funding_signals).toEqual([]);
  });

  it('generates id from domain when available', () => {
    const result = mapRowToCompanyFields(sampleRow);
    expect(result.id).toBe('wwwsolarcorpcom');
  });

  it('generates deterministic id from name when no domain', () => {
    const row = { ...sampleRow, website: null };
    const result = mapRowToCompanyFields(row);
    expect(result.id).toBe('det-solarcorp');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: mergeWrdsRecords
// ---------------------------------------------------------------------------

describe('mergeWrdsRecords', () => {
  it('adds new companies', () => {
    const existing = [{ id: 'a', domain: 'a.com', name: 'A' }];
    const incoming = [{ id: 'b', domain: 'b.com', name: 'B', wrds_company_id: 'PB1' }];
    const { merged, added, updated } = mergeWrdsRecords(existing, incoming);

    expect(merged).toHaveLength(2);
    expect(added).toBe(1);
    expect(updated).toBe(0);
  });

  it('updates existing companies by domain match', () => {
    const existing = [{ id: 'a', domain: 'a.com', name: 'A', wrds_company_id: null }];
    const incoming = [{
      id: 'different-id', domain: 'a.com', name: 'A New',
      wrds_company_id: 'PB1',
      emerging_spaces: ['Solar'],
      pitchbook_description: 'A solar company.',
      company_profile: { description: 'A solar company.' },
    }];
    const { merged, added, updated } = mergeWrdsRecords(existing, incoming);

    expect(merged).toHaveLength(1);
    expect(added).toBe(0);
    expect(updated).toBe(1);
    expect(merged[0].wrds_company_id).toBe('PB1');
    expect(merged[0].emerging_spaces).toEqual(['Solar']);
    expect(merged[0].id).toBe('a'); // Original id preserved
    expect(merged[0].name).toBe('A'); // Existing name preserved
  });

  it('does not overwrite existing non-null company_profile fields', () => {
    const existing = [{
      id: 'a', domain: 'a.com', name: 'A',
      company_profile: { description: 'Original desc', hq: 'NYC', employees: 100 },
    }];
    const incoming = [{
      id: 'a', domain: 'a.com', name: 'A',
      wrds_company_id: 'PB1',
      company_profile: { description: 'WRDS desc', hq: 'SF', employees: 50, year_founded: 2020 },
    }];
    const { merged } = mergeWrdsRecords(existing, incoming);

    // Existing non-null fields preserved; new field added
    expect(merged[0].company_profile.description).toBe('Original desc');
    expect(merged[0].company_profile.hq).toBe('NYC');
    expect(merged[0].company_profile.employees).toBe(100);
    expect(merged[0].company_profile.year_founded).toBe(2020); // New field added
  });

  it('deduplicates funding signals by date+deal_type', () => {
    const existing = [{
      id: 'a', domain: 'a.com', name: 'A',
      funding_signals: [{ date: '2026-01-01', deal_type: 'Seed', size_mm: 5 }],
    }];
    const incoming = [{
      id: 'a', domain: 'a.com', name: 'A',
      wrds_company_id: 'PB1',
      funding_signals: [
        { date: '2026-01-01', deal_type: 'Seed', size_mm: 5 }, // Duplicate
        { date: '2026-03-01', deal_type: 'Series A', size_mm: 10 }, // New
      ],
    }];
    const { merged } = mergeWrdsRecords(existing, incoming);

    expect(merged[0].funding_signals).toHaveLength(2);
  });

  it('handles case-insensitive domain matching', () => {
    const existing = [{ id: 'a', domain: 'Example.COM', name: 'A' }];
    const incoming = [{
      id: 'b', domain: 'example.com', name: 'B', wrds_company_id: 'PB1',
    }];
    const { merged, updated } = mergeWrdsRecords(existing, incoming);

    expect(merged).toHaveLength(1);
    expect(updated).toBe(1);
    expect(merged[0].wrds_company_id).toBe('PB1');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: run()
// ---------------------------------------------------------------------------

describe('run()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ocrUtils.loadExistingCompanies.mockResolvedValue([]);
    ocrUtils.saveCompanies.mockResolvedValue();
    wrdsPool.connect.mockResolvedValue();
    wrdsPool.close.mockResolvedValue();
    wrdsPool.query.mockResolvedValue({ rows: [] });
  });

  it('skips when credentials are missing', async () => {
    // Temporarily override config
    const config = require('../src/config');
    const origUser = config.wrds.username;
    config.wrds.username = null;

    const result = await run();
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_credentials');
    expect(wrdsPool.connect).not.toHaveBeenCalled();

    config.wrds.username = origUser;
  });

  it('queries with high-water mark from existing companies', async () => {
    ocrUtils.loadExistingCompanies.mockResolvedValue([
      { id: 'a', wrds_last_updated: '2026-03-01T00:00:00.000Z' },
    ]);

    await run();

    expect(wrdsPool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = wrdsPool.query.mock.calls[0];
    expect(sql).toContain('WHERE lastupdated > $1');
    expect(params).toEqual(['2026-03-01T00:00:00.000Z']);
  });

  it('uses epoch when --full is set', async () => {
    ocrUtils.loadExistingCompanies.mockResolvedValue([
      { id: 'a', wrds_last_updated: '2026-03-01T00:00:00.000Z' },
    ]);

    await run({ full: true });

    const [, params] = wrdsPool.query.mock.calls[0];
    expect(params).toEqual(['1970-01-01']);
  });

  it('does not write files on dry run', async () => {
    wrdsPool.query.mockResolvedValue({
      rows: [{
        companyid: 'PB1', companyname: 'Test Co', website: 'https://test.com',
        description: 'A test company', lastupdated: '2026-04-20T00:00:00Z',
      }],
    });

    const result = await run({ dryRun: true });

    expect(ocrUtils.saveCompanies).not.toHaveBeenCalled();
    expect(result.fetched).toBe(1);
  });

  it('writes merged companies on successful ingest', async () => {
    wrdsPool.query.mockResolvedValue({
      rows: [{
        companyid: 'PB1', companyname: 'Test Co', website: 'https://test.com',
        description: 'A test company', lastupdated: '2026-04-20T00:00:00Z',
      }],
    });

    const result = await run();

    expect(ocrUtils.saveCompanies).toHaveBeenCalledTimes(1);
    expect(result.fetched).toBe(1);
    expect(result.added).toBe(1);
  });

  it('paginates through multiple pages', async () => {
    // First call: 500 rows (full page)
    const page1Rows = Array.from({ length: 500 }, (_, i) => ({
      companyid: `PB${i}`,
      companyname: `Company ${i}`,
      website: `https://company${i}.com`,
      lastupdated: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z`,
    }));
    // Second call: 100 rows (partial page = done)
    const page2Rows = Array.from({ length: 100 }, (_, i) => ({
      companyid: `PB${500 + i}`,
      companyname: `Company ${500 + i}`,
      website: `https://company${500 + i}.com`,
      lastupdated: `2026-02-01T00:${String(i % 60).padStart(2, '0')}:00Z`,
    }));

    wrdsPool.query
      .mockResolvedValueOnce({ rows: page1Rows })
      .mockResolvedValueOnce({ rows: page2Rows });

    const result = await run();

    expect(wrdsPool.query).toHaveBeenCalledTimes(2);
    expect(result.fetched).toBe(600);
    expect(result.added).toBe(600);
  });

  it('closes connection even on query error', async () => {
    wrdsPool.query.mockRejectedValue(new Error('timeout'));

    await expect(run()).rejects.toThrow('timeout');

    expect(wrdsPool.close).toHaveBeenCalledTimes(1);
  });

  it('handles connection failure gracefully', async () => {
    wrdsPool.connect.mockRejectedValue(new Error('SSH failed'));

    const result = await run();

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('connection_failed');
  });

  it('returns zeroes when no new records', async () => {
    wrdsPool.query.mockResolvedValue({ rows: [] });

    const result = await run();

    expect(result.fetched).toBe(0);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(ocrUtils.saveCompanies).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Verify COLUMNS constant
// ---------------------------------------------------------------------------

describe('COLUMNS', () => {
  it('includes all required fields from the architecture spec', () => {
    const required = [
      'companyid', 'companyname', 'website', 'description',
      'emergingspaces', 'verticals', 'primaryindustrycode',
      'primaryindustrygroup', 'primaryindustrysector',
      'employees', 'lastupdated', 'keywords',
    ];
    for (const col of required) {
      expect(COLUMNS).toContain(col);
    }
  });

  it('includes high-water mark column', () => {
    expect(COLUMNS).toContain('lastupdated');
  });
});
