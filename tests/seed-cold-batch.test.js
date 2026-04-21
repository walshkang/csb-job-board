const { applyColdBatchTag } = require('../scripts/seed-cold-batch');

describe('applyColdBatchTag', () => {
  test('blank profile_attempted_at and no cold_batch_id get tagged', () => {
    const label = 'pb_2026-04-21';
    const input = [
      { id: 'cold-1', profile_attempted_at: null },
      { id: 'cold-2', profile_attempted_at: '' }
    ];

    const result = applyColdBatchTag(input, label);

    expect(result.taggedCount).toBe(2);
    expect(result.companies[0].cold_batch_id).toBe(label);
    expect(result.companies[1].cold_batch_id).toBe(label);
  });

  test('already tagged companies are untouched', () => {
    const label = 'pb_2026-04-21';
    const input = [
      { id: 'already-tagged', profile_attempted_at: null, cold_batch_id: 'pb_old' },
      { id: 'cold-new', profile_attempted_at: null }
    ];

    const result = applyColdBatchTag(input, label);

    expect(result.taggedCount).toBe(1);
    expect(result.companies[0].cold_batch_id).toBe('pb_old');
    expect(result.companies[1].cold_batch_id).toBe(label);
  });

  test('companies with profile_attempted_at set are untouched', () => {
    const label = 'pb_2026-04-21';
    const input = [
      { id: 'warm-1', profile_attempted_at: '2026-01-01T00:00:00.000Z' },
      { id: 'warm-2', profile_attempted_at: '2026-01-01T00:00:00.000Z', cold_batch_id: 'pb_prev' }
    ];

    const result = applyColdBatchTag(input, label);

    expect(result.taggedCount).toBe(0);
    expect(result.companies[0].cold_batch_id).toBeUndefined();
    expect(result.companies[1].cold_batch_id).toBe('pb_prev');
  });
});
