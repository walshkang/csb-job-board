#!/usr/bin/env node
/*
  Pipeline Report — aggregates events from data/runs/pipeline-events-*.jsonl
  plus live orchestrator-snapshot.json.

    node scripts/pipeline-report.js               # latest run
    node scripts/pipeline-report.js --all         # every retained run
    node scripts/pipeline-report.js --watch       # refresh every 5s
    node scripts/pipeline-report.js --company=acme
*/

const fs = require('fs');
const path = require('path');
const { STAGES } = require('../src/utils/pipeline-stages');

const RUNS_DIR = path.join(__dirname, '..', 'data', 'runs');
const SNAPSHOT_PATH = path.join(RUNS_DIR, 'orchestrator-snapshot.json');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const flagValue = (n) => {
  const p = argv.find(a => a.startsWith(`--${n}=`));
  return p ? p.split('=').slice(1).join('=') : null;
};

const ALL = flag('all');
const WATCH = flag('watch');
const COMPANY = flagValue('company');

function listRuns() {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs.readdirSync(RUNS_DIR)
    .filter(f => f.startsWith('pipeline-events-') && f.endsWith('.jsonl'))
    .sort()
    .map(f => path.join(RUNS_DIR, f));
}

function readEvents(files) {
  const events = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      try { events.push(JSON.parse(l)); } catch (e) {}
    }
  }
  return events;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function print() {
  const files = listRuns();
  const selected = ALL ? files : files.slice(-1);
  if (!selected.length) {
    console.log('No event files found in data/runs/');
    return;
  }

  let events = readEvents(selected);
  if (COMPANY) {
    const needle = COMPANY.toLowerCase();
    events = events.filter(e => (e.company_name || '').toLowerCase().includes(needle) || e.company_id === COMPANY);
  }

  console.clear();
  console.log(`\nPipeline report  ${new Date().toLocaleTimeString()}`);
  console.log(`  source: ${ALL ? `${selected.length} runs` : path.basename(selected[0])}`);
  if (COMPANY) console.log(`  filter: company=${COMPANY}`);

  // Live snapshot
  if (fs.existsSync(SNAPSHOT_PATH)) {
    try {
      const snap = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
      console.log(`\n● LIVE  run=${snap.run_id}  uptime=${snap.uptime_sec}s${snap.dry_run ? '  [dry-run]' : ''}`);
      console.log(`  ${'stage'.padEnd(12)} ${'queued'.padStart(7)} ${'running'.padStart(8)} ${'thru/min'.padStart(9)}`);
      for (const s of STAGES) {
        console.log(`  ${s.padEnd(12)} ${String(snap.queue_depths[s]).padStart(7)} ${String(snap.in_flight[s]).padStart(8)} ${String(snap.throughput_per_min[s]).padStart(9)}`);
      }
    } catch (e) {}
  } else {
    console.log(`\n○ (no live orchestrator)`);
  }

  // Per-stage aggregates
  console.log(`\nStages  (events: ${events.length})`);
  console.log(`  ${'stage'.padEnd(12)} ${'ok'.padStart(5)} ${'none'.padStart(5)} ${'fail'.padStart(5)} ${'skip'.padStart(5)} ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'yield'.padStart(6)}`);
  for (const s of STAGES) {
    const se = events.filter(e => e.stage === s);
    const ok = se.filter(e => e.outcome === 'success');
    const none = se.filter(e => e.outcome === 'no_result');
    const fail = se.filter(e => e.outcome === 'failure');
    const skip = se.filter(e => e.outcome === 'skipped');
    const durs = ok.map(e => e.duration_ms).filter(n => typeof n === 'number');
    const total = ok.length + none.length + fail.length;
    const yieldPct = total ? ((ok.length / total) * 100).toFixed(0) + '%' : '-';
    console.log(`  ${s.padEnd(12)} ${String(ok.length).padStart(5)} ${String(none.length).padStart(5)} ${String(fail.length).padStart(5)} ${String(skip.length).padStart(5)} ${String(percentile(durs, 50)).padStart(5)}ms ${String(percentile(durs, 95)).padStart(5)}ms ${yieldPct.padStart(6)}`);
  }

  // Failure classes
  const failures = events.filter(e => e.outcome === 'failure');
  if (failures.length) {
    console.log(`\nFailure classes  (${failures.length} total)`);
    const byClass = {};
    for (const e of failures) {
      const k = `${e.stage}/${e.failure_class || 'unknown'}`;
      byClass[k] = (byClass[k] || 0) + 1;
    }
    const sorted = Object.entries(byClass).sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [k, n] of sorted) console.log(`  ${k.padEnd(30)} ${n}`);
  }

  // No-result reasons per stage
  const noResults = events.filter(e => e.outcome === 'no_result');
  if (noResults.length) {
    console.log(`\nNo-result reasons  (${noResults.length} total)`);
    const byReason = {};
    for (const e of noResults) {
      const reason = e.reason
        || (e.category_error ? 'category_error' : null)
        || (e.status_code ? `http_${e.status_code}` : null)
        || (e.jobs === 0 ? 'zero_jobs' : null)
        || (e.category === 'None' || e.category === null ? 'category_none' : null)
        || (e.ats_platform === null ? 'ats_undetected' : null)
        || 'unknown';
      const k = `${e.stage}/${reason}`;
      byReason[k] = (byReason[k] || 0) + 1;
    }
    const sorted = Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [k, n] of sorted) console.log(`  ${k.padEnd(40)} ${n}`);
  }

  // Slowest completions
  const slowest = events
    .filter(e => e.outcome === 'success' && typeof e.duration_ms === 'number')
    .sort((a, b) => b.duration_ms - a.duration_ms)
    .slice(0, 10);
  if (slowest.length) {
    console.log(`\nSlowest 10`);
    for (const e of slowest) {
      const name = (e.company_name || e.company_id || '?').slice(0, 30);
      console.log(`  ${String(e.duration_ms).padStart(6)}ms  ${e.stage.padEnd(12)} ${name}`);
    }
  }

  // Recent failures (last 10)
  const recentFail = failures.slice(-10);
  if (recentFail.length) {
    console.log(`\nRecent failures`);
    for (const e of recentFail) {
      const name = (e.company_name || e.company_id || '?').slice(0, 22);
      const msg = (e.error || '').slice(0, 60);
      console.log(`  ${e.stage.padEnd(12)} ${(e.failure_class || '?').padEnd(16)} ${name.padEnd(22)} ${msg}`);
    }
  }

  console.log('');
}

print();
if (WATCH) setInterval(print, 5000);
