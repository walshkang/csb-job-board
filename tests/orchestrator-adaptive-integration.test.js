const fs = require('fs');
const path = require('path');
const vm = require('vm');

function readOrchestratorSource() {
  const orchestratorPath = path.join(__dirname, '..', 'src', 'orchestrator.js');
  return fs.readFileSync(orchestratorPath, 'utf8');
}

function loadSnapshotFunctionWithContext(context) {
  const source = readOrchestratorSource();
  const match = source.match(/function snapshot\(\) \{[\s\S]*?\n\}/);
  if (!match) throw new Error('snapshot function not found');
  const script = new vm.Script(`${match[0]}; snapshot;`);
  return script.runInNewContext(context);
}

describe('orchestrator adaptive concurrency integration', () => {
  test('source wires adaptive controller tick into snapshot cycle', () => {
    const source = readOrchestratorSource();
    expect(source).toMatch(/for \(const s of STAGES\) adaptiveControllers\[s\]\.tick\(\);/);
  });

  test('snapshot includes per-stage current concurrency', () => {
    const fakeStage = 'scrape';
    const context = {
      STAGES: [fakeStage],
      adaptiveControllers: {
        [fakeStage]: {
          tick: jest.fn(),
          snapshot: () => ({ current: 5, min: 2, max: 10, p95Ms: 400, errorRate: 0 }),
        },
      },
      queues: { [fakeStage]: { size: 3, pending: 1, concurrency: 5 } },
      breakers: { [fakeStage]: { snapshot: () => ({ state: 'closed' }) } },
      stats: { started: {}, completed: {}, no_result: {}, failed: {}, skipped: {} },
      statsByLane: {
        cold: { started: {}, completed: {}, no_result: {}, failed: {}, skipped: {} },
        warm: { started: {}, completed: {}, no_result: {}, failed: {}, skipped: {} },
      },
      recentCompletions: [],
      startedAt: Date.now(),
      events: { runId: 'run-1' },
      DRY_RUN: false,
      processCircuitResetCommands: () => {},
      writeSnapshot: jest.fn(),
      Date,
      Math,
    };
    const snapshot = loadSnapshotFunctionWithContext(context);
    const snap = snapshot();

    expect(snap).toHaveProperty('concurrency_current');
    expect(snap.concurrency_current).toHaveProperty(fakeStage, 5);
    expect(snap).toHaveProperty('adaptive_concurrency');
    expect(snap.adaptive_concurrency[fakeStage]).toHaveProperty('current', 5);
  });

  test('orchestrator passes breaker into adaptive controller wiring', () => {
    const source = readOrchestratorSource();
    expect(source).toMatch(/breaker: breakers\[stage\]/);
  });
});
