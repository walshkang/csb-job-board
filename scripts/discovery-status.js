#!/usr/bin/env node
/*
  Discovery Status — read-only snapshot of discovery progress.
  Run in a second terminal while discovery is running:

    node scripts/discovery-status.js
    node scripts/discovery-status.js --watch        # refresh every 10s
    node scripts/discovery-status.js --debug-log    # tail the debug JSONL if present
*/

const fs = require('fs');
const path = require('path');

const COMPANIES_PATH = path.join(__dirname, '../data/companies.json');
const RUNS_DIR = path.join(__dirname, '../data/runs');

function latestDebugLog() {
  if (!fs.existsSync(RUNS_DIR)) return null;
  const files = fs.readdirSync(RUNS_DIR)
    .filter(f => f.startsWith('discovery-debug-') && f.endsWith('.jsonl'))
    .sort()
    .reverse();
  return files.length ? path.join(RUNS_DIR, files[0]) : null;
}

function printStatus() {
  if (!fs.existsSync(COMPANIES_PATH)) {
    console.error('No data/companies.json found');
    process.exit(1);
  }

  const raw = fs.readFileSync(COMPANIES_PATH, 'utf8');
  const companies = JSON.parse(raw);
  const mtime = fs.statSync(COMPANIES_PATH).mtime;
  const ageMs = Date.now() - mtime.getTime();
  const ageSec = Math.round(ageMs / 1000);
  const ageStr = ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ${ageSec % 60}s ago`;

  const withDomain = companies.filter(c => c.domain);
  const processed = withDomain.filter(c => c.careers_page_discovery_method);
  const reachable = withDomain.filter(c => c.careers_page_reachable === true);
  const notFound = withDomain.filter(c => c.careers_page_reachable === false);
  const unprocessed = withDomain.filter(c => !c.careers_page_discovery_method);

  const hitRate = processed.length > 0
    ? ((reachable.length / processed.length) * 100).toFixed(1)
    : '0.0';

  // Method breakdown (hits only)
  const methodCounts = {};
  for (const c of reachable) {
    const m = c.careers_page_discovery_method || 'unknown';
    methodCounts[m] = (methodCounts[m] || 0) + 1;
  }

  // Failure reason breakdown
  const failureCounts = {};
  for (const c of notFound) {
    const r = c.careers_page_failure_reason || 'unclassified';
    failureCounts[r] = (failureCounts[r] || 0) + 1;
  }

  console.clear();
  console.log(`\nDiscovery status  ${new Date().toLocaleTimeString()}`);
  console.log(`  companies.json last updated: ${ageStr}`);
  if (ageSec > 60) console.log(`  ⚠  No update in ${ageStr} — may be stuck on a slow domain`);

  console.log(`\nProgress`);
  const pct = withDomain.length > 0 ? Math.round(processed.length / withDomain.length * 100) : 0;
  const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
  console.log(`  [${bar}] ${processed.length}/${withDomain.length} (${pct}%)`);
  console.log(`  reachable:    ${reachable.length}  (${hitRate}% hit rate)`);
  console.log(`  not_found:    ${notFound.length}`);
  console.log(`  unprocessed:  ${unprocessed.length}`);

  if (Object.keys(methodCounts).length > 0) {
    console.log(`\nHit methods`);
    for (const [m, n] of Object.entries(methodCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${m.padEnd(28)} ${n}`);
    }
  }

  if (Object.keys(failureCounts).length > 0) {
    console.log(`\nFailure reasons`);
    for (const [r, n] of Object.entries(failureCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${r.padEnd(28)} ${n}`);
    }
  }

  // Tail debug log if present
  const debugLog = latestDebugLog();
  if (debugLog) {
    const lines = fs.readFileSync(debugLog, 'utf8').trim().split('\n').filter(Boolean);
    const recent = lines.slice(-5).map(l => {
      try {
        const e = JSON.parse(l);
        const status = e.found ? '✓' : '✗';
        const reason = e.failure_reason ? ` [${e.failure_reason}]` : '';
        return `  ${status} ${(e.company || e.domain || '?').padEnd(30)} ${e.steps ? e.steps[e.steps.length - 1] || '' : ''}${reason}`;
      } catch { return `  ${l.slice(0, 80)}`; }
    });
    console.log(`\nRecent (from ${path.basename(debugLog)})`);
    for (const l of recent) console.log(l);
  }

  console.log('');
}

const watch = process.argv.includes('--watch');
printStatus();
if (watch) {
  setInterval(printStatus, 10000);
  console.log('Watching — Ctrl+C to stop');
}
