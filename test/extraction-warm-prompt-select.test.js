const path = require('path');
const fs = require('fs');
const os = require('os');
const extraction = require('../src/agents/extraction');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'extract-warm-test-'));
}

describe('warm extraction prompt selection', () => {
  test('lane=warm with existingJobUrls uses extraction-warm prompt', async () => {
    const dir = tmpDir();
    const prev = process.env.EXTRACTION_LLM_FALLBACK;
    process.env.EXTRACTION_LLM_FALLBACK = '1';
    try {
      const company = { id: 'warm-1', name: 'Warm Co', careers_page_url: 'https://example.com', lane: 'warm' };
      const html = '<html><body><p>static /jobs/one path text, no links</p></body></html>';
      fs.writeFileSync(path.join(dir, 'warm-1.html'), html, 'utf8');

      let capturedPrompt = '';
      const res = await extraction.extractCompanyJobs(company, {
        artifactsDir: dir,
        existingJobUrls: ['https://example.com/jobs/1'],
        callFn: async (prompt) => { capturedPrompt = prompt; return '[]'; },
      });

      expect(res.html_extract_path).toBe('llm');
      expect(capturedPrompt).toContain('Existing job URLs (JSON array already known from prior runs): ["https://example.com/jobs/1"]');
      expect(capturedPrompt).toContain('Return ONLY delta jobs for warm-lane fallback');
    } finally {
      if (prev === undefined) delete process.env.EXTRACTION_LLM_FALLBACK;
      else process.env.EXTRACTION_LLM_FALLBACK = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('lane=cold uses extraction.txt prompt', async () => {
    const dir = tmpDir();
    const prev = process.env.EXTRACTION_LLM_FALLBACK;
    process.env.EXTRACTION_LLM_FALLBACK = '1';
    try {
      const company = { id: 'cold-1', name: 'Cold Co', careers_page_url: 'https://example.com', lane: 'cold' };
      const html = '<html><body><p>static /jobs/one path text, no links</p></body></html>';
      fs.writeFileSync(path.join(dir, 'cold-1.html'), html, 'utf8');

      let capturedPrompt = '';
      await extraction.extractCompanyJobs(company, {
        artifactsDir: dir,
        existingJobUrls: ['https://example.com/jobs/1'],
        callFn: async (prompt) => { capturedPrompt = prompt; return '[]'; },
      });

      expect(capturedPrompt).toContain('Extract all job listings from this careers page HTML. Return a JSON array of job objects.');
      expect(capturedPrompt).not.toContain('Return ONLY delta jobs for warm-lane fallback');
    } finally {
      if (prev === undefined) delete process.env.EXTRACTION_LLM_FALLBACK;
      else process.env.EXTRACTION_LLM_FALLBACK = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('lane=warm with empty existingJobUrls falls back to extraction.txt', async () => {
    const dir = tmpDir();
    const prev = process.env.EXTRACTION_LLM_FALLBACK;
    process.env.EXTRACTION_LLM_FALLBACK = '1';
    try {
      const company = { id: 'warm-empty', name: 'Warm Empty', careers_page_url: 'https://example.com', lane: 'warm' };
      const html = '<html><body><p>static /jobs/one path text, no links</p></body></html>';
      fs.writeFileSync(path.join(dir, 'warm-empty.html'), html, 'utf8');

      let capturedPrompt = '';
      await extraction.extractCompanyJobs(company, {
        artifactsDir: dir,
        existingJobUrls: [],
        callFn: async (prompt) => { capturedPrompt = prompt; return '[]'; },
      });

      expect(capturedPrompt).toContain('Extract all job listings from this careers page HTML. Return a JSON array of job objects.');
      expect(capturedPrompt).not.toContain('Return ONLY delta jobs for warm-lane fallback');
    } finally {
      if (prev === undefined) delete process.env.EXTRACTION_LLM_FALLBACK;
      else process.env.EXTRACTION_LLM_FALLBACK = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('warm delta output is parsed and normalized', async () => {
    const dir = tmpDir();
    const prev = process.env.EXTRACTION_LLM_FALLBACK;
    process.env.EXTRACTION_LLM_FALLBACK = '1';
    try {
      const company = { id: 'warm-delta', name: 'Warm Delta', careers_page_url: 'https://example.com', lane: 'warm' };
      const html = '<html><body><p>jobs path: /jobs/new-role and location Remote, no links</p></body></html>';
      fs.writeFileSync(path.join(dir, 'warm-delta.html'), html, 'utf8');

      const llmOutput = JSON.stringify([
        { job_title: 'New Role', url: '/jobs/new-role', location: 'Remote', employment_type: null, description: 'delta desc' }
      ]);
      const res = await extraction.extractCompanyJobs(company, {
        artifactsDir: dir,
        existingJobUrls: ['https://example.com/jobs/old-role'],
        callFn: async () => llmOutput,
      });

      expect(res.html_extract_path).toBe('llm');
      expect(res.jobs.length).toBe(1);
      expect(res.jobs[0].source_url).toBe('https://example.com/jobs/new-role');
      expect(res.jobs[0].job_title_raw).toBe('New Role');
    } finally {
      if (prev === undefined) delete process.env.EXTRACTION_LLM_FALLBACK;
      else process.env.EXTRACTION_LLM_FALLBACK = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
