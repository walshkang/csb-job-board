#!/usr/bin/env node
/*
  Backfill profile stage for companies missing profile_attempted_at.

  Usage: node scripts/backfill-profile.js [--dry-run] [--verbose]

  Do not run while pipeline or another writer is updating data/companies.json.
*/

const fs = require('fs');
const path = require('path');
const PQueue = require('p-queue').default;
const { profileCompany } = require('../src/agents/profile');
const { closeBrowser } = require('../src/utils/browser');

const DATA_PATH = path.join(__dirname, '../data/companies.json');
const CONCURRENCY = 6;
const BATCH_SAVE_SIZE = 20;

function isBlankProfileAttempted(value) {
  return value === undefined || value === null || value === '';
}

function writeJSONAtomic(p, obj) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function log(...args) {
  console.log('[backfill-profile]', ...args);
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const verbose = argv.includes('--verbose');

  if (!fs.existsSync(DATA_PATH)) {
    console.error('No data/companies.json found');
    process.exit(1);
  }

  let companies;
  try {
    companies = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (e) {
    console.error('Failed to read or parse companies.json:', e.message);
    process.exit(1);
  }

  if (!Array.isArray(companies)) {
    console.error('companies.json must be a JSON array');
    process.exit(1);
  }

  const targets = companies.filter(c => c && isBlankProfileAttempted(c.profile_attempted_at));

  if (dryRun) {
    log(`dry-run: would profile ${targets.length} companies`);
    if (verbose && targets.length) {
      for (const c of targets) {
        log('  ', c.id, c.name || c.domain || '');
      }
    }
    process.exit(0);
  }

  if (targets.length === 0) {
    log('Nothing to do (all companies have profile_attempted_at set).');
    await closeBrowser();
    return;
  }

  log(`Profiling ${targets.length} companies (concurrency=${CONCURRENCY}, save every ${BATCH_SAVE_SIZE})`);

  let processedSinceSave = 0;
  /** Serialize batch counter + saves so concurrent workers cannot skew counts mid-flush. */
  let batchTail = Promise.resolve();

  function afterProfileDone() {
    batchTail = batchTail.then(() => {
      processedSinceSave++;
      if (processedSinceSave >= BATCH_SAVE_SIZE) {
        writeJSONAtomic(DATA_PATH, companies);
        processedSinceSave = 0;
      }
    });
    return batchTail;
  }

  const queue = new PQueue({ concurrency: CONCURRENCY });

  for (const company of targets) {
    queue.add(async () => {
      const label = company.name || company.id || company.domain || '?';
      try {
        await profileCompany(company, { verbose });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error('[backfill-profile] error', label, msg);
        if (!company.company_profile) company.company_profile = {};
        company.careers_hints = [];
        company.profile_attempted_at = new Date().toISOString();
      }

      await afterProfileDone();
    });
  }

  await queue.onIdle();
  await batchTail;

  if (processedSinceSave > 0) {
    writeJSONAtomic(DATA_PATH, companies);
  }

  log('Done.');
  await closeBrowser();
}

main().catch(err => {
  console.error('[backfill-profile] fatal:', err && err.message ? err.message : err);
  process.exit(1);
});
