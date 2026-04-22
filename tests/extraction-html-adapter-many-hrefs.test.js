const anchorAdapter = require('../src/agents/extraction/html-adapters/anchor-job-links');
const { classifyShape } = require('../src/agents/extraction/html-adapters/shared');

describe('many-career-path-hrefs dense listing extraction', () => {
  test('extracts explicit posting URLs from main content cluster', () => {
    const html = `<!doctype html><html><body>
      <nav><a href="/careers">Careers</a></nav>
      <main>
        <h1>Open roles</h1>
        <ul class="roles">
          <li><a href="/careers/senior-engineer">Senior Engineer</a></li>
          <li><a href="/careers/product-manager">Product Manager</a></li>
          <li><a href="/jobs/analyst">Analyst</a></li>
          <li><a href="/careers/staff-designer">Staff Designer</a></li>
        </ul>
      </main>
    </html>`;
    expect(classifyShape(html)).toBe('many-career-path-hrefs');
    const items = anchorAdapter.extract(html, 'https://example.com');
    const urls = items.map(i => i.url).sort();
    expect(urls).toEqual([
      'https://example.com/careers/product-manager',
      'https://example.com/careers/senior-engineer',
      'https://example.com/careers/staff-designer',
      'https://example.com/jobs/analyst'
    ]);
    expect(items.every(i => !String(i.url).includes('/privacy') && !String(i.url).includes('/terms'))).toBe(true);
  });

  test('returns [] when job-like hrefs live only in nav chrome', () => {
    const html = `<!doctype html><html><body>
      <header>
        <nav>
          <a href="/careers/one">One</a>
          <a href="/careers/two">Two</a>
          <a href="/jobs/three">Three</a>
          <a href="/careers/four">Four</a>
        </nav>
      </header>
      <p>No listings in main content.</p>
    </html>`;
    expect(classifyShape(html)).toBe('many-career-path-hrefs');
    expect(anchorAdapter.extract(html, 'https://example.com')).toEqual([]);
  });

  test('returns [] for bare listing and policy links only', () => {
    const html = `<!doctype html><html><body>
      <main>
        <ul>
          <li><a href="/careers">Careers</a></li>
          <li><a href="/jobs">Jobs</a></li>
          <li><a href="/careers/privacy-policy">Privacy</a></li>
          <li><a href="/careers/terms-of-use">Terms</a></li>
        </ul>
      </main>
    </html>`;
    expect(classifyShape(html)).toBe('many-career-path-hrefs');
    expect(anchorAdapter.extract(html, 'https://example.com')).toEqual([]);
  });
});
