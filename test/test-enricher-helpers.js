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
assert.strictEqual(s.mba_relevance, 'high');
assert.strictEqual(s.description_summary, 'summary');
assert.strictEqual(s.climate_relevance_confirmed, true);
assert.strictEqual(s.climate_relevance_reason, 'matches category');

// deterministic resolver: seniority precedence + employment + location
const d1 = enricher.resolveDeterministic({
  job_title_raw: 'VP of Engineering Intern',
  description_raw: 'Contract consultant opportunity',
  location_raw: 'Remote - US'
});
assert.strictEqual(d1.seniority_level, 'intern');
assert.strictEqual(d1.employment_type, 'intern');
assert.strictEqual(d1.location_type, 'remote');

const d2 = enricher.resolveDeterministic({
  job_title_raw: 'Senior Director, Product',
  description_raw: 'This is a full-time role',
  location_raw: 'Hybrid - New York'
});
assert.strictEqual(d2.seniority_level, 'director');
assert.strictEqual(d2.employment_type, 'full_time');
assert.strictEqual(d2.location_type, 'hybrid');

const d3 = enricher.resolveDeterministic({
  job_title_raw: 'Junior Analyst',
  description_raw: 'Part-time contractor role',
  location_raw: 'Austin, TX'
});
assert.strictEqual(d3.seniority_level, 'entry');
assert.strictEqual(d3.employment_type, 'contract');
assert.strictEqual(d3.location_type, 'on_site');

const d4 = enricher.resolveDeterministic({
  job_title_raw: 'Software Engineer',
  description_raw: '',
  location_raw: ''
});
assert.strictEqual(d4.seniority_level, null);
assert.strictEqual(d4.employment_type, 'full_time');
assert.strictEqual(d4.location_type, 'unknown');

console.log('enricher helper tests passed.');
