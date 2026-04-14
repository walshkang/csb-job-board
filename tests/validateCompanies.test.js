const config = require('../src/config');

test('filters out example ids/names and blank names', () => {
  const input = [
    { id: 'example', name: 'Example' },
    { id: 'acme', name: 'Acme Energy' },
    { id: 'foo', name: '' },
    { id: 'bar', name: null },
    { id: 'EX123', name: 'example' }
  ];
  const out = config.validateCompanies(input);
  expect(Array.isArray(out)).toBe(true);
  expect(out.length).toBe(1);
  expect(out[0].id).toBe('acme');
});

test('throws when all entries removed', () => {
  const input = [
    { id: 'example', name: 'Example' },
    { id: 'ex2', name: '' }
  ];
  expect(() => config.validateCompanies(input)).toThrow(/No companies remain/);
});
