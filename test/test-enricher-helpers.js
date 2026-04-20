'use strict';
const assert = require('assert');
const enricher = require('../src/agents/enricher');

console.log('Running enricher helper tests...');

// sha256 test
assert.strictEqual(
  enricher.sha256('abc'),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
);

// chunkArray test
assert.deepStrictEqual(
  enricher.chunkArray([1,2,3,4,5], 2),
  [[1,2],[3,4],[5]]
);

// extractJSON should parse fenced JSON
assert.deepStrictEqual(
  enricher.extractJSON('```json\n{"a":1}\n```'),
  { a: 1 }
);

// sanitize behavior
const parsed = {
  job_title_normalized: 'Senior Eng',
  job_function: 'Engineering',
  seniority_level: 'Manager',
  location_type: 'REMOTE',
  mba_relevance: 'HIGH',
  description_summary: 'summary',
  climate_relevance_confirmed: 'true',
  climate_relevance_reason: 'matches category'
};
const s = enricher.sanitize(parsed);
assert.strictEqual(s.job_function, 'engineering');
assert.strictEqual(s.seniority_level, null);
assert.strictEqual(s.location_type, 'remote');
assert.strictEqual(s.mba_relevance, 'high');
assert.strictEqual(s.description_summary, 'summary');
assert.strictEqual(s.climate_relevance_confirmed, true);
assert.strictEqual(s.climate_relevance_reason, 'matches category');

console.log('enricher helper tests passed.');
