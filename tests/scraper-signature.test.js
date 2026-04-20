const { normalizeJobUrl, buildSignature, getAtsProviderListUrls } = require('../src/agents/scraper');
const { getStage } = require('../src/utils/pipeline-stages');

describe('Scraper signature helpers', () => {
  test('normalizeJobUrl strips query/hash, lowercases, trims trailing slash', () => {
    const url = 'https://Jobs.Example.com/Roles/123/?utm_source=x#section';
    expect(normalizeJobUrl(url)).toBe('https://jobs.example.com/roles/123');
  });

  test('buildSignature is deterministic and order-invariant', () => {
    const a = [
      'https://example.com/jobs/2/?a=1',
      'https://example.com/jobs/1/',
    ];
    const b = [
      'https://example.com/jobs/1',
      'https://example.com/jobs/2',
    ];
    expect(buildSignature(a).signature).toBe(buildSignature(b).signature);
  });

  test('extracts normalized urls from greenhouse list response', () => {
    const body = JSON.stringify({
      jobs: [
        { absolute_url: 'https://boards.greenhouse.io/company/jobs/123?gh_jid=123' },
        { absolute_url: 'https://boards.greenhouse.io/company/jobs/456/' },
      ],
    });
    const urls = getAtsProviderListUrls('greenhouse_api', body, {}, 'https://boards.greenhouse.io/company');
    expect(urls).toEqual([
      'https://boards.greenhouse.io/company/jobs/123',
      'https://boards.greenhouse.io/company/jobs/456',
    ]);
  });
});

describe('Pipeline stage routing', () => {
  test('signature-matched scrape skips extract stage', () => {
    const company = {
      careers_page_discovery_method: 'manual',
      careers_page_reachable: true,
      fingerprint_attempted_at: '2026-01-01T00:00:00.000Z',
      last_scraped_at: '2026-01-02T00:00:00.000Z',
      last_scrape_outcome: 'skipped_signature_match',
      climate_tech_category: 'Energy',
    };
    expect(getStage(company)).toBe('done');
  });
});
