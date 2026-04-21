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
const sInvalidMba = enricher.sanitize({ mba_relevance: 'INVALID' });
assert.strictEqual(sInvalidMba.mba_relevance, null);

// deterministic resolver: seniority precedence + employment + location
const d1 = enricher.resolveDeterministic({
  job_title_raw: 'VP of Engineering Intern',
  description_raw: 'Contract consultant opportunity',
  location_raw: 'Remote - US'
});
assert.strictEqual(d1.job_function, null);
assert.strictEqual(d1.seniority_level, 'intern');
assert.strictEqual(d1.mba_relevance, null);
assert.strictEqual(d1.employment_type, 'intern');
assert.strictEqual(d1.location_type, 'remote');

const d2 = enricher.resolveDeterministic({
  job_title_raw: 'Senior Director, Product',
  description_raw: 'This is a full-time role',
  location_raw: 'Hybrid - New York'
});
assert.strictEqual(d2.job_function, null);
assert.strictEqual(d2.seniority_level, 'director');
assert.strictEqual(d2.employment_type, 'full_time');
assert.strictEqual(d2.location_type, 'hybrid');

const d3 = enricher.resolveDeterministic({
  job_title_raw: 'Junior Analyst',
  description_raw: 'Part-time contractor role',
  location_raw: 'Austin, TX'
});
assert.strictEqual(d3.job_function, null);
assert.strictEqual(d3.seniority_level, 'entry');
assert.strictEqual(d3.employment_type, 'contract');
assert.strictEqual(d3.location_type, 'on_site');

const d4 = enricher.resolveDeterministic({
  job_title_raw: 'Software Engineer',
  description_raw: '',
  location_raw: ''
});
assert.strictEqual(d4.job_function, 'engineering');
assert.strictEqual(d4.seniority_level, 'unknown');
assert.strictEqual(d4.mba_relevance, null);
assert.strictEqual(d4.employment_type, 'full_time');
assert.strictEqual(d4.location_type, 'unknown');

const d5 = enricher.resolveDeterministic({
  job_title_raw: 'Program Manager',
  description_raw: '',
  location_raw: ''
});
assert.strictEqual(d5.job_function, 'operations');

const d6 = enricher.resolveDeterministic({
  job_title_raw: 'Product Manager',
  description_raw: '',
  location_raw: ''
});
assert.strictEqual(d6.job_function, 'product');
assert.strictEqual(d6.seniority_level, 'unknown');

const d7 = enricher.resolveDeterministic({
  job_title_raw: 'Account Manager',
  description_raw: '',
  location_raw: ''
});
assert.strictEqual(d7.job_function, 'sales');
assert.strictEqual(d7.seniority_level, 'mid');

const d8 = enricher.resolveDeterministic({
  job_title_raw: 'Chief Happiness Officer',
  description_raw: '',
  location_raw: ''
});
assert.strictEqual(d8.job_function, null);
assert.strictEqual(d8.seniority_level, 'c_suite');

const d9 = enricher.resolveDeterministic({
  job_title_raw: 'Principal Engineer',
  description_raw: '',
  location_raw: ''
});
assert.strictEqual(d9.seniority_level, 'staff');

const d10 = enricher.resolveDeterministic({
  job_title_raw: 'Head of Product',
  description_raw: '',
  location_raw: ''
});
assert.strictEqual(d10.seniority_level, 'director');

const d11 = enricher.resolveDeterministic({
  job_title_raw: 'Manager',
  description_raw: '',
  location_raw: ''
});
assert.strictEqual(d11.seniority_level, 'mid');

const d12 = enricher.resolveDeterministic({
  job_title_raw: 'Engineering Manager',
  description_raw: '',
  location_raw: ''
});
assert.strictEqual(d12.seniority_level, 'unknown');

const d13 = enricher.resolveDeterministic({
  job_title_raw: 'Sr. Eng Mgr II',
  description_raw: '',
  location_raw: ''
});
assert.strictEqual(d13.job_title_normalized, 'Senior Engineer Manager');

const d14 = enricher.resolveDeterministic({
  job_title_raw: '  Jr Assoc Dir 4  ',
  description_raw: '',
  location_raw: ''
});
assert.strictEqual(d14.job_title_normalized, 'Junior Associate Director');

const d15 = enricher.resolveDeterministic({
  job_title_raw: 'VP, Engineering',
  description_raw: '',
  location_raw: ''
});
assert.strictEqual(d15.job_title_normalized, 'VP, Engineering');

const d16 = enricher.resolveDeterministic({
  job_title_raw: 'EVP Engineering',
  description_raw: '',
  location_raw: ''
});
assert.strictEqual(d16.job_title_normalized, 'EVP Engineering');

const d17 = enricher.resolveDeterministic({
  job_title_raw: 'Senior Product Manager',
  description_raw: '',
  location_raw: ''
});
assert.strictEqual(d17.job_function, 'product');
assert.strictEqual(d17.seniority_level, 'senior');
assert.strictEqual(d17.mba_relevance, 'high');

const d18 = enricher.resolveDeterministic({
  job_title_raw: 'Software Engineer Intern',
  description_raw: '',
  location_raw: ''
});
assert.strictEqual(d18.job_function, 'engineering');
assert.strictEqual(d18.seniority_level, 'intern');
assert.strictEqual(d18.mba_relevance, 'low');

console.log('enricher helper tests passed.');
