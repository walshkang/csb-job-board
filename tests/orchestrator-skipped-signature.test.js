const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadNormalizeScrapeStageResult() {
  const orchestratorPath = path.join(__dirname, '..', 'src', 'orchestrator.js');
  const source = fs.readFileSync(orchestratorPath, 'utf8');
  const match = source.match(/function normalizeScrapeStageResult\(result\) \{[\s\S]*?\n\}/);
  if (!match) throw new Error('normalizeScrapeStageResult not found');
  const script = new vm.Script(`${match[0]}; normalizeScrapeStageResult;`);
  return script.runInNewContext({});
}

describe('orchestrator scrape skipped signature normalization', () => {
  test('normalizes legacy skipped_signature_match to canonical skipped outcome', () => {
    const normalizeScrapeStageResult = loadNormalizeScrapeStageResult();
    const normalized = normalizeScrapeStageResult({
      skipped_signature_match: true,
      method: 'greenhouse_api',
      status_code: 200,
      preflight_url_count: 11,
      last_scrape_signature: 'sig-123',
    });

    expect(normalized).toEqual({
      outcome: 'skipped',
      extra: {
        reason: 'signature_match',
        method: 'greenhouse_api',
        status_code: 200,
        preflight_url_count: 11,
      },
      companyOutcome: 'skipped_signature_match',
    });
  });

  test('normalizer maps legacy value to queue-consumable skipped outcome', () => {
    const normalizeScrapeStageResult = loadNormalizeScrapeStageResult();
    const normalized = normalizeScrapeStageResult({
      skipped_signature_match: true,
      method: 'playwright',
      status_code: 304,
      job_count: 4,
    });

    expect(normalized.outcome).toBe('skipped');
    expect(normalized.companyOutcome).toBe('skipped_signature_match');
    expect(normalized.extra.reason).toBe('signature_match');
    expect(normalized.extra.preflight_url_count).toBe(4);
  });
});
