#!/usr/bin/env node
/**
 * Tallies extract-stage `html_extract_path` from pipeline JSONL (latest run by default).
 *
 * Usage:
 *   node scripts/audit-extract-adapter-from-events.js
 *   node scripts/audit-extract-adapter-from-events.js --all
 *   node scripts/audit-extract-adapter-from-events.js --file=data/runs/pipeline-events-foo.jsonl
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const RUNS_DIR = path.join(REPO_ROOT, 'data', 'runs');

function listEventFiles() {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR)
    .filter((f) => f.startsWith('pipeline-events-') && f.endsWith('.jsonl'))
    .sort()
    .map((f) => path.join(RUNS_DIR, f));
}

function readEvents(files) {
  const events = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      try {
        events.push(JSON.parse(l));
      } catch (_) {}
    }
  }
  return events;
}

function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const fileArg = argv.find((a) => a.startsWith('--file='));
  const selectedFile = fileArg ? fileArg.split('=').slice(1).join('=') : null;

  let files;
  if (selectedFile) {
    const abs = path.isAbsolute(selectedFile) ? selectedFile : path.join(REPO_ROOT, selectedFile);
    if (!fs.existsSync(abs)) {
      console.error('File not found:', abs);
      process.exit(1);
    }
    files = [abs];
  } else {
    const list = listEventFiles();
    if (!list.length) {
      console.log('No pipeline-events-*.jsonl files in data/runs/');
      process.exit(0);
    }
    files = all ? list : list.slice(-1);
  }

  const events = readEvents(files);
  const extract = events.filter((e) => e.stage === 'extract');

  const byPath = {};
  let missingPath = 0;
  for (const e of extract) {
    const p = e.html_extract_path;
    if (p === undefined || p === null) {
      missingPath += 1;
      const k = '(missing)';
      byPath[k] = (byPath[k] || 0) + 1;
    } else {
      byPath[p] = (byPath[p] || 0) + 1;
    }
  }

  const adapter = extract.filter((e) => e.html_extract_path === 'adapter').length;
  const llm = extract.filter((e) => e.html_extract_path === 'llm').length;
  const denom = adapter + llm;
  const share = denom ? ((adapter / denom) * 100).toFixed(1) : '—';

  console.log('Extract adapter audit (pipeline events)');
  console.log(`  source: ${files.map((f) => path.basename(f)).join(', ')}`);
  console.log(`  extract events: ${extract.length}`);
  console.log('');
  console.log('  By html_extract_path:');
  const keys = Object.keys(byPath).sort();
  for (const k of keys) {
    console.log(`    ${k}: ${byPath[k]}`);
  }
  console.log('');
  console.log('  HTML branch (adapter + LLM only), adapter share:');
  console.log(`    adapter: ${adapter}`);
  console.log(`    llm: ${llm}`);
  console.log(`    adapter share of (adapter+llm): ${share}%`);
  console.log(`    xml_or_sitemap: ${extract.filter((e) => e.html_extract_path === 'xml_or_sitemap').length}`);
  if (missingPath) {
    console.log(`  (events without html_extract_path — emitted before instrumentation: ${missingPath})`);
  }
}

main();
