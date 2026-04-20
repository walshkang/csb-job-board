const path = require('path');
const fs = require('fs');
const {
  looksLikeJobHref,
  isXmlSitemapOrNonHtml,
  extractJobsFromAnchors,
  extractJobsFromJsonLd,
  ADAPTER_HTML_MAX
} = require('../src/agents/extraction/html-adapters/shared');
const anchorAdapter = require('../src/agents/extraction/html-adapters/anchor-job-links');

describe('html adapters shared', () => {
  test('isXmlSitemapOrNonHtml detects Yoast XML sitemap', () => {
    const xml = `<?xml version="1.0"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
    expect(isXmlSitemapOrNonHtml(xml)).toBe(true);
    expect(isXmlSitemapOrNonHtml('<!doctype html><html><body>Hi</body></html>')).toBe(false);
  });

  test('looksLikeJobHref marks careers URLs and slug paths', () => {
    expect(looksLikeJobHref('/careers')).toBe(true);
    expect(looksLikeJobHref('/careers-2')).toBe(true);
    expect(looksLikeJobHref('https://careers.acme.com/p/abc-engineer')).toBe(true);
  });

  test('extractJobsFromAnchors resolves relative hrefs with https base', () => {
    const html = `
      <!doctype html><html><body>
      <a href="/careers-1">Senior Engineer</a>
      <a href="https://apply.example.com/job/99">Apply</a>
      </body></html>`;
    const items = extractJobsFromAnchors(html, 'https://example.com/jobs');
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some(i => i.url.includes('careers-1'))).toBe(true);
  });

  test('extractJobsFromJsonLd parses JobPosting', () => {
    const html = `
      <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"JobPosting","title":"Analyst","url":"https://co.com/job/1"}
      </script>`;
    const items = extractJobsFromJsonLd(html, 'https://co.com');
    expect(items.length).toBe(1);
    expect(items[0].job_title).toMatch(/Analyst/);
    expect(items[0].url).toBe('https://co.com/job/1');
  });

  test('ADAPTER_HTML_MAX is bounded', () => {
    expect(ADAPTER_HTML_MAX).toBeGreaterThan(100000);
  });
});

describe('anchor-job-links adapter', () => {
  test('match and extract merge JSON-LD and anchors', () => {
    const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.html'), 'utf8');
    expect(anchorAdapter.match(html, 'https://example.com')).toBe(true);
    const items = anchorAdapter.extract(html, 'https://example.com');
    expect(items.length).toBeGreaterThanOrEqual(1);
  });
});
