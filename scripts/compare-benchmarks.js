#!/usr/bin/env node
/**
 * Benchmark Comparison Tool
 *
 * Compares two benchmark reports side-by-side and highlights differences.
 *
 * Usage:
 *   node scripts/compare-benchmarks.js <report-a> <report-b>
 *   node scripts/compare-benchmarks.js baseline experiment-1
 *
 * Arguments can be:
 *   - Full paths to JSON files
 *   - Tag names (looked up in data/benchmarks/)
 *   - "latest" for the most recent report
 */

const fs = require('fs');
const path = require('path');

const BENCHMARKS_DIR = path.resolve(__dirname, '..', 'data', 'benchmarks');

function resolveReport(nameOrPath) {
  // Direct path
  if (fs.existsSync(nameOrPath)) return nameOrPath;
  // Tag name → look for latest matching file
  if (nameOrPath === 'latest') return path.join(BENCHMARKS_DIR, 'latest.json');
  // Search by tag prefix
  const files = fs.readdirSync(BENCHMARKS_DIR)
    .filter(f => f.startsWith(nameOrPath) && f.endsWith('.json'))
    .sort()
    .reverse();
  if (files.length > 0) return path.join(BENCHMARKS_DIR, files[0]);
  console.error(`Cannot find benchmark report: ${nameOrPath}`);
  process.exit(1);
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    console.error(`Failed to read ${p}: ${e.message}`);
    process.exit(1);
  }
}

function delta(a, b, fmt = 'number') {
  if (a === 0 && b === 0) return '—';
  if (a === 0) return '+∞';
  const pct = ((b - a) / a * 100).toFixed(1);
  const sign = pct > 0 ? '+' : '';
  if (fmt === 'ms') return `${sign}${pct}%`;
  if (fmt === 'cost') return `${sign}${pct}%`;
  return `${sign}${pct}%`;
}

function fmtMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function fmtChars(chars) {
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}K`;
  return `${chars}`;
}

function pad(str, len) {
  return String(str).padEnd(len);
}

function rpad(str, len) {
  return String(str).padStart(len);
}

function colorDelta(pctStr) {
  // In terminal, negative is good (green), positive is bad (red)
  if (pctStr === '—') return pctStr;
  const num = parseFloat(pctStr);
  if (isNaN(num)) return pctStr;
  if (num < -5) return `\x1b[32m${pctStr}\x1b[0m`;  // green — improvement
  if (num > 5) return `\x1b[31m${pctStr}\x1b[0m`;   // red — regression
  return pctStr;
}

// For success rates, higher is better → invert the color logic
function colorDeltaInverse(pctStr) {
  if (pctStr === '—') return pctStr;
  const num = parseFloat(pctStr);
  if (isNaN(num)) return pctStr;
  if (num > 5) return `\x1b[32m${pctStr}\x1b[0m`;   // green — improvement
  if (num < -5) return `\x1b[31m${pctStr}\x1b[0m`;  // red — regression
  return pctStr;
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));

if (args.length < 2) {
  console.log('Usage: node scripts/compare-benchmarks.js <report-a> <report-b>');
  console.log('  e.g.: node scripts/compare-benchmarks.js baseline experiment-1');
  process.exit(1);
}

const pathA = resolveReport(args[0]);
const pathB = resolveReport(args[1]);
const a = readJSON(pathA);
const b = readJSON(pathB);

const labelA = a.meta?.tag || path.basename(pathA, '.json');
const labelB = b.meta?.tag || path.basename(pathB, '.json');

const W = 18; // column width

console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║                    Benchmark Comparison                        ║');
console.log('╚══════════════════════════════════════════════════════════════════╝');
console.log(`  A: ${labelA} (${a.meta?.timestamp || '?'})`);
console.log(`  B: ${labelB} (${b.meta?.timestamp || '?'})`);
console.log(`  Companies: A=${a.meta?.n}, B=${b.meta?.n}`);

// Summary comparison
console.log('\n┌─ Summary ────────────────────────────────────────────────────────┐');
const rows = [
  ['Total duration', fmtMs(a.summary?.total_duration_ms || 0), fmtMs(b.summary?.total_duration_ms || 0), delta(a.summary?.total_duration_ms || 0, b.summary?.total_duration_ms || 0)],
  ['LLM calls', a.summary?.total_llm_calls || 0, b.summary?.total_llm_calls || 0, delta(a.summary?.total_llm_calls || 0, b.summary?.total_llm_calls || 0)],
  ['LLM failures', a.summary?.llm_failed || 0, b.summary?.llm_failed || 0, delta(a.summary?.llm_failed || 0, b.summary?.llm_failed || 0)],
  ['Avg LLM latency', fmtMs(a.summary?.avg_llm_latency_ms || 0), fmtMs(b.summary?.avg_llm_latency_ms || 0), delta(a.summary?.avg_llm_latency_ms || 0, b.summary?.avg_llm_latency_ms || 0)],
  ['P95 LLM latency', fmtMs(a.summary?.p95_llm_latency_ms || 0), fmtMs(b.summary?.p95_llm_latency_ms || 0), delta(a.summary?.p95_llm_latency_ms || 0, b.summary?.p95_llm_latency_ms || 0)],
  ['Prompt chars', fmtChars(a.summary?.total_prompt_chars || 0), fmtChars(b.summary?.total_prompt_chars || 0), delta(a.summary?.total_prompt_chars || 0, b.summary?.total_prompt_chars || 0)],
  ['Response chars', fmtChars(a.summary?.total_response_chars || 0), fmtChars(b.summary?.total_response_chars || 0), delta(a.summary?.total_response_chars || 0, b.summary?.total_response_chars || 0)],
  ['Est. cost', `$${a.summary?.estimated_cost_usd || 0}`, `$${b.summary?.estimated_cost_usd || 0}`, delta(a.summary?.estimated_cost_usd || 0, b.summary?.estimated_cost_usd || 0)],
  ['Jobs added', a.jobs?.added || 0, b.jobs?.added || 0, delta(a.jobs?.added || 0, b.jobs?.added || 0)],
];

console.log(`  ${pad('', 20)} ${rpad(labelA, W)} ${rpad(labelB, W)} ${rpad('Δ', 10)}`);
console.log(`  ${'─'.repeat(20)} ${'─'.repeat(W)} ${'─'.repeat(W)} ${'─'.repeat(10)}`);
for (const [label, va, vb, d] of rows) {
  console.log(`  ${pad(label, 20)} ${rpad(va, W)} ${rpad(vb, W)} ${colorDelta(d)}`);
}

// Per-stage comparison
console.log('\n┌─ Per-Stage Success Rates ────────────────────────────────────────┐');
const STAGES = ['discovery', 'fingerprint', 'scrape', 'extract', 'categorize'];
console.log(`  ${pad('Stage', 14)} ${rpad(labelA, W)} ${rpad(labelB, W)} ${rpad('Δ', 10)}`);
console.log(`  ${'─'.repeat(14)} ${'─'.repeat(W)} ${'─'.repeat(W)} ${'─'.repeat(10)}`);
for (const stage of STAGES) {
  const sa = a.per_stage?.[stage] || {};
  const sb = b.per_stage?.[stage] || {};
  const rateA = sa.success_rate_pct || 0;
  const rateB = sb.success_rate_pct || 0;
  const llmA = sa.llm_calls ? ` (${sa.llm_calls} LLM)` : '';
  const llmB = sb.llm_calls ? ` (${sb.llm_calls} LLM)` : '';
  console.log(`  ${pad(stage, 14)} ${rpad(`${rateA}%${llmA}`, W)} ${rpad(`${rateB}%${llmB}`, W)} ${colorDeltaInverse(delta(rateA, rateB))}`);
}

// LLM by agent comparison
console.log('\n┌─ LLM Calls by Agent ─────────────────────────────────────────────┐');
const allAgents = new Set([
  ...Object.keys(a.llm_by_agent || {}),
  ...Object.keys(b.llm_by_agent || {}),
]);
console.log(`  ${pad('Agent', 14)} ${rpad(`${labelA} calls`, W)} ${rpad(`${labelB} calls`, W)} ${rpad('Δ', 10)}`);
console.log(`  ${'─'.repeat(14)} ${'─'.repeat(W)} ${'─'.repeat(W)} ${'─'.repeat(10)}`);
for (const agent of allAgents) {
  const da = a.llm_by_agent?.[agent] || {};
  const db = b.llm_by_agent?.[agent] || {};
  const callsA = da.total_calls || 0;
  const callsB = db.total_calls || 0;
  const avgA = da.avg_latency_ms || 0;
  const avgB = db.avg_latency_ms || 0;
  console.log(`  ${pad(agent, 14)} ${rpad(`${callsA} (${fmtMs(avgA)})`, W)} ${rpad(`${callsB} (${fmtMs(avgB)})`, W)} ${colorDelta(delta(callsA, callsB))}`);
}

// Biggest movers
console.log('\n┌─ Key Takeaways ──────────────────────────────────────────────────┐');

const durationDelta = (b.summary?.total_duration_ms || 0) - (a.summary?.total_duration_ms || 0);
const llmDelta = (b.summary?.total_llm_calls || 0) - (a.summary?.total_llm_calls || 0);
const costDelta = (b.summary?.estimated_cost_usd || 0) - (a.summary?.estimated_cost_usd || 0);

if (durationDelta < 0) console.log(`  ✅ ${labelB} is ${Math.abs(durationDelta / 1000).toFixed(1)}s faster`);
else if (durationDelta > 0) console.log(`  ⚠️  ${labelB} is ${(durationDelta / 1000).toFixed(1)}s slower`);

if (llmDelta < 0) console.log(`  ✅ ${labelB} uses ${Math.abs(llmDelta)} fewer LLM calls`);
else if (llmDelta > 0) console.log(`  ⚠️  ${labelB} uses ${llmDelta} more LLM calls`);

if (costDelta < 0) console.log(`  ✅ ${labelB} costs $${Math.abs(costDelta).toFixed(4)} less`);
else if (costDelta > 0) console.log(`  ⚠️  ${labelB} costs $${costDelta.toFixed(4)} more`);

const jobsDeltaVal = (b.jobs?.added || 0) - (a.jobs?.added || 0);
if (jobsDeltaVal > 0) console.log(`  ✅ ${labelB} found ${jobsDeltaVal} more jobs`);
else if (jobsDeltaVal < 0) console.log(`  ⚠️  ${labelB} found ${Math.abs(jobsDeltaVal)} fewer jobs`);

console.log('');
