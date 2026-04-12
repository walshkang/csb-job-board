const { mapGreenhouse, mapLever, normalizeExtractedItem, mergeJobs, runExtraction } = require('../src/agents/extraction');
const enricher = require('../src/agents/enricher');

describe('Extraction agent', () => {
  test('Greenhouse JSON maps to normalized schema', () => {
    const gh = { jobs: [ { id: '1', title: 'Eng', location: { name: 'NYC' }, absolute_url: 'https://gh.co/jobs/1', content: 'desc1' } ] };
    const items = mapGreenhouse(gh, { id: 'c1', name: 'Co' });
    expect(items.length).toBe(1);
    const n = normalizeExtractedItem(items[0], 'c1', 'Co', 'https://co.example');
    expect(n.company_id).toBe('c1');
    expect(n.job_title_raw).toBe('Eng');
    expect(n.source_url).toBe('https://gh.co/jobs/1');
    expect(n.description_raw).toBe('desc1');
    expect(n.description_hash).toBe(enricher.sha256('desc1'));
    expect(n.id).toBe(enricher.sha256('desc1' + '|' + 'https://gh.co/jobs/1'));
  });

  test('Lever JSON maps to normalized schema', () => {
    const lv = [ { id: 'a', text: 'Designer', categories: { location: 'SF' }, hostedUrl: '/jobs/a', descriptionPlain: 'd2' } ];
    const items = mapLever(lv, { id: 'c2', name: 'Co2' });
    expect(items.length).toBe(1);
    const n = normalizeExtractedItem(items[0], 'c2', 'Co2', 'https://co2.example');
    expect(n.company_id).toBe('c2');
    expect(n.job_title_raw).toBe('Designer');
    expect(n.source_url).toBe('https://co2.example/jobs/a');
    expect(n.description_raw).toBe('d2');
  });

  test('Dedup preserves existing first_seen_at when merging jobs with same source_url', () => {
    const now = new Date().toISOString();
    const old = [ { id: 'old', company_id: 'c', source_url: 'https://x', description_raw: 'olddesc', description_hash: enricher.sha256('olddesc'), first_seen_at: '2025-01-01T00:00:00.000Z', last_seen_at: '2025-01-02T00:00:00.000Z' } ];
    const newJob = { id: 'new', company_id: 'c', source_url: 'https://x', description_raw: 'newdesc', description_hash: enricher.sha256('newdesc'), first_seen_at: now, last_seen_at: now };
    const merged = mergeJobs(old, [newJob]);
    expect(merged.length).toBe(1);
    expect(merged[0].first_seen_at).toBe('2025-01-01T00:00:00.000Z');
  });

  test('Blocked HTML returns page_blocked', async () => {
    const html = '<html><body>CAPTCHA protected</body></html>';
    const res = await runExtraction({ html, company: 'X', baseUrl: 'https://x.example', callFn: async () => '[]' });
    expect(Array.isArray(res)).toBe(true);
    const blocked = await runExtraction({ html: '<div>please enable cookies</div>', company: 'X', baseUrl: 'https://x.example', callFn: async () => '[]' });
    expect(blocked[0] && blocked[0].error).toBe('page_blocked');
  });
});
