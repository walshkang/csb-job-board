const anchorAdapter = require('../src/agents/extraction/html-adapters/anchor-job-links');

describe('wordpress top-miss regressions (anchor adapter)', () => {
  test('dedupes repeated same href in wp block list and cards', () => {
    const html = `
      <!doctype html>
      <html><body>
        wordpress wp-content
        <main>
        <ul class="wp-block-list">
          <li><a href="/careers/backend-engineer">Backend Engineer</a></li>
          <li><a href="/careers/backend-engineer">Backend Engineer</a></li>
          <li><a href="/careers/backend-engineer">Apply</a></li>
        </ul>
        <div class="wp-block-column">
          <a href="/careers/backend-engineer">Again</a>
        </div>
        </main>
      </body></html>
    `;
    const items = anchorAdapter.extract(html, 'https://example.com');
    expect(items.map(i => i.url)).toEqual(['https://example.com/careers/backend-engineer']);
    expect(items.length).toBe(1);
  });

  test('extracts JobPosting with http://schema.org/JobPosting @type', () => {
    const html = `
      <!doctype html>
      <html><body>
        wordpress wp-content
        <a href="/careers/a">A</a>
        <a href="/careers/b">B</a>
        <script type="application/ld+json">
        {"@context":"http://schema.org","@type":"http://schema.org/JobPosting","title":"Field Tech","url":"https://example.com/careers/field-tech"}
        </script>
      </body></html>
    `;
    const items = anchorAdapter.extract(html, 'https://example.com');
    expect(items.some(i => i.url === 'https://example.com/careers/field-tech' && /Field Tech/.test(i.job_title))).toBe(true);
  });

  test('extracts JobPosting URL from string identifier', () => {
    const html = `
      <!doctype html>
      <html><body>
        wordpress wp-content
        <a href="/careers/x">X</a>
        <a href="/careers/y">Y</a>
        <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"JobPosting","title":"Permitting Lead",
         "identifier":"https://example.com/careers/permitting-lead"}
        </script>
      </body></html>
    `;
    const items = anchorAdapter.extract(html, 'https://example.com');
    expect(items.some(i => i.url === 'https://example.com/careers/permitting-lead')).toBe(true);
  });

  test('extracts JobPosting URL from PropertyValue identifier', () => {
    const html = `
      <!doctype html>
      <html><body>
        wordpress wp-content
        <a href="/careers/1">1</a>
        <a href="/careers/2">2</a>
        <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"JobPosting","title":"Analyst",
         "identifier":{"@type":"PropertyValue","value":"https://example.com/careers/analyst"}}
        </script>
      </body></html>
    `;
    const items = anchorAdapter.extract(html, 'https://example.com');
    expect(items.some(i => i.url === 'https://example.com/careers/analyst')).toBe(true);
  });

  test('extracts JobPosting when url is object with @id path present in HTML', () => {
    const html = `
      <!doctype html>
      <html><body>
        wordpress wp-content
        <a href="/careers/ops">Ops</a>
        <a href="/careers/pm">PM</a>
        <a href="/careers/remote-qa">Remote QA</a>
        <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"JobPosting","title":"Remote QA",
         "url":{"@id":"/careers/remote-qa"}}
        </script>
      </body></html>
    `;
    const items = anchorAdapter.extract(html, 'https://example.com');
    expect(items.some(i => i.url === 'https://example.com/careers/remote-qa')).toBe(true);
  });

  test('merges two ld+json scripts and dedupes same posting URL', () => {
    const html = `
      <!doctype html>
      <html><body>
        wordpress wp-content
        <a href="/careers/one">One</a>
        <a href="/careers/two">Two</a>
        <script type="application/ld+json">{"@type":"JobPosting","title":"Designer","url":"https://example.com/careers/designer"}</script>
        <script type="application/ld+json">{"@type":"JobPosting","title":"Designer duplicate","url":"https://example.com/careers/designer"}</script>
      </body></html>
    `;
    const items = anchorAdapter.extract(html, 'https://example.com');
    const designer = items.filter(i => i.url === 'https://example.com/careers/designer');
    expect(designer.length).toBe(1);
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  test('accepts @type array that includes JobPosting among other types', () => {
    const html = `
      <!doctype html>
      <html><body>
        wordpress wp-content
        <a href="/careers/u">U</a>
        <a href="/careers/v">V</a>
        <script type="application/ld+json">
        {"@context":"https://schema.org","@type":["WebPage","JobPosting"],"name":"Posting","title":"PM","url":"https://example.com/careers/pm-role"}
        </script>
      </body></html>
    `;
    const items = anchorAdapter.extract(html, 'https://example.com');
    expect(items.some(i => i.url === 'https://example.com/careers/pm-role')).toBe(true);
  });

  test('denies /legal/privacy style paths', () => {
    const html = `
      <!doctype html>
      <html><body>
        wordpress wp-content
        <a href="/careers/a">A</a>
        <a href="/careers/b">B</a>
        <a href="/legal/privacy">Legal Privacy</a>
      </body></html>
    `;
    expect(anchorAdapter.extract(html, 'https://example.com').some(i => /privacy/i.test(i.url))).toBe(false);
  });

  test('merges anchor and JSON-LD for same URL without duplicate rows', () => {
    const html = `
      <!doctype html>
      <html><body>
        wordpress wp-content
        <a href="/careers/shared-slug">Shared Slug</a>
        <a href="/careers/other">Other</a>
        <script type="application/ld+json">
        {"@type":"JobPosting","title":"From JSON-LD","url":"https://example.com/careers/shared-slug"}
        </script>
      </body></html>
    `;
    const items = anchorAdapter.extract(html, 'https://example.com');
    const shared = items.filter(i => i.url === 'https://example.com/careers/shared-slug');
    expect(shared.length).toBe(1);
  });
});
