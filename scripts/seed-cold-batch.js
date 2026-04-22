#!/usr/bin/env node
/*
  Seed cold-batch cohort ids for companies that have not started profiling.

  Usage:
    node scripts/seed-cold-batch.js
    node scripts/seed-cold-batch.js --label pb_manual_2026-04-21

  Do not run while pipeline or another writer is updating data/companies.json.
*/

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '../data/companies.json');

function isBlank(value) {
  return value === undefined || value === null || value === '';
}

function defaultBatchLabel() {
  return `pb_${new Date().toISOString().slice(0, 10)}`;
}

function parseLabelArg(argv) {
  const idx = argv.indexOf('--label');
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (!value) {
    throw new Error('--label requires a value');
  }
  return value;
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyColdBatchTag(companies, label) {
  const nextCompanies = cloneJSON(companies);
  let taggedCount = 0;

  for (const company of nextCompanies) {
    if (!company) continue;
    if (!isBlank(company.profile_attempted_at)) continue;
    if (!isBlank(company.cold_batch_id)) continue;
    company.cold_batch_id = label;
    taggedCount += 1;
  }

  return { companies: nextCompanies, taggedCount };
}

function writeJSONAtomic(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function log(...args) {
  console.log('[seed-cold-batch]', ...args);
}

function main() {
  const argv = process.argv.slice(2);

  if (!fs.existsSync(DATA_PATH)) {
    console.error('No data/companies.json found');
    process.exit(1);
  }

  let companies;
  try {
    companies = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to read or parse companies.json:', err.message);
    process.exit(1);
  }

  if (!Array.isArray(companies)) {
    console.error('companies.json must be a JSON array');
    process.exit(1);
  }

  let label;
  try {
    label = parseLabelArg(argv) || defaultBatchLabel();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const { companies: nextCompanies, taggedCount } = applyColdBatchTag(companies, label);

  if (taggedCount === 0) {
    log(`No companies tagged for ${label}.`);
    return;
  }

  writeJSONAtomic(DATA_PATH, nextCompanies);
  log(`Tagged ${taggedCount} companies with ${label}.`);
}

if (require.main === module) {
  main();
}

module.exports = {
  applyColdBatchTag,
  defaultBatchLabel,
  parseLabelArg,
};
