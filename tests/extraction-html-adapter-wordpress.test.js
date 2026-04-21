const anchorAdapter = require('../src/agents/extraction/html-adapters/anchor-job-links');

describe('wordpress careers-ish extraction via anchor adapter', () => {
  test('extracts postings from wp anchors and json-ld jobposting graph', () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <meta name="generator" content="WordPress 6.8" />
        </head>
        <body>
          <section class="wp-block-group careers-list">
            <h2>Open roles</h2>
            <a href="/careers/senior-software-engineer">Senior Software Engineer</a>
            <a href="/careers/privacy">Privacy</a>
          </section>
          <script type="application/ld+json"><![CDATA[
          {
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "WebPage",
                "name": "Careers"
              },
              {
                "@type": "https://schema.org/JobPosting",
                "title": "Climate Data Analyst",
                "mainEntityOfPage": {
                  "@id": "https://jobs.example.com/careers/climate-data-analyst"
                },
                "description": "Analyze climate datasets and partner with product teams."
              }
            ]
          }
          ]]></script>
        </body>
      </html>
    `;

    const items = anchorAdapter.extract(html, 'https://jobs.example.com');
    const urls = items.map(i => i.url).sort();

    expect(items.length).toBe(2);
    expect(urls).toEqual([
      'https://jobs.example.com/careers/climate-data-analyst',
      'https://jobs.example.com/careers/senior-software-engineer'
    ]);
    expect(items.some(i => i.job_title && /Climate Data Analyst/.test(i.job_title))).toBe(true);
  });

  test('returns [] for wordpress landing pages with only bare listing links', () => {
    const html = `
      <!doctype html>
      <html>
        <body>
          wordpress wp-content
          <a href="/careers">Careers</a>
          <a href="/jobs">Jobs</a>
        </body>
      </html>
    `;
    expect(anchorAdapter.extract(html, 'https://example.com')).toEqual([]);
  });

  test('denies policy and nav links even under careers path', () => {
    const html = `
      <!doctype html>
      <html>
        <body>
          wordpress wp-content
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/contact">Contact</a>
          <a href="/careers/privacy-policy">Privacy Policy</a>
          <a href="/careers/terms-of-use">Terms of Use</a>
        </body>
      </html>
    `;
    expect(anchorAdapter.extract(html, 'https://example.com')).toEqual([]);
  });
});
