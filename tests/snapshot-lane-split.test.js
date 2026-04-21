const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadEnqueue() {
  const orchestratorPath = path.join(__dirname, '..', 'src', 'orchestrator.js');
  const source = fs.readFileSync(orchestratorPath, 'utf8');
  const match = source.match(/function enqueue\(c\) \{[\s\S]*?\n\}/);
  if (!match) throw new Error('enqueue not found');
  return match[0];
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

function buildContext() {
  let pending = Promise.resolve();
  const stage = 'profile';
  let getStageCalls = 0;
  const statsByLane = {
    cold: buildStats(stage),
    warm: buildStats(stage),
  };
  return {
    classifyLane: (c) => (c.profile_attempted_at ? 'warm' : 'cold'),
    getStage: () => {
      getStageCalls += 1;
      return getStageCalls % 2 === 1 ? stage : 'done';
    },
    stageFilterSet: null,
    breakers: { [stage]: { allow: () => true, record: jest.fn() } },
    queues: {
      [stage]: {
        add: (fn) => {
          pending = Promise.resolve(fn());
          return pending;
        },
      },
    },
    stats: buildStats(stage),
    statsByLane,
    bumpLaneStat: (lane, kind, stageName) => {
      statsByLane[lane][kind][stageName] += 1;
    },
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
    adaptiveControllers: { [stage]: { recordOutcome: jest.fn() } },
    sleep: jest.fn(),
    _pending: () => pending,
  };
}

describe('snapshot lane split counters', () => {
  test('started/completed counters partition by cold and warm lane', async () => {
    const script = new vm.Script(`${loadEnqueue()}; enqueue;`);
    const context = buildContext();
    const enqueue = script.runInNewContext(context);

    enqueue({ id: 'c-cold', profile_attempted_at: null });
    await context._pending();
    enqueue({ id: 'c-warm', profile_attempted_at: '2026-01-01T00:00:00.000Z' });
    await context._pending();

    expect(context.stats.started.profile).toBe(2);
    expect(context.stats.completed.profile).toBe(2);
    expect(context.statsByLane.cold.started.profile).toBe(1);
    expect(context.statsByLane.cold.completed.profile).toBe(1);
    expect(context.statsByLane.warm.started.profile).toBe(1);
    expect(context.statsByLane.warm.completed.profile).toBe(1);
  });
});
