const anchorAdapter = require('../src/agents/extraction/html-adapters/anchor-job-links');
const { classifyShape, countJobLikeHrefs } = require('../src/agents/extraction/html-adapters/shared');

describe('other high-signal (>=3 job-like hrefs) dense listing extraction', () => {
  test('extracts posting URLs only from main cluster, not blog or nav', () => {
    const html = `<!doctype html><html><body>
      <nav>
        <a href="/opportunities/">Opportunities</a>
        <a href="/blog/hiring">Blog</a>
      </nav>
      <main>
        <section>
          <a href="/openings/backend-lead">Backend Lead</a>
          <a href="/positions/ux-researcher">UX Researcher</a>
          <a href="/opportunities/solutions-architect">Solutions Architect</a>
        </section>
      </main>
    </html>`;
    expect(classifyShape(html)).toBe('other');
    expect(countJobLikeHrefs(html)).toBeGreaterThanOrEqual(3);
    const items = anchorAdapter.extract(html, 'https://corp.example');
    const urls = items.map(i => i.url).sort();
    expect(urls).toEqual([
      'https://corp.example/openings/backend-lead',
      'https://corp.example/opportunities/solutions-architect',
      'https://corp.example/positions/ux-researcher'
    ]);
    expect(items.some(i => String(i.url).includes('/blog'))).toBe(false);
  });

  test('returns [] when >=3 job-like hrefs are only in footer/nav', () => {
    const html = `<!doctype html><html><body>
      <p>About us — no role list here.</p>
      <footer>
        <a href="/openings/a">A</a>
        <a href="/openings/b">B</a>
        <a href="/positions/c">C</a>
      </footer>
    </html>`;
    expect(classifyShape(html)).toBe('other');
    expect(countJobLikeHrefs(html)).toBeGreaterThanOrEqual(3);
    expect(anchorAdapter.extract(html, 'https://example.com')).toEqual([]);
  });
});
