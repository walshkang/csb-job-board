const { mergeJobs } = require('../src/agents/extraction');
const enricher = require('../src/agents/enricher');

describe('extraction removed_at semantics', () => {
  test('reappearing job clears removed_at and bumps last_seen_at', () => {
    const existing = [{
      id: 'j-1',
      company_id: 'c-1',
      source_url: 'https://jobs.example/1',
      description_raw: 'desc-1',
      description_hash: enricher.sha256('desc-1'),
      first_seen_at: '2026-01-01T00:00:00.000Z',
      last_seen_at: '2026-01-02T00:00:00.000Z',
      removed_at: '2026-01-03T00:00:00.000Z',
    }];
    const incoming = [{
      id: 'j-1-new',
      company_id: 'c-1',
      source_url: 'https://jobs.example/1',
      description_raw: 'desc-1',
      description_hash: enricher.sha256('desc-1'),
      first_seen_at: '2026-01-04T00:00:00.000Z',
      last_seen_at: '2026-01-04T00:00:00.000Z',
    }];

    const merged = mergeJobs(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].removed_at).toBeUndefined();
    expect(merged[0].last_seen_at).not.toBe('2026-01-02T00:00:00.000Z');
  });
});
