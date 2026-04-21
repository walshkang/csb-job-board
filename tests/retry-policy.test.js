const { runWithRetry } = require('../src/utils/retry-policy');
const { FAILURE_CLASSES } = require('../src/utils/pipeline-events');

describe('retry policy', () => {
  test('retries transient failure twice then succeeds', async () => {
    const attempts = [];
    const emitted = [];
    const sleeps = [];
    let callCount = 0;

    const result = await runWithRetry({
      maxAttempts: 3,
      run: async () => {
        callCount += 1;
        attempts.push(callCount);
        if (callCount < 3) {
          throw Object.assign(new Error('429 rate limit'), { status: 429 });
        }
        return { outcome: 'success', extra: { ok: true } };
      },
      classifyFailure: () => FAILURE_CLASSES.RATE_LIMIT,
      isTransient: () => true,
      computeDelayMs: (attempt) => attempt * 100,
      onRetry: (ctx) => emitted.push({ type: 'retry', ...ctx }),
      onFinalFailure: (ctx) => emitted.push({ type: 'failure', ...ctx }),
      sleep: async (ms) => { sleeps.push(ms); },
    });

    expect(result.status).toBe('success');
    expect(attempts).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([100, 200]);
    expect(emitted.filter(e => e.type === 'retry')).toHaveLength(2);
    expect(emitted.filter(e => e.type === 'failure')).toHaveLength(0);
  });

  test('does not retry non-transient auth error', async () => {
    const emitted = [];
    const sleeps = [];

    const result = await runWithRetry({
      maxAttempts: 3,
      run: async () => {
        throw Object.assign(new Error('unauthorized'), { status: 401 });
      },
      classifyFailure: () => FAILURE_CLASSES.AUTH,
      isTransient: () => false,
      computeDelayMs: () => 100,
      onRetry: (ctx) => emitted.push({ type: 'retry', ...ctx }),
      onFinalFailure: (ctx) => emitted.push({ type: 'failure', ...ctx }),
      sleep: async (ms) => { sleeps.push(ms); },
    });

    expect(result.status).toBe('failure');
    expect(result.failure_class).toBe(FAILURE_CLASSES.AUTH);
    expect(sleeps).toHaveLength(0);
    expect(emitted.filter(e => e.type === 'retry')).toHaveLength(0);
    expect(emitted.filter(e => e.type === 'failure')).toHaveLength(1);
  });

  test('retries twice then fails on third transient error', async () => {
    const emitted = [];

    const result = await runWithRetry({
      maxAttempts: 3,
      run: async () => {
        throw Object.assign(new Error('rate limit'), { status: 429 });
      },
      classifyFailure: () => FAILURE_CLASSES.RATE_LIMIT,
      isTransient: () => true,
      computeDelayMs: (attempt) => attempt * 25,
      onRetry: (ctx) => emitted.push({ type: 'retry', ...ctx }),
      onFinalFailure: (ctx) => emitted.push({ type: 'failure', ...ctx }),
      sleep: async () => {},
    });

    expect(result.status).toBe('failure');
    expect(result.attempt).toBe(3);
    expect(emitted.filter(e => e.type === 'retry')).toHaveLength(2);
    expect(emitted.filter(e => e.type === 'failure')).toHaveLength(1);
  });
});
