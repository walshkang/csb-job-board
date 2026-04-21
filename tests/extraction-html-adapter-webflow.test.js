const { extractJobsFromAnchors } = require('../src/agents/extraction/html-adapters/shared');
const anchorAdapter = require('../src/agents/extraction/html-adapters/anchor-job-links');

describe('webflow careers extraction', () => {
  test('extracts role card links, ignores nav/footer links, and dedupes repeated cards', () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <meta name="generator" content="Webflow" />
        </head>
        <body data-wf-domain="jobs.example.webflow.io">
          <header>
            <nav class="w-nav">
              <a href="/about">About</a>
              <a href="/resources">Resources</a>
            </nav>
          </header>

          <main>
            <section class="w-dyn-list">
              <div class="w-dyn-items">
                <article class="w-dyn-item">
                  <a href="/careers/software-engineer">Software Engineer</a>
                </article>
                <article class="w-dyn-item">
                  <a href="/careers/software-engineer">Software Engineer Duplicate</a>
                </article>
                <article class="w-dyn-item">
                  <a href="./careers/data-scientist#open-roles">Data Scientist</a>
                </article>
              </div>
            </section>
          </main>

          <footer>
            <a href="/contact">Contact</a>
          </footer>
        </body>
      </html>
    `;

    const items = extractJobsFromAnchors(html, 'https://acme.com/company');
    const urls = items.map((it) => it.url).sort();

    expect(urls).toEqual([
      'https://acme.com/careers/data-scientist#open-roles',
      'https://acme.com/careers/software-engineer',
    ]);
    expect(items.length).toBe(2);
    expect(items.some((it) => /software engineer/i.test(it.job_title))).toBe(true);
  });

  test('extracts section-anchored careers links from webflow cards via adapter', () => {
    const html = `
      <!doctype html>
      <html>
        <body data-wf-domain="team.example.webflow.io">
          <section class="w-dyn-list">
            <div class="w-dyn-item">
              <a href="/careers#product-designer">Product Designer</a>
            </div>
          </section>
        </body>
      </html>
    `;

    const items = anchorAdapter.extract(html, 'https://example.com');
    expect(items.length).toBe(1);
    expect(items[0].url).toBe('https://example.com/careers#product-designer');
    expect(items[0].job_title).toMatch(/Product Designer/i);
  });
});
