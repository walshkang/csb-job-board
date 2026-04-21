const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { buildRunSummaryFromEventsPath } = require('../src/agents/reporter');

describe('reporter jobs tri-state summary', () => {
  test('aggregates net_new/existing/removed and company lane counts', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reporter-events-'));
    const eventsPath = path.join(tmpDir, 'pipeline-events.jsonl');
    const lines = [
      JSON.stringify({ stage: 'profile', outcome: 'success', lane: 'cold' }),
      JSON.stringify({ stage: 'scrape', outcome: 'success', lane: 'warm' }),
      JSON.stringify({ stage: 'extract', outcome: 'success', lane: 'warm', net_new: 2, existing: 5, removed: 1 }),
      JSON.stringify({ stage: 'extract', outcome: 'skipped', lane: 'warm', net_new: 0, existing: 5, removed: 0 }),
      JSON.stringify({ stage: 'scrape', outcome: 'failure', lane: 'warm' }),
      'not-json',
    ];
    await fs.writeFile(eventsPath, `${lines.join('\n')}\n`, 'utf8');

    const summary = await buildRunSummaryFromEventsPath(eventsPath);

    expect(summary).toEqual({
      jobs: { net_new: 2, existing: 10, removed: 1 },
      companies: { cold_onboarded: 1, warm_refreshed: 1 },
    });
  });
});
