const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadBatcherFns({ categorizeCompany, batchCategorize, classifyLlmMessage }) {
  const orchestratorPath = path.join(__dirname, '..', 'src', 'orchestrator.js');
  const source = fs.readFileSync(orchestratorPath, 'utf8');
  const buildMatch = source.match(/function buildCategorizeOutcome\(c\) \{[\s\S]*?\n\}/);
  const applyMatch = source.match(/function applyBatchCategorizeResult\(c, row\) \{[\s\S]*?\n\}/);
  const batcherMatch = source.match(/function createCategorizeBatcher\(\{ waitMs, maxBatchSize, dryRun, categorizerAgent, taxonomy \}\) \{[\s\S]*?return \{ enqueue, flush \};\n\}/);
  if (!buildMatch || !applyMatch || !batcherMatch) throw new Error('batcher functions not found');
  const script = new vm.Script(`
    ${buildMatch[0]}
    ${applyMatch[0]}
    ${batcherMatch[0]}
    ({ createCategorizeBatcher, buildCategorizeOutcome, applyBatchCategorizeResult });
  `);
  return script.runInNewContext({ categorizeCompany, batchCategorize, classifyLlmMessage, process, setTimeout, clearTimeout, Math, Promise });
}

function mkCompany(id) {
  return {
    id,
    name: `Company ${id}`,
    company_profile: { description: 'Long enough description for categorize stage'.repeat(3), keywords: ['solar'] },
  };
}

function mkRep() {
  return { job_title_normalized: 'Engineer', job_function: 'Engineering', description_summary: 'Builds things' };
}

describe('orchestrator categorize batching', () => {
  let categorizeCompany;
  let batchCategorize;
  let createCategorizeBatcher;

  beforeEach(() => {
    categorizeCompany = jest.fn();
    batchCategorize = jest.fn();
    ({ createCategorizeBatcher } = loadBatcherFns({
      categorizeCompany,
      batchCategorize,
      classifyLlmMessage: () => null,
    }));
  });

  test('coalesces 5 enqueues into a single batch call', async () => {
    batchCategorize.mockImplementation(async (entries) => {
      const map = new Map();
      for (const e of entries) {
        map.set(e.company.id, { category: `cat-${e.company.id}`, confidence: 0.8, reason: 'ok' });
      }
      return map;
    });

    const batcher = createCategorizeBatcher({
      waitMs: 2000,
      maxBatchSize: 10,
      dryRun: false,
      categorizerAgent: { provider: 'anthropic', apiKey: 'x', model: 'y' },
      taxonomy: [],
    });

    const companies = ['c1', 'c2', 'c3', 'c4', 'c5'].map(mkCompany);
    const promises = companies.map((company) => batcher.enqueue({ company, rep: mkRep(), samples: [] }));
    await batcher.flush('test');
    const outcomes = await Promise.all(promises);

    expect(batchCategorize).toHaveBeenCalledTimes(1);
    expect(outcomes).toHaveLength(5);
    expect(outcomes[0].outcome).toBe('success');
    expect(outcomes[0].extra.category).toBe('cat-c1');
    expect(outcomes[4].extra.category).toBe('cat-c5');
  });

  test('flushes pending entries on timeout wait cap', async () => {
    batchCategorize.mockImplementation(async (entries) => {
      const map = new Map();
      for (const e of entries) map.set(e.company.id, { category: 'Solar PV', confidence: 0.9, reason: 'ok' });
      return map;
    });

    const batcher = createCategorizeBatcher({
      waitMs: 30,
      maxBatchSize: 10,
      dryRun: false,
      categorizerAgent: { provider: 'anthropic', apiKey: 'x', model: 'y' },
      taxonomy: [],
    });

    const p1 = batcher.enqueue({ company: mkCompany('c1'), rep: mkRep(), samples: [] });
    const p2 = batcher.enqueue({ company: mkCompany('c2'), rep: mkRep(), samples: [] });
    const outcomes = await Promise.all([p1, p2]);

    expect(batchCategorize).toHaveBeenCalledTimes(1);
    expect(outcomes.map((o) => o.outcome)).toEqual(['success', 'success']);
  });

  test('falls back to single-company categorizeCompany when one company fails in batch map', async () => {
    batchCategorize.mockImplementation(async (entries) => {
      const map = new Map();
      map.set(entries[0].company.id, { category: 'Solar PV', confidence: 0.85, reason: 'ok' });
      map.set(entries[1].company.id, { error: 'malformed_result' });
      return map;
    });
    categorizeCompany.mockImplementation(async (company) => {
      company.climate_tech_category = 'FallbackCategory';
      company.category_confidence = 'medium';
      company.category_resolver = 'llm';
      delete company.category_error;
    });

    const batcher = createCategorizeBatcher({
      waitMs: 2000,
      maxBatchSize: 10,
      dryRun: false,
      categorizerAgent: { provider: 'anthropic', apiKey: 'x', model: 'y' },
      taxonomy: [],
    });

    const c1 = mkCompany('c1');
    const c2 = mkCompany('c2');
    const p1 = batcher.enqueue({ company: c1, rep: mkRep(), samples: [] });
    const p2 = batcher.enqueue({ company: c2, rep: mkRep(), samples: [] });
    await batcher.flush('test');
    const [o1, o2] = await Promise.all([p1, p2]);

    expect(batchCategorize).toHaveBeenCalledTimes(1);
    expect(categorizeCompany).toHaveBeenCalledTimes(1);
    expect(o1.outcome).toBe('success');
    expect(o2.outcome).toBe('success');
    expect(o2.extra.category).toBe('FallbackCategory');
  });
});
