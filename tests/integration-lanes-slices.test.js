const fs = require('fs');
const path = require('path');
const os = require('os');
const extraction = require('../src/agents/extraction');
const { applyColdBatchTag } = require('../scripts/seed-cold-batch');
const { diffScrapeUrls } = require('../src/utils/scrape-diff');
const { normalizeJobUrl } = require('../src/agents/scraper');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'integration-test-'));
}

describe('integration lanes + slices', () => {
  let dir;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Cold flow: untagged company gets seeded, extracted jobs are all net_new', async () => {
    // 1. Seed tagging
    const company = { id: 'cold-1', name: 'Cold Co', profile_attempted_at: null, careers_page_url: 'https://cold.co' };
    const seedResult = applyColdBatchTag([company], 'seed_2026_04');
    expect(seedResult.taggedCount).toBe(1);
    expect(seedResult.companies[0].cold_batch_id).toBe('seed_2026_04');

    const updatedCompany = seedResult.companies[0];

    // 2. Setup artifacts
    fs.writeFileSync(path.join(dir, 'cold-1.html'), '<html><body><a href="/jobs/1">Job 1</a></body></html>', 'utf8');

    // 3. Extract (Stub LLM to return nothing, we expect the anchor adapter to extract the job)
    const llmStub = jest.fn().mockResolvedValue('[]');

    const extractRes = await extraction.extractCompanyJobs(updatedCompany, {
      artifactsDir: dir,
      callFn: llmStub,
      existingJobUrls: [] // Cold lane has no prior jobs
    });

    expect(extractRes.processed).toBe(true);
    expect(extractRes.jobs.length).toBe(1);

    // 4. Assert diff
    const currentUrls = extractRes.jobs.map(j => normalizeJobUrl(j.source_url)).filter(Boolean);
    const diff = diffScrapeUrls({ priorUrls: [], currentUrls });

    expect(diff.netNew.size).toBe(1);
    expect(diff.existing.size).toBe(0);
    expect(diff.removed.size).toBe(0);
    
    // Validate job enrichment prep structure
    expect(extractRes.jobs[0].company_id).toBe('cold-1');
  });

  test('Warm flow: company with prior jobs receives diff with existing, removed, net_new', async () => {
    // 1. Warm company (no seed tag)
    const company = { id: 'warm-1', name: 'Warm Co', profile_attempted_at: '2026-01-01T00:00:00Z', lane: 'warm', careers_page_url: 'https://warm.co' };
    const seedResult = applyColdBatchTag([company], 'seed_2026_04');
    expect(seedResult.taggedCount).toBe(0);

    // 2. Setup artifacts (JSON artifact)
    const artifactData = {
      jobs: [
        { absolute_url: 'https://warm.co/jobs/1', title: 'Eng', content: 'desc' }, // existing
        { absolute_url: 'https://warm.co/jobs/3', title: 'PM', content: 'desc' }   // net new
      ]
    };
    fs.writeFileSync(path.join(dir, 'warm-1.json'), JSON.stringify(artifactData), 'utf8');

    // Prior state
    const priorJobs = [
      { id: 'job-1', source_url: 'https://warm.co/jobs/1', removed_at: null }, // still exists
      { id: 'job-2', source_url: 'https://warm.co/jobs/2', removed_at: null }  // removed
    ];
    const priorUrls = priorJobs.map(j => normalizeJobUrl(j.source_url)).filter(Boolean);

    // 3. Extract (Using JSON adapter, LLM not called)
    const llmStub = jest.fn().mockResolvedValue('[]');
    
    const extractRes = await extraction.extractCompanyJobs(company, {
      artifactsDir: dir,
      callFn: llmStub,
      existingJobUrls: priorUrls
    });

    expect(extractRes.processed).toBe(true);
    expect(extractRes.html_extract_path).toBe('json');
    expect(extractRes.jobs.length).toBe(2);

    // 4. Assert diff
    const currentUrls = extractRes.jobs.map(j => normalizeJobUrl(j.source_url)).filter(Boolean);
    const diff = diffScrapeUrls({ priorUrls, currentUrls });

    expect(diff.existing.size).toBe(1);
    expect(diff.existing.has('https://warm.co/jobs/1')).toBe(true);

    expect(diff.removed.size).toBe(1);
    expect(diff.removed.has('https://warm.co/jobs/2')).toBe(true);

    expect(diff.netNew.size).toBe(1);
    expect(diff.netNew.has('https://warm.co/jobs/3')).toBe(true);
  });
});
