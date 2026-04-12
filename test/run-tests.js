#!/usr/bin/env node
const path = require('path');
const fs = require('fs');

const testsDir = __dirname;
const files = fs.readdirSync(testsDir).filter(f => f.endsWith('.js') && f !== 'run-tests.js');

let failures = 0;
for (const f of files) {
  console.log('Running', f);
  try {
    require(path.join(testsDir, f));
  } catch (err) {
    console.error('Test failed:', f);
    console.error(err.stack || err);
    failures++;
  }
}

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log('All tests passed');
