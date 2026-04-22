const { extractJobsFromAnchors } = require('../src/agents/extraction/html-adapters/shared');
const anchorAdapter = require('../src/agents/extraction/html-adapters/anchor-job-links');

describe('webflow top-miss shapes (collection DOM, detail paths, landmarks)', () => {
  const base = 'https://acme.com';

  test('extracts posting links from w-dyn-items row without w-dyn-item wrapper', () => {
    const html = `
      <!doctype html>
      <html><head><meta name="generator" content="Webflow" /></head>
      <body>
        <main>
          <section class="w-dyn-list">
            <div class="w-dyn-items">
              <div class="collection-row">
                <a href="/role/engineering-manager">Engineering Manager</a>
              </div>
            </div>
          </section>
        </main>
      </body></html>`;
    const items = extractJobsFromAnchors(html, base);
    const urls = items.map((i) => i.url).sort();
    expect(urls).toContain('https://acme.com/role/engineering-manager');
  });

  test('accepts /roles/, /job/, and multi-segment job paths inside collection list', () => {
    const html = `
      <!doctype html>
      <html><body data-wf-domain="x.webflow.io">
        <div class="w-dyn-list">
          <div class="w-dyn-item"><a href="/roles/analyst">Analyst</a></div>
          <div class="w-dyn-item"><a href="/job/backend-engineer">Backend</a></div>
          <div class="w-dyn-item"><a href="/postings/123-slug">Posting</a></div>
        </div>
      </body></html>`;
    const items = extractJobsFromAnchors(html, base);
    const urls = new Set(items.map((i) => i.url));
    expect(urls.has('https://acme.com/roles/analyst')).toBe(true);
    expect(urls.has('https://acme.com/job/backend-engineer')).toBe(true);
    expect(urls.has('https://acme.com/postings/123-slug')).toBe(true);
  });

  test('accepts kebab-case single-segment posting slug inside collection card', () => {
    const html = `
      <!doctype html>
      <html><body data-wf-domain="careers.acme.webflow.io">
        <ul class="w-dyn-list">
          <li class="w-dyn-item"><a href="/senior-product-designer">Senior Product Designer</a></li>
        </ul>
      </body></html>`;
    const items = extractJobsFromAnchors(html, base);
    expect(items.map((i) => i.url)).toContain('https://acme.com/senior-product-designer');
  });

  test('does not extract generic company/about/resources/contact even in main', () => {
    const html = `
      <!doctype html>
      <html><body data-wf-domain="x.webflow.io">
        <main class="w-dyn-list">
          <div class="w-dyn-item"><a href="/company">Company</a></div>
          <div class="w-dyn-item"><a href="/about-us">About</a></div>
          <div class="w-dyn-item"><a href="/resources/guides">Resources</a></div>
        </main>
      </body></html>`;
    const items = extractJobsFromAnchors(html, base);
    expect(items).toEqual([]);
  });

  test('suppresses links under role=banner and role=contentinfo', () => {
    const html = `
      <!doctype html>
      <html><body data-wf-domain="jobs.acme.webflow.io">
        <div role="banner">
          <a href="/careers/only-in-banner">Nav teaser</a>
          <a href="/resources">Resources</a>
        </div>
        <div class="w-dyn-list">
          <div class="w-dyn-item"><a href="/careers/real-opening">Real Opening</a></div>
        </div>
        <div role="contentinfo">
          <a href="/contact">Contact</a>
        </div>
      </body></html>`;
    const items = extractJobsFromAnchors(html, base);
    const urls = items.map((i) => i.url);
    expect(urls).toEqual(['https://acme.com/careers/real-opening']);
  });

  test('dedupes same URL across repeated collection rows', () => {
    const html = `
      <!doctype html>
      <html><body data-wf-domain="x.webflow.io">
        <div class="w-dyn-list">
          <div class="w-dyn-item"><a href="/job/same">Same A</a></div>
          <div class="w-dyn-item"><a href="/job/same">Same B</a></div>
        </div>
      </body></html>`;
    const items = extractJobsFromAnchors(html, base);
    expect(items.length).toBe(1);
    expect(items[0].url).toBe('https://acme.com/job/same');
  });

  test('anchor-job-links adapter match+extract on top-miss-style page', () => {
    const html = `
      <!doctype html>
      <html><head><meta name="generator" content="Webflow" /></head>
      <body>
        <div role="banner"><a href="/about">About</a></div>
        <section class="w-dyn-list">
          <div class="w-dyn-items"><a href="/role/data-scientist">Data Scientist</a></div>
        </section>
      </body></html>`;
    expect(anchorAdapter.match(html, base)).toBe(true);
    const items = anchorAdapter.extract(html, base);
    expect(items.length).toBe(1);
    expect(items[0].url).toBe('https://acme.com/role/data-scientist');
  });
});
