const wixAdapter = require('../src/agents/extraction/html-adapters/wix');

describe('wix html adapter', () => {
  test('detects wix fingerprints', () => {
    const html = `<!doctype html><html><head>
      <script src="https://static.wixstatic.com/media/app.js"></script>
    </head><body></body></html>`;
    expect(wixAdapter.match(html, 'https://example.com')).toBe(true);
  });

  test('extracts explicit posting anchors and dedupes canonical URL', () => {
    const html = `<!doctype html><html><head>
      <script src="https://static.wixstatic.com/media/app.js"></script>
    </head><body>
      <a href="/careers/software-engineer">Software Engineer</a>
      <a href="https://jobs.example.com/careers/software-engineer">Apply now</a>
      <a href="/careers/software-engineer">Duplicate</a>
    </body></html>`;
    const items = wixAdapter.extract(html, 'https://jobs.example.com');
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://jobs.example.com/careers/software-engineer');
    expect(items[0].job_title).toMatch(/Software Engineer|Apply now/i);
  });

  test('returns [] for bare listing or marketing links', () => {
    const html = `<!doctype html><html><head>
      <meta name="generator" content="Wix.com Website Builder" />
    </head><body>
      <a href="/careers">Careers</a>
      <a href="/about">About us</a>
      <a href="/privacy-policy">Privacy</a>
    </body></html>`;
    expect(wixAdapter.match(html, 'https://brand.example')).toBe(true);
    expect(wixAdapter.extract(html, 'https://brand.example')).toEqual([]);
  });

  test('extracts posting URLs from embedded JSON script blobs', () => {
    const html = `<!doctype html><html><head>
      <script src="https://static.wixstatic.com/media/app.js"></script>
      <script type="application/json">
        {"jobs":[{"title":"Data Engineer","jobUrl":"/positions/data-engineer"},{"name":"Ignored","url":"/careers"}]}
      </script>
    </head><body></body></html>`;
    const items = wixAdapter.extract(html, 'https://careers.brand.com');
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://careers.brand.com/positions/data-engineer');
    expect(items[0].job_title).toMatch(/Data Engineer/i);
  });
});
