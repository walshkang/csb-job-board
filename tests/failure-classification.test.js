const {
  classifyFailure,
  isTransient,
  FAILURE_CLASSES,
} = require('../src/utils/pipeline-events');

describe('failure classification contract', () => {
  test('classifies transient network failures', () => {
    expect(classifyFailure('scrape', new Error('ECONNRESET'), null)).toBe(FAILURE_CLASSES.TRANSIENT_NETWORK);
  });

  test('classifies rate limit from status object', () => {
    expect(classifyFailure('enrich', { status: 429 }, null)).toBe(FAILURE_CLASSES.RATE_LIMIT);
  });

  test('classifies auth failures from status object', () => {
    expect(classifyFailure('enrich', { status: 401 }, null)).toBe(FAILURE_CLASSES.AUTH);
  });

  test('classifies config failures', () => {
    expect(classifyFailure('enrich', new Error('prompt unavailable'), null)).toBe(FAILURE_CLASSES.CONFIG);
  });

  test('isTransient only allows transient classes', () => {
    expect(isTransient(FAILURE_CLASSES.TRANSIENT_NETWORK)).toBe(true);
    expect(isTransient(FAILURE_CLASSES.RATE_LIMIT)).toBe(true);
    expect(isTransient(FAILURE_CLASSES.TIMEOUT)).toBe(true);
    expect(isTransient(FAILURE_CLASSES.AUTH)).toBe(false);
    expect(isTransient(FAILURE_CLASSES.CONFIG)).toBe(false);
    expect(isTransient(FAILURE_CLASSES.BAD_DATA)).toBe(false);
    expect(isTransient(FAILURE_CLASSES.UNKNOWN)).toBe(false);
  });
});
