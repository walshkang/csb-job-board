#!/usr/bin/env node
/*
  Pipeline Status — snapshot of all stages for the streaming orchestrator.

    node scripts/pipeline-status.js
    node scripts/pipeline-status.js --watch
*/

const fs = require('fs');
const path = require('path');
const { STAGES, getStage } = require('../src/utils/pipeline-stages');

const COMPANIES_PATH = path.join(__dirname, '../data/companies.json');
const JOBS_PATH = path.join(__dirname, '../data/jobs.json');

function printStatus() {
  if (!fs.existsSync(COMPANIES_PATH)) {
    console.error('No data/companies.json found');
    process.exit(1);
  }

  const companies = JSON.parse(fs.readFileSync(COMPANIES_PATH, 'utf8'));
  const mtime = fs.statSync(COMPANIES_PATH).mtime;
  const ageSec = Math.round((Date.now() - mtime.getTime()) / 1000);
  const ageStr = ageSec < 60 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ${ageSec % 60}s ago`;

  let jobsCount = 0;
  try { jobsCount = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8')).length; } catch (e) {}

  const tally = { discovery: 0, fingerprint: 0, scrape: 0, extract: 0, categorize: 0, done: 0 };
  for (const c of companies) tally[getStage(c)]++;

  const reachable = companies.filter(c => c.careers_page_reachable === true).length;
  const unreachable = companies.filter(c => c.careers_page_reachable === false).length;
  const discoveryProcessed = companies.filter(c => c.careers_page_discovery_method).length;

  console.clear();
  console.log(`\nPipeline status  ${new Date().toLocaleTimeString()}`);
  console.log(`  companies.json: ${ageStr}`);
  if (ageSec > 30) console.log(`  ⚠  No save in ${ageStr} — orchestrator idle or stuck?`);

  const total = companies.length;
  console.log(`\nStage breakdown  (total ${total})`);
  for (const s of [...STAGES, 'done']) {
    const pct = total ? ((tally[s] / total) * 100).toFixed(1) : '0.0';
    const bar = '█'.repeat(Math.round(tally[s] / total * 30)) + '░'.repeat(30 - Math.round(tally[s] / total * 30));
    console.log(`  ${s.padEnd(12)} ${String(tally[s]).padStart(4)}  ${bar} ${pct}%`);
  }

  console.log(`\nDiscovery`);
  console.log(`  processed:    ${discoveryProcessed}/${total}`);
  console.log(`  reachable:    ${reachable}`);
  console.log(`  unreachable:  ${unreachable}`);

  console.log(`\nJobs in data/jobs.json: ${jobsCount}`);
  console.log('');
}

const watch = process.argv.includes('--watch');
printStatus();
if (watch) {
  setInterval(printStatus, 5000);
  console.log('Watching — Ctrl+C to stop');
}
