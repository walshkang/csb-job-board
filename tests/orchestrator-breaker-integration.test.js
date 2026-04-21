const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadEnqueue() {
  const orchestratorPath = path.join(__dirname, '..', 'src', 'orchestrator.js');
  const source = fs.readFileSync(orchestratorPath, 'utf8');
  const match = source.match(/function enqueue\(c\) \{[\s\S]*?\n\}/);
  if (!match) throw new Error('enqueue not found');
  return { source, fn: match[0] };
}

function buildStats(stage) {
  return {
    started: { [stage]: 0 },
    completed: { [stage]: 0 },
    no_result: { [stage]: 0 },
    failed: { [stage]: 0 },
    skipped: { [stage]: 0 },
  };
}

describe('orchestrator breaker integration', () => {
  test('open breaker prevents queue add', () => {
    const { fn } = loadEnqueue();
    const queueAdd = jest.fn();
    const context = {
      classifyLane: () => 'cold',
      getStage: () => 'profile',
      stageFilterSet: null,
      breakers: { profile: { allow: () => false } },
      queues: { profile: { add: queueAdd } },
      STAGES: ['profile'],
      stats: buildStats('profile'),
      bumpLaneStat: jest.fn(),
      runWithRetry: jest.fn(),
      runStage: jest.fn(),
      RETRY_MAX_ATTEMPTS: 3,
      classifyFailure: jest.fn(),
      isTransient: jest.fn(),
      computeRetryDelayMs: jest.fn(),
      events: { emit: jest.fn() },
      log: jest.fn(),
      markDirty: jest.fn(),
      recentCompletions: [],
      adaptiveControllers: { profile: { recordOutcome: jest.fn() } },
      Date,
      sleep: jest.fn(),
    };
    const script = new vm.Script(`${fn}; enqueue;`);
    const enqueue = script.runInNewContext(context);
    enqueue({ id: 'c-1' });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  test('records success/failure outcomes into breaker', async () => {
    const { fn, source } = loadEnqueue();
    expect(source).toMatch(/breakers:\s*breakerSnapshots/);

    let getStageCalls = 0;
    const breaker = { allow: jest.fn(() => true), record: jest.fn() };
    let pendingPromise = Promise.resolve();
    const context = {
      classifyLane: () => 'cold',
      getStage: () => {
        getStageCalls += 1;
        return getStageCalls === 1 ? 'profile' : 'done';
      },
      stageFilterSet: null,
      breakers: { profile: breaker },
      queues: {
        profile: {
          add: (fnToRun) => {
            pendingPromise = Promise.resolve(fnToRun());
            return pendingPromise;
          },
        },
      },
      stats: buildStats('profile'),
      bumpLaneStat: jest.fn(),
      runWithRetry: jest.fn(async () => ({
        status: 'success',
        result: { outcome: 'success', extra: {} },
      })),
      runStage: jest.fn(),
      RETRY_MAX_ATTEMPTS: 3,
      classifyFailure: jest.fn(),
      isTransient: jest.fn(),
      computeRetryDelayMs: jest.fn(),
      events: { emit: jest.fn() },
      log: jest.fn(),
      markDirty: jest.fn(),
      recentCompletions: [],
      adaptiveControllers: { profile: { recordOutcome: jest.fn() } },
      Date,
      sleep: jest.fn(),
    };
    const script = new vm.Script(`${fn}; enqueue;`);
    const enqueue = script.runInNewContext(context);
    enqueue({ id: 'c-2', name: 'Company 2' });
    await pendingPromise;
    expect(breaker.record).toHaveBeenCalledWith('success');

    getStageCalls = 0;
    breaker.record.mockClear();
    context.runWithRetry.mockImplementation(async () => ({
      status: 'failure',
      err: new Error('boom'),
      failure_class: 'transient_network',
    }));
    enqueue({ id: 'c-3', name: 'Company 3' });
    await pendingPromise;
    expect(breaker.record).toHaveBeenCalledWith('failure');
  });
});
