#!/usr/bin/env node
/*
  Temporal Agent (Slice 6)
  Usage: node src/agents/temporal.js [--dry-run] [--verbose]

  Responsibilities:
  - Update last_seen_at for jobs seen in the most recent scrape run
  - Mark removed_at for jobs no longer present for that company's latest run
  - Compute days_live for every job
  - Update consecutive_empty_scrapes and dormant on companies.json

  Conventions:
  - Load .env.local with inline parser (no external dependency)
  - Atomic JSON writes: write to .tmp then fs.renameSync
  - No external dependencies beyond Node built-ins
*/

const fs = require('fs');
const path = require('path');
require('../config'); // loads .env.local as a side effect

function log(...args) { console.log('[temporal]', ...args); }
function verboseLog(enabled, ...args) { if (enabled) console.log('[temporal]', ...args); }

function atomicWriteJson(destPath, obj) {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${destPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, destPath);
}

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to read/parse JSON at ${p}: ${err.message}`);
  }
}

// Helpers to extract seen URLs / job-count from a scrape run entry
function getSeenUrlsFromRun(run) {
  if (!run) return [];
  // Common keys that scraper might use
  const listKeys = ['seen_urls', 'job_urls', 'jobs', 'found_urls', 'found_jobs', 'urls'];
  for (const k of listKeys) {
    const v = run[k];
    if (Array.isArray(v) && v.length) return v.map(String);
    // sometimes jobs may be an array of objects with source_url
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      const mapped = v.map(it => it.source_url || it.url || it.source || it);
      if (mapped.some(Boolean)) return mapped.filter(Boolean).map(String);
    }
  }
  // Some runs may include a job_count but not the URLs; return empty to indicate none seen
  return [];
}

function getRunJobCount(run) {
  if (!run) return 0;
  if (typeof run.job_count === 'number') return run.job_count;
  if (typeof run.count === 'number') return run.count;
  if (typeof run.jobs_count === 'number') return run.jobs_count;
  // If jobs array present
  for (const k of ['jobs', 'job_urls', 'seen_urls', 'found_jobs', 'urls', 'found_urls']) {
    const v = run[k];
    if (Array.isArray(v)) return v.length;
  }
  return 0;
}

// Update jobs based on lastRunSeenUrls map: { company_id -> Set(urls) }
function updateJobsForLastRun(jobs, lastRun, nowIso) {
  const stats = { updated: 0, removed: 0 };
  if (!Array.isArray(jobs)) return stats;
  if (!lastRun || !lastRun.company_id) return stats;
  const companyId = lastRun.company_id;
  const seen = new Set(getSeenUrlsFromRun(lastRun).map(String));

  for (const job of jobs) {
    if (job.company_id !== companyId) continue;
    // Seen in this run -> update last_seen_at
    if (seen.size && job.source_url && seen.has(String(job.source_url))) {
      job.last_seen_at = nowIso;
      stats.updated++;
    } else if (seen.size) {
      // Company scraped but job's source_url not present in this run
      if (!job.removed_at) {
        job.removed_at = nowIso;
        stats.removed++;
      }
    }
    // Recompute days_live if dates available
    try {
      const first = job.first_seen_at ? Date.parse(job.first_seen_at) : NaN;
      const last = job.last_seen_at ? Date.parse(job.last_seen_at) : NaN;
      if (!Number.isNaN(first) && !Number.isNaN(last)) {
        const days = Math.floor((last - first) / 86400000);
        job.days_live = days >= 0 ? days : 0;
      } else {
        job.days_live = 0;
      }
    } catch (err) {
      job.days_live = 0;
    }
  }
  return stats;
}

// Update companies with consecutive_empty_scrapes and dormancy based on all scrape_runs
function updateCompaniesDormancy(companies, scrapeRuns, verbose) {
  const stats = { goneDormant: 0, reactivated: 0 };
  if (!Array.isArray(companies)) return stats;
  if (!Array.isArray(scrapeRuns)) scrapeRuns = [];

  // Build per-company runs list, most-recent-first (input array is oldest-first / append order).
  const runsByCompany = new Map();
  for (let i = scrapeRuns.length - 1; i >= 0; i--) {
    const r = scrapeRuns[i];
    const k = r && r.company_id ? String(r.company_id) : '__unknown__';
    if (!runsByCompany.has(k)) runsByCompany.set(k, []);
    runsByCompany.get(k).push(r);
  }

  for (const company of companies) {
    const cid = String(company.id || company.company_id || company._id || '');
    const runs = runsByCompany.get(cid) || [];
    let consecutive = 0;
    for (const r of runs) {
      const jobCount = getRunJobCount(r);
      if (jobCount === 0) consecutive++;
      else break;
    }
    company.consecutive_empty_scrapes = consecutive;

    const wasDormant = !!company.dormant;
    if (consecutive >= 3) {
      company.dormant = true;
      if (!wasDormant) stats.goneDormant++;
    } else {
      // If last run had any jobs, reset dormancy
      const lastRun = runs[0] || null;
      const lastCount = lastRun ? getRunJobCount(lastRun) : 0;
      if (lastCount > 0) {
        if (wasDormant) stats.reactivated++;
        company.dormant = false;
        company.consecutive_empty_scrapes = 0;
      } else {
        company.dormant = false;
      }
    }
    verboseLog(verbose, `company ${cid}: consecutive=${company.consecutive_empty_scrapes} dormant=${company.dormant}`);
  }
  return stats;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const verbose = argv.includes('--verbose');

  const dataDir = path.join(process.cwd(), 'data');
  const jobsPath = path.join(dataDir, 'jobs.json');
  const runsPath = path.join(dataDir, 'scrape_runs.json');
  const companiesPath = path.join(dataDir, 'companies.json');

  const jobs = readJsonSafe(jobsPath) || [];
  const runs = readJsonSafe(runsPath) || [];
  const companies = readJsonSafe(companiesPath) || [];

  if (!runs.length) {
    console.error('No scrape_runs found; nothing to do.');
    process.exit(1);
  }

  const lastRun = runs[runs.length - 1];
  const nowIso = new Date().toISOString();

  verboseLog(verbose, 'Processing last run:', lastRun && lastRun.company_id, 'scraped_at', lastRun && lastRun.scraped_at);

  const jobStats = updateJobsForLastRun(jobs, lastRun, nowIso);
  const companyStats = updateCompaniesDormancy(companies, runs, verbose);

  // Write back
  if (!dryRun) {
    atomicWriteJson(jobsPath, jobs);
    atomicWriteJson(companiesPath, companies);
  }

  // Summary
  log(`jobs updated: ${jobStats.updated}, jobs marked removed: ${jobStats.removed}`);
  log(`companies gone dormant: ${companyStats.goneDormant}, companies reactivated: ${companyStats.reactivated}`);
  if (dryRun) log('Dry-run: no files modified');
}

if (require.main === module) {
  main().catch(err => {
    console.error('Temporal agent failed:', err && err.message || err);
    process.exit(2);
  });
}

// Exports for unit tests
module.exports = {
  getSeenUrlsFromRun,
  getRunJobCount,
  updateJobsForLastRun,
  updateCompaniesDormancy
};
