const { AdaptiveController } = require('../src/utils/adaptive-concurrency');

describe('AdaptiveController', () => {
  test('increments concurrency with deep queue and healthy latency/errors', () => {
    let nowMs = 1000;
    const queue = { concurrency: 4, size: 8 };
    const breaker = { state: () => 'closed' };
    const controller = new AdaptiveController({
      stage: 'scrape',
      min: 2,
      max: 6,
      target: { p95MaxMs: 1000, queueDepthTrigger: 3 },
      queue,
      breaker,
      now: () => nowMs,
    });

    controller.recordOutcome({ duration_ms: 400, outcome: 'success' });
    controller.recordOutcome({ duration_ms: 500, outcome: 'success' });
    controller.tick();
    expect(queue.concurrency).toBe(5);

    controller.tick();
    expect(queue.concurrency).toBe(6);

    controller.tick();
    expect(queue.concurrency).toBe(6);
  });

  test('decrements concurrency on error spike down to min', () => {
    let nowMs = 1000;
    const queue = { concurrency: 5, size: 1 };
    const breaker = { state: () => 'closed' };
    const controller = new AdaptiveController({
      stage: 'extract',
      min: 3,
      max: 8,
      target: { p95MaxMs: 1000, queueDepthTrigger: 3 },
      queue,
      breaker,
      now: () => nowMs,
    });

    controller.recordOutcome({ duration_ms: 500, outcome: 'success' });
    controller.recordOutcome({ duration_ms: 600, outcome: 'failure' });
    controller.recordOutcome({ duration_ms: 700, outcome: 'failure' });
    controller.tick();
    expect(queue.concurrency).toBe(4);

    controller.tick();
    expect(queue.concurrency).toBe(3);

    controller.tick();
    expect(queue.concurrency).toBe(3);
  });

  test('breaker open or half_open makes tick a no-op', () => {
    const queue = { concurrency: 4, size: 10 };
    let breakerState = 'open';
    const breaker = { state: () => breakerState };
    const controller = new AdaptiveController({
      stage: 'enrich',
      min: 2,
      max: 8,
      target: { p95MaxMs: 1000, queueDepthTrigger: 3 },
      queue,
      breaker,
    });

    controller.recordOutcome({ duration_ms: 500, outcome: 'success' });
    controller.tick();
    expect(queue.concurrency).toBe(4);

    breakerState = 'half_open';
    controller.tick();
    expect(queue.concurrency).toBe(4);
  });

  test('old samples age out of the 60s window', () => {
    let nowMs = 1000;
    const queue = { concurrency: 4, size: 10 };
    const breaker = { state: () => 'closed' };
    const controller = new AdaptiveController({
      stage: 'profile',
      min: 2,
      max: 8,
      target: { p95MaxMs: 1000, queueDepthTrigger: 3 },
      queue,
      breaker,
      now: () => nowMs,
    });

    controller.recordOutcome({ duration_ms: 5000, outcome: 'failure' });
    nowMs += 61_000;
    controller.recordOutcome({ duration_ms: 400, outcome: 'success' });
    controller.recordOutcome({ duration_ms: 500, outcome: 'success' });

    controller.tick();
    expect(queue.concurrency).toBe(5);
    expect(controller.snapshot().errorRate).toBe(0);
  });
});
