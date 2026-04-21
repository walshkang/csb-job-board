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

function buildContext({ profileAttemptedAt } = {}) {
  let getStageCalls = 0;
  const emitSpy = jest.fn();
  let pendingPromise = Promise.resolve();

  const context = {
    classifyLane: (c) => (c.profile_attempted_at ? 'warm' : 'cold'),
    getStage: () => {
      getStageCalls += 1;
      return getStageCalls === 1 ? 'profile' : 'done';
    },
    stageFilterSet: null,
    breakers: { profile: { allow: () => true, record: jest.fn() } },
    queues: {
      profile: {
        add: (fn) => {
          pendingPromise = Promise.resolve(fn());
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
    events: { emit: emitSpy },
    log: jest.fn(),
    markDirty: jest.fn(),
    recentCompletions: [],
    adaptiveControllers: { profile: { recordOutcome: jest.fn() } },
    Date,
    sleep: jest.fn(),
    _company: { id: 'c-test', name: 'Test Co', profile_attempted_at: profileAttemptedAt ?? null },
  };

  return { context, emitSpy, get pendingPromise() { return pendingPromise; } };
}

describe('orchestrator lane events', () => {
  test('freshly-ingested company (no profile_attempted_at) emits lane=cold', async () => {
    const fn = loadEnqueue();
    const { context, emitSpy } = buildContext({ profileAttemptedAt: null });
    const script = new vm.Script(`${fn}; enqueue;`);
    const enqueue = script.runInNewContext(context);

    let pending;
    context.queues.profile.add = (f) => { pending = Promise.resolve(f()); return pending; };

    enqueue(context._company);
    await pending;

    expect(emitSpy).toHaveBeenCalled();
    const company = emitSpy.mock.calls[0][1];
    expect(company.lane).toBe('cold');
  });

  test('company with profile_attempted_at set emits lane=warm', async () => {
    const fn = loadEnqueue();
    const { context, emitSpy } = buildContext({ profileAttemptedAt: '2026-01-01T00:00:00Z' });
    const script = new vm.Script(`${fn}; enqueue;`);
    const enqueue = script.runInNewContext(context);

    let pending;
    context.queues.profile.add = (f) => { pending = Promise.resolve(f()); return pending; };

    enqueue(context._company);
    await pending;

    expect(emitSpy).toHaveBeenCalled();
    const company = emitSpy.mock.calls[0][1];
    expect(company.lane).toBe('warm');
  });
});
