const { getSeenUrlsFromRun, getRunJobCount, updateJobsForLastRun, updateCompaniesDormancy } = require('../src/agents/temporal');

describe('Temporal agent helpers', () => {
  test('days_live calculation updates correctly', () => {
    const now = new Date('2026-01-04T12:00:00.000Z').toISOString();
    const jobs = [
      { id: 'j1', company_id: 'c1', source_url: 'u1', first_seen_at: '2026-01-01T00:00:00.000Z', last_seen_at: '2026-01-04T12:00:00.000Z' }
    ];

    const lastRun = { company_id: 'c1', status: 'success', scraped_at: now };
    const stats = updateJobsForLastRun(jobs, lastRun, now);
    expect(stats.removed).toBe(0);
    // days from 2026-01-01 to 2026-01-04T12:00 -> 3.5 days -> floor -> 3
    expect(jobs[0].days_live).toBe(3);
  });

  test('removed_at detection sets removed_at when job last_seen_at is older than run', () => {
    const now = new Date('2026-02-01T00:00:00.000Z').toISOString();
    const jobs = [
      { id: 'j1', company_id: 'c1', source_url: 'a', first_seen_at: '2026-01-01T00:00:00.000Z', last_seen_at: '2026-01-15T00:00:00.000Z' },
      { id: 'j2', company_id: 'c1', source_url: 'b', first_seen_at: '2026-01-15T00:00:00.000Z', last_seen_at: now }
    ];

    const lastRun = { company_id: 'c1', status: 'success', scraped_at: now };
    const stats = updateJobsForLastRun(jobs, lastRun, now);
    expect(stats.removed).toBe(1); // 'a' marked removed because 01-15 is older than 02-01
    expect(jobs.find(j => j.source_url === 'a').removed_at).toBe(now);
    expect(jobs.find(j => j.source_url === 'b').removed_at).toBeUndefined();
  });

  test('dormancy threshold logic: company goes dormant after 3 empty runs and reactivates when jobs return', () => {
    const companies = [ { id: 'c1', dormant: false }, { id: 'c2', dormant: true } ];

    // Runs are in chronological append order: oldest first, newest last.
    // For c1: had jobs earlier, then 3 empty runs -> should become dormant
    const runs = [
      { company_id: 'c1', jobs: [{ source_url: 'x' }] }, // c1 oldest
      { company_id: 'c1', jobs: [] },
      { company_id: 'c1', jobs: [] },
      { company_id: 'c1', jobs: [] },                     // c1 most recent (empty)

      // For c2: was dormant, 2 empty runs, then latest run has jobs -> should reactivate
      { company_id: 'c2', jobs: [] },
      { company_id: 'c2', jobs: [] },
      { company_id: 'c2', jobs: [{ source_url: 'u' }] }  // c2 most recent (has jobs)
    ];

    const stats = updateCompaniesDormancy(companies, runs, false);
    const c1 = companies.find(c => c.id === 'c1');
    const c2 = companies.find(c => c.id === 'c2');

    expect(c1.consecutive_empty_scrapes).toBe(3);
    expect(c1.dormant).toBe(true);

    // c2 last run had jobs thus should be active and counter reset
    expect(c2.consecutive_empty_scrapes).toBe(0);
    expect(c2.dormant).toBe(false);
  });
});
