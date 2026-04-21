const { CircuitBreaker } = require('../src/utils/circuit-breaker');

describe('CircuitBreaker', () => {
  test('new breaker starts closed', () => {
    const breaker = new CircuitBreaker();
    expect(breaker.state()).toBe('closed');
  });

  test('three failures below minSamples stays closed', () => {
    const breaker = new CircuitBreaker({ minSamples: 5 });
    breaker.record('failure');
    breaker.record('failure');
    breaker.record('failure');
    expect(breaker.state()).toBe('closed');
  });

  test('five failures opens breaker and blocks allow()', () => {
    const breaker = new CircuitBreaker({ minSamples: 5, threshold: 0.5 });
    for (let i = 0; i < 5; i++) breaker.record('failure');
    expect(breaker.state()).toBe('open');
    expect(breaker.allow()).toBe(false);
  });

  test('after cooldown enters half_open and allows one probe', () => {
    let nowMs = 1_000;
    const breaker = new CircuitBreaker({
      minSamples: 5,
      threshold: 0.5,
      cooldownMs: 10_000,
      now: () => nowMs,
    });
    for (let i = 0; i < 5; i++) breaker.record('failure');
    nowMs = 11_100;
    expect(breaker.state()).toBe('half_open');
    expect(breaker.allow()).toBe(true);
    expect(breaker.allow()).toBe(false);
  });

  test('half_open probe success closes breaker', () => {
    let nowMs = 1_000;
    const breaker = new CircuitBreaker({
      minSamples: 5,
      threshold: 0.5,
      cooldownMs: 1_000,
      now: () => nowMs,
    });
    for (let i = 0; i < 5; i++) breaker.record('failure');
    nowMs = 2_100;
    expect(breaker.allow()).toBe(true);
    breaker.record('success');
    expect(breaker.state()).toBe('closed');
  });

  test('half_open probe failure reopens breaker', () => {
    let nowMs = 1_000;
    const breaker = new CircuitBreaker({
      minSamples: 5,
      threshold: 0.5,
      cooldownMs: 1_000,
      now: () => nowMs,
    });
    for (let i = 0; i < 5; i++) breaker.record('failure');
    nowMs = 2_100;
    expect(breaker.allow()).toBe(true);
    breaker.record('failure');
    expect(breaker.state()).toBe('open');
  });

  test('reset closes breaker and clears samples', () => {
    const breaker = new CircuitBreaker({ minSamples: 5, threshold: 0.5 });
    for (let i = 0; i < 5; i++) breaker.record('failure');
    expect(breaker.state()).toBe('open');
    breaker.reset();
    expect(breaker.state()).toBe('closed');
    expect(breaker.snapshot().samples).toBe(0);
  });
});
