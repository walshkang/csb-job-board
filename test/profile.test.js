jest.mock('../src/utils/browser', () => ({
  fetchRenderedHtml: jest.fn(),
}));

const { fetchRenderedHtml } = require('../src/utils/browser');
const { profileCompany } = require('../src/agents/profile');

function thinBody() {
  return '<html><body><p>hi</p></body></html>';
}

/** Body filler so static HTML passes the 200-byte visible-text gate (meta in head does not count). */
function filler() {
  return `<p>${'x'.repeat(250)}</p>`;
}

describe('profileCompany', () => {
  beforeEach(() => {
    fetchRenderedHtml.mockReset();
    global.fetch = jest.fn();
  });

  test('description prefers /about over /about-us over /', async () => {
    const f = filler();
    const aboutHtml = `<html><head><meta name="description" content="About page meta"></head><body>${f}</body></html>`;
    const aboutUsHtml = `<html><head><meta name="description" content="About us meta"></head><body>${f}</body></html>`;
    const rootHtml = `<html><head><meta name="description" content="Home meta"></head><body>${f}</body></html>`;

    global.fetch.mockImplementation(url => {
      const u = String(url);
      let body = rootHtml;
      if (u.endsWith('/about') || u.includes('/about?')) body = aboutHtml;
      else if (u.includes('about-us')) body = aboutUsHtml;
      return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
    });

    const company = { id: 't1', domain: 'example.com', company_profile: { description: null } };
    await profileCompany(company, { timeoutMs: 1000 });

    expect(company.company_profile.description).toBe('About page meta');
    expect(company.profile_attempted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(fetchRenderedHtml).not.toHaveBeenCalled();
  });

  test('description falls back to first paragraph >80 chars in page order', async () => {
    const longP = `<p>${'word '.repeat(30)}</p>`;
    const f = filler();
    const aboutHtml = '<html><body><p>short</p></body></html>';
    const aboutUsHtml = `<html><body>${longP}${f}</body></html>`;
    const rootHtml = `<html><head><meta name="description" content="Should not win"></head><body>${f}</body></html>`;

    global.fetch.mockImplementation(url => {
      const u = String(url);
      if (u.endsWith('/about') || (u.includes('example.com/about') && !u.includes('about-us'))) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(aboutHtml) });
      }
      if (u.includes('about-us')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(aboutUsHtml) });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(rootHtml) });
    });

    const company = { id: 't2', domain: 'example.com', company_profile: {} };
    await profileCompany(company, { timeoutMs: 1000 });

    const desc = company.company_profile.description || '';
    expect(desc.length).toBeGreaterThan(80);
    expect(desc).not.toBe('Should not win');
  });

  test('does not overwrite existing non-empty description', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(
        `<html><head><meta name="description" content="New meta"></head><body>${filler()}</body></html>`
      ),
    });

    const company = {
      id: 't3',
      domain: 'keep.com',
      company_profile: { description: '  Original  ' },
    };
    await profileCompany(company, { timeoutMs: 1000 });

    expect(company.company_profile.description).toBe('  Original  ');
  });

  test('careers_hints: location and cross-page dedupe (first page wins)', async () => {
    const hintHtml = `
      <html><body>
        <header><a href="/careers">Careers</a></header>
        <footer><a href="/careers">Careers footer</a></footer>
        <a href="/jobs/list">Open roles</a>
        ${filler()}
      </body></html>`;

    global.fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(hintHtml),
    });

    const company = { id: 't4', domain: 'hints.test', company_profile: {} };
    await profileCompany(company, { timeoutMs: 1000 });

    const careers = company.careers_hints.filter(h => h.url.includes('/careers'));
    expect(careers.length).toBe(1);
    expect(careers[0].location).toBe('header');

    const jobs = company.careers_hints.find(h => h.url.includes('/jobs/list'));
    expect(jobs).toBeDefined();
    expect(jobs.location).toBe('body');
  });

  test('uses fetchRenderedHtml when all three static pages have <200 bytes visible text', async () => {
    const rich = `
      <html><body>
        <p>${'x'.repeat(250)}</p>
        <a href="/careers">Jobs</a>
      </body></html>`;

    global.fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(thinBody()),
    });
    fetchRenderedHtml.mockResolvedValue(rich);

    const company = { id: 't5', domain: 'render.test', company_profile: {} };
    await profileCompany(company, { timeoutMs: 1000 });

    expect(fetchRenderedHtml).toHaveBeenCalledTimes(3);
    expect(company.careers_hints.some(h => h.url.includes('/careers'))).toBe(true);
  });

  test('sets profile_attempted_at and empty careers_hints when no domain/url', async () => {
    const company = { id: 't6', company_profile: {} };
    await profileCompany(company, { timeoutMs: 1000 });

    expect(company.profile_attempted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(company.careers_hints).toEqual([]);
  });
});
