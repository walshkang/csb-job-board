const { slugify, deterministicId, mergeCompanies, mapRowToCompanySchema } = require('../src/agents/ocr-utils');

describe('ocr-utils', () => {
  test('slugify turns names into URL-friendly slugs', () => {
    expect(slugify('ACME Inc.')).toBe('acme-inc');
    expect(slugify('  Foo & Bar Co ')).toBe('foo-bar-co');
  });

  test('deterministicId includes slug and hash', () => {
    const id = deterministicId('ACME Inc.');
    expect(id).toMatch(/^acme-inc-[0-9a-f]{10}$/);
  });

  test('mergeCompanies upserts by domain and id', () => {
    const existing = [
      { id: 'a-1', name: 'A', domain: 'a.com', funding_signals: [{raw:'seed'}], company_profile: {sector:'x'} }
    ];
    const extracted = [
      { id: 'a-1', name: 'A Ltd', domain: 'a.com', funding_signals: [{raw:'series-a'}], company_profile: {hq:'NY'} },
      { id: 'b-1', name: 'B', domain: 'b.com', funding_signals: [], company_profile: {} }
    ];
    const merged = mergeCompanies(existing, extracted);
    // a should be merged, not duplicated
    expect(merged.filter(c => c.domain === 'a.com').length).toBe(1);
    const a = merged.find(c => c.domain === 'a.com');
    expect(a.funding_signals.length).toBeGreaterThanOrEqual(1);
    // b should be added
    expect(merged.find(c => c.domain === 'b.com')).toBeDefined();
  });

  test('mapRowToCompanySchema maps simple row', () => {
    const row = { 'Company Name': 'Test Co', 'Website': 'https://test.co/', 'Funding': '$5M', 'Sector': 'Energy' };
    const mapped = mapRowToCompanySchema(row);
    expect(mapped.name).toBe('Test Co');
    expect(mapped.domain).toBe('test.co');
    expect(Array.isArray(mapped.funding_signals)).toBe(true);
    expect(mapped.company_profile.sector).toBe('Energy');
  });
});
