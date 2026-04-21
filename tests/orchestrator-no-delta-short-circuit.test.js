const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadFns() {
  const orchestratorPath = path.join(__dirname, '..', 'src', 'orchestrator.js');
  const source = fs.readFileSync(orchestratorPath, 'utf8');
  const normalizeMatch = source.match(/function normalizeScrapeStageResult\(result\) \{[\s\S]*?\n\}/);
  const runStageMatch = source.match(/async function runStage\(stage, c\) \{[\s\S]*?\n\}/);
  if (!normalizeMatch || !runStageMatch) throw new Error('required functions not found');
  const script = new vm.Script(`${normalizeMatch[0]}\n${runStageMatch[0]}\n({ runStage, normalizeScrapeStageResult });`);
  return script;
}

describe('orchestrator no_delta short-circuit', () => {
  test('warm scrape with no_delta emits skipped extract once', async () => {
    const emit = jest.fn();
    const script = loadFns();
    const context = {
      VERBOSE: false,
      stats: { skipped: { extract: 0 } },
      bumpLaneStat: jest.fn(),
      scrapeCompany: jest.fn(async () => ({ success: true, method: 'greenhouse_api', status_code: 200, job_urls: ['https://jobs/1'] })),
      buildWarmScrapeDecision: jest.fn(() => ({
        now: '2026-01-01T00:00:00.000Z',
        touched: [],
        diff: { existing: new Set(['https://jobs/1']), netNew: new Set(), removed: new Set() },
        noDelta: true,
      })),
      newJobsBuffer: [],
      events: { emit },
    };
    const { runStage } = script.runInNewContext(context);
    const company = { id: 'c1', lane: 'warm', careers_page_reachable: true };
    const out = await runStage('scrape', company);

    expect(out.outcome).toBe('success');
    expect(company.last_extracted_at).toBe('2026-01-01T00:00:00.000Z');
    expect(company.last_enriched_at).toBe('2026-01-01T00:00:00.000Z');
    expect(company.last_scrape_outcome).toBe('no_delta');
    expect(context.stats.skipped.extract).toBe(1);
    expect(context.bumpLaneStat).toHaveBeenCalledWith('warm', 'skipped', 'extract');
    expect(emit).toHaveBeenCalledWith('extract', company, 'skipped', expect.objectContaining({ reason: 'no_delta' }));
    expect(emit).toHaveBeenCalledTimes(1);
  });

  test('cold scrape does not short-circuit', async () => {
    const emit = jest.fn();
    const script = loadFns();
    const context = {
      VERBOSE: false,
      stats: { skipped: { extract: 0 } },
      bumpLaneStat: jest.fn(),
      scrapeCompany: jest.fn(async () => ({ success: true, method: 'greenhouse_api', status_code: 200, job_urls: ['https://jobs/1'] })),
      buildWarmScrapeDecision: jest.fn(() => ({
        now: '2026-01-01T00:00:00.000Z',
        touched: [],
        diff: { existing: new Set(['https://jobs/1']), netNew: new Set(), removed: new Set() },
        noDelta: true,
      })),
      newJobsBuffer: [],
      events: { emit },
    };
    const { runStage } = script.runInNewContext(context);
    const company = { id: 'c1', lane: 'cold', careers_page_reachable: true };
    const out = await runStage('scrape', company);

    expect(out.outcome).toBe('success');
    expect(company.last_extracted_at).toBeUndefined();
    expect(company.last_enriched_at).toBeUndefined();
    expect(company.last_scrape_outcome).toBe('success');
    expect(context.stats.skipped.extract).toBe(0);
    expect(emit).not.toHaveBeenCalled();
    expect(context.buildWarmScrapeDecision).not.toHaveBeenCalled();
  });
});
