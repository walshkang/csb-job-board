const path = require('path');
const fs = require('fs');
const os = require('os');
const extraction = require('../src/agents/extraction');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'extract-test-'));
}

describe('extraction agent helpers', () => {
  test('normalizeEmploymentType returns allowed values or full_time fallback', () => {
    expect(extraction.normalizeEmploymentType('Full Time')).toBe('full_time');
    expect(extraction.normalizeEmploymentType('part-time')).toBe('part_time');
    expect(extraction.normalizeEmploymentType('Intern')).toBe('intern');
    expect(extraction.normalizeEmploymentType('Contract')).toBe('contract');
    expect(extraction.normalizeEmploymentType('Temporary')).toBe('full_time');
    expect(extraction.normalizeEmploymentType(null)).toBe('full_time');
  });

  test('extractJSONFromText handles code fences and trailing commas', () => {
    const input = "```json\n[{\"job_title\":\"A\", \"url\": \"/a\",},]\n```";
    const out = extraction.extractJSONFromText(input);
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].job_title).toBe('A');
  });

  test('runExtraction normalizes and resolves urls and preserves nulls when employment_type missing', async () => {
    const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.html'), 'utf8');
    const llmOutput = JSON.stringify([
      { job_title: 'Engineer', url: '/careers/eng', location: 'Remote', employment_type: null, description: 'Engineer role' },
      { job_title: 'Intern', url: 'https://example.com/jobs/1', location: ['NY', 'SF'], employment_type: 'intern', description: null }
    ]);
    const callFn = async () => llmOutput;
    const res = await extraction.runExtraction({ html, company: 'Example Co', baseUrl: 'https://example.com', callFn });
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBe(2);
    expect(res[0].url).toBe('https://example.com/careers/eng');
    expect(res[0].employment_type).toBeNull();
    expect(res[1].employment_type).toBe('intern');
    expect(res[1].location).toBe('NY | SF');
  });

  test('extractCompanyJobs sets html_extract_path json when JSON artifact used', async () => {
    const dir = tmpDir();
    try {
      const company = { id: 'acme-json', name: 'Acme', careers_page_url: 'https://acme.example' };
      const gh = { jobs: [{ title: 'Eng', absolute_url: 'https://gh.example/j/1', content: 'd' }] };
      fs.writeFileSync(path.join(dir, 'acme-json.json'), JSON.stringify(gh), 'utf8');
      const res = await extraction.extractCompanyJobs(company, { artifactsDir: dir, callFn: async () => '[]' });
      expect(res.html_extract_path).toBe('json');
      expect(res.html_adapter_name).toBeNull();
      expect(res.processed).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('extractCompanyJobs sets html_extract_path adapter when HTML adapter yields jobs', async () => {
    const dir = tmpDir();
    try {
      const company = { id: 'acme-html', name: 'Acme', careers_page_url: 'https://example.com' };
      const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.html'), 'utf8');
      fs.writeFileSync(path.join(dir, 'acme-html.html'), html, 'utf8');
      const res = await extraction.extractCompanyJobs(company, { artifactsDir: dir, callFn: async () => '[]' });
      expect(res.html_extract_path).toBe('adapter');
      expect(res.html_adapter_name).toBe('anchor-job-links');
      expect(res.processed).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('extractCompanyJobs sets html_extract_path llm when adapter empty, shape=other, and EXTRACTION_LLM_FALLBACK=1', async () => {
    const dir = tmpDir();
    const prev = process.env.EXTRACTION_LLM_FALLBACK;
    process.env.EXTRACTION_LLM_FALLBACK = '1';
    try {
      const company = { id: 'acme-llm', name: 'Acme', careers_page_url: 'https://example.com' };
      const html = '<html><body><p>static /jobs/one path text, no links</p></body></html>';
      fs.writeFileSync(path.join(dir, 'acme-llm.html'), html, 'utf8');
      const out = JSON.stringify([{ job_title: 'Role', url: '/jobs/one', description: 'x' }]);
      const res = await extraction.extractCompanyJobs(company, {
        artifactsDir: dir,
        callFn: async () => out,
      });
      expect(res.html_extract_path).toBe('llm');
      expect(res.html_adapter_name).toBeNull();
      expect(res.extract_failure_reason).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.EXTRACTION_LLM_FALLBACK;
      else process.env.EXTRACTION_LLM_FALLBACK = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('extractCompanyJobs: adapter empty + shape=other + flag off → adapter_empty (no LLM call)', async () => {
    const dir = tmpDir();
    const prev = process.env.EXTRACTION_LLM_FALLBACK;
    delete process.env.EXTRACTION_LLM_FALLBACK;
    try {
      const company = { id: 'acme-empty', name: 'Acme', careers_page_url: 'https://example.com' };
      const html = '<html><body><p>static /jobs/one path text, no links</p></body></html>';
      fs.writeFileSync(path.join(dir, 'acme-empty.html'), html, 'utf8');
      let llmCalled = false;
      const res = await extraction.extractCompanyJobs(company, {
        artifactsDir: dir,
        callFn: async () => { llmCalled = true; return '[]'; },
      });
      expect(llmCalled).toBe(false);
      expect(res.html_extract_path).toBe('adapter_empty');
      expect(res.extract_failure_reason).toBe('adapter_empty');
      expect(res.jobs).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.EXTRACTION_LLM_FALLBACK = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('extractCompanyJobs: adapter empty + known shape → adapter_empty even with flag on', async () => {
    const dir = tmpDir();
    const prev = process.env.EXTRACTION_LLM_FALLBACK;
    process.env.EXTRACTION_LLM_FALLBACK = '1';
    try {
      const company = { id: 'acme-shopify', name: 'Acme', careers_page_url: 'https://example.com' };
      // shopify shape marker but no job-like anchors → adapter returns empty
      const html = '<html><head><script src="https://cdn.shopify.com/s/assets/foo.js"></script></head><body><p>no links</p></body></html>';
      fs.writeFileSync(path.join(dir, 'acme-shopify.html'), html, 'utf8');
      let llmCalled = false;
      const res = await extraction.extractCompanyJobs(company, {
        artifactsDir: dir,
        callFn: async () => { llmCalled = true; return '[]'; },
      });
      expect(llmCalled).toBe(false);
      expect(res.html_extract_path).toBe('adapter_empty');
      expect(res.extract_failure_reason).toBe('adapter_empty');
    } finally {
      if (prev === undefined) delete process.env.EXTRACTION_LLM_FALLBACK;
      else process.env.EXTRACTION_LLM_FALLBACK = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('extractCompanyJobs sets html_extract_path xml_or_sitemap for XML artifact', async () => {
    const dir = tmpDir();
    try {
      const company = { id: 'acme-xml', name: 'Acme', careers_page_url: 'https://example.com' };
      fs.writeFileSync(
        path.join(dir, 'acme-xml.html'),
        '<?xml version="1.0"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n',
        'utf8'
      );
      const res = await extraction.extractCompanyJobs(company, { artifactsDir: dir, callFn: async () => '[]' });
      expect(res.html_extract_path).toBe('xml_or_sitemap');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
