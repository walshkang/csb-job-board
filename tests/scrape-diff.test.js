const { diffScrapeUrls } = require('../src/utils/scrape-diff');

describe('scrape diff helper', () => {
  test('classifies existing, net_new, removed URLs', () => {
    const prior = new Set(['https://jobs/A', 'https://jobs/B', 'https://jobs/C']);
    const current = new Set(['https://jobs/B', 'https://jobs/C', 'https://jobs/D']);
    const result = diffScrapeUrls({
      priorUrls: Array.from(prior),
      currentUrls: Array.from(current),
    });

    expect(Array.from(result.existing).sort()).toEqual(['https://jobs/B', 'https://jobs/C']);
    expect(Array.from(result.netNew).sort()).toEqual(['https://jobs/D']);
    expect(Array.from(result.removed).sort()).toEqual(['https://jobs/A']);
  });

  test('empty current marks all prior as removed', () => {
    const result = diffScrapeUrls({
      priorUrls: ['https://jobs/A'],
      currentUrls: [],
    });
    expect(Array.from(result.existing)).toEqual([]);
    expect(Array.from(result.netNew)).toEqual([]);
    expect(Array.from(result.removed)).toEqual(['https://jobs/A']);
  });
});
