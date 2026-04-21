const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadComputeStageProgressPct() {
  const htmlPath = path.join(__dirname, '..', 'admin', 'public', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const match = html.match(/function computeStageProgressPct\(started, queued, inFlight, done\) \{[\s\S]*?\n      \}/);
  if (!match) throw new Error('computeStageProgressPct not found');
  const script = new vm.Script(`${match[0]}; computeStageProgressPct;`);
  return script.runInNewContext({});
}

describe('progress bar math', () => {
  test('uses started + queued + in_flight denominator', () => {
    const computeStageProgressPct = loadComputeStageProgressPct();
    const pct = computeStageProgressPct(10, 5, 2, 3);
    expect(pct).toBe(Math.round((3 / 17) * 100));
  });
});
