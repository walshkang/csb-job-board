const { classifyLane } = require('../src/utils/pipeline-stages');

describe('classifyLane', () => {
  test('{} → cold', () => expect(classifyLane({})).toBe('cold'));
  test('profile_attempted_at: null → cold', () => expect(classifyLane({ profile_attempted_at: null })).toBe('cold'));
  test('profile_attempted_at set → warm', () =>
    expect(classifyLane({ profile_attempted_at: '2026-01-01T00:00:00Z' })).toBe('warm'));
});
