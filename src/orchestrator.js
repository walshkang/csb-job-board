#!/usr/bin/env node
/*
  Streaming pipeline orchestrator.

  Runs profile → discovery → fingerprint → scrape → extract → categorize concurrently,
  per-stage queues with independent concurrency caps. Companies flow through
  stages independently; one slow company doesn't block others.

  Crash-resume: reads state from companies.json + jobs.json + artifacts on start,
  routes each company to its current stage. No in-orchestrator retries — failures
  are logged and picked up on next run.
*/

const fs = require('fs');
const path = require('path');
const PQueue = require('p-queue').default;

const REPO_ROOT = path.resolve(__dirname, '..');
const COMPANIES_PATH = path.join(REPO_ROOT, 'data', 'companies.json');
const JOBS_PATH = path.join(REPO_ROOT, 'data', 'jobs.json');
const TAX_PATH = path.join(REPO_ROOT, 'data', 'climate-tech-map-industry-categories.json');
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts', 'html');

const config = require('./config');
const { profileCompany } = require('./agents/profile');
const { processCompany } = require('./agents/discovery');
const { fingerprintCompany } = require('./agents/fingerprinter');
const { scrapeCompany } = require('./agents/scraper');
const { extractCompanyJobs, mergeJobs } = require('./agents/extraction');
const { categorizeCompany } = require('./agents/categorizer');
const { getStage, nextStage, STAGES } = require('./utils/pipeline-stages');
const { EventSink, writeSnapshot, clearSnapshot, classifyFailure } = require('./utils/pipeline-events');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const flagValue = (name) => {
  // Support both --name=val and --name val
  const eqIdx = argv.findIndex(a => a.startsWith(`--${name}=`));
  if (eqIdx !== -1) return argv[eqIdx].split('=').slice(1).join('=');
  const spaceIdx = argv.indexOf(`--${name}`);
  if (spaceIdx !== -1 && argv[spaceIdx + 1] && !argv[spaceIdx + 1].startsWith('--')) {
    return argv[spaceIdx + 1];
  }
  return null;
};

const LIMIT = flagValue('limit') ? parseInt(flagValue('limit'), 10) : null;
const COMPANY_FILTER = flagValue('company');
const STAGES_FILTER = flagValue('stages') ? flagValue('stages').split(',').map(s => s.trim()) : null;
const DRY_RUN = flag('dry-run');
const VERBOSE = flag('verbose');

const CONCURRENCIES = {
  profile: 6,
  discovery: 8,
  fingerprint: 4,
  scrape: 5,
  extract: 4,
  categorize: 3,
};

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

function writeJSONAtomic(p, obj) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function log(stage, company, status, detail = '') {
  const name = company.name || company.id || '?';
  const line = `[${stage}] ${name} ${status}${detail ? ` ${detail}` : ''}`;
  process.stderr.write(line + '\n');
}

// ——————————————————————————————————————————————————————————————
// Setup
// ——————————————————————————————————————————————————————————————

const companies = readJSON(COMPANIES_PATH, null);
if (!companies) { console.error('No data/companies.json'); process.exit(1); }

const initialJobs = readJSON(JOBS_PATH, []);
const taxonomy = readJSON(TAX_PATH, []);

const categorizerAgent = (() => {
  try { return config.resolveAgent('categorizer'); } catch (e) { return null; }
})();

// Representative jobs for categorizer: seed from existing jobs.json, update as extract completes
const repJobByCompany = new Map();
for (const j of initialJobs) {
  if (!j || !j.company_id) continue;
  const existing = repJobByCompany.get(j.company_id);
  if (!existing || (j.last_enriched_at && !existing.last_enriched_at)) {
    repJobByCompany.set(j.company_id, j);
  }
}

// Accumulate newly extracted jobs; flush to jobs.json on save
const newJobsBuffer = [];

// ——————————————————————————————————————————————————————————————
// Filtering target set
// ——————————————————————————————————————————————————————————————

let targets = companies;
if (COMPANY_FILTER) {
  const names = COMPANY_FILTER.split(',').map(s => s.trim().toLowerCase());
  targets = targets.filter(c => names.includes((c.name || '').toLowerCase()) || names.includes(c.id));
}
if (LIMIT) targets = targets.slice(0, LIMIT);

const stageFilterSet = STAGES_FILTER ? new Set(STAGES_FILTER) : null;

// ——————————————————————————————————————————————————————————————
// Queues
// ——————————————————————————————————————————————————————————————

const queues = {};
for (const s of STAGES) queues[s] = new PQueue({ concurrency: CONCURRENCIES[s] });

const stats = { started: {}, completed: {}, no_result: {}, failed: {}, skipped: {} };
for (const s of STAGES) {
  stats.started[s] = 0; stats.completed[s] = 0; stats.no_result[s] = 0; stats.failed[s] = 0; stats.skipped[s] = 0;
}

const events = new EventSink();
const startedAt = Date.now();
const recentCompletions = []; // {ts, stage} for throughput calc

let dirty = false;
const markDirty = () => { dirty = true; };

// ——————————————————————————————————————————————————————————————
// Stage handlers
// ——————————————————————————————————————————————————————————————

// Each handler returns { outcome, extra } where outcome ∈ 'success' | 'no_result' | 'skipped'.
// Exceptions -> 'failure' (handled by caller).
async function runStage(stage, c) {
  if (stage === 'profile') {
    await profileCompany(c, { verbose: VERBOSE });
    c.profile_attempted_at = new Date().toISOString();
    const desc = (c.company_profile && String(c.company_profile.description).trim()) || '';
    const hints = Array.isArray(c.careers_hints) ? c.careers_hints : [];
    const hasSignal = desc.length > 0 || hints.length >= 1;
    return {
      outcome: hasSignal ? 'success' : 'no_result',
      extra: {
        description_present: desc.length > 0,
        description_len: desc.length,
        careers_hints_count: hints.length,
      },
    };
  }

  if (stage === 'discovery') {
    await processCompany(c, {});
    if (c.careers_page_reachable === true) {
      return { outcome: 'success', extra: { method: c.careers_page_discovery_method, url: c.careers_page_url } };
    }
    return { outcome: 'no_result', extra: {
      reason: c.careers_page_failure_reason || 'not_found',
      method: c.careers_page_discovery_method,
    }};
  }

  if (stage === 'fingerprint') {
    // Best-effort stage: always a success if it didn't throw. Record what was learned.
    await fingerprintCompany(c, { artifactsDir: ARTIFACTS_DIR });
    c.fingerprint_attempted_at = new Date().toISOString();
    return { outcome: c.ats_platform ? 'success' : 'no_result', extra: {
      ats_platform: c.ats_platform || null,
      ats_detection_source: c.ats_detection_source || null,
    }};
  }

  if (stage === 'scrape') {
    if (!c.careers_page_reachable) return { outcome: 'skipped', extra: { reason: 'unreachable' } };
    const result = await scrapeCompany(c, { verbose: VERBOSE });
    c.last_scraped_at = new Date().toISOString();
    if (result && result.last_scrape_signature) c.last_scrape_signature = result.last_scrape_signature;
    if (result && result.skipped_signature_match) {
      c.last_scrape_outcome = 'skipped_signature_match';
      return { outcome: 'skipped_signature_match', extra: {
        method: result.method,
        status_code: result.status_code,
        preflight_url_count: result.preflight_url_count || result.job_count || 0,
      }};
    }
    c.last_scrape_outcome = (result && result.success) ? 'success' : 'no_result';
    if (result && result.success) {
      return { outcome: 'success', extra: {
        method: result.method, status_code: result.status_code, byte_length: result.byte_length,
      }};
    }
    return { outcome: 'no_result', extra: {
      method: result && result.method, status_code: result && result.status_code,
      error: result && result.error,
    }};
  }

  if (stage === 'extract') {
    if (!c.careers_page_reachable) return { outcome: 'skipped', extra: { reason: 'unreachable' } };
    const res = await extractCompanyJobs(c, { verbose: VERBOSE });
    c.last_extracted_at = new Date().toISOString();
    if (res && Array.isArray(res.jobs)) {
      for (const j of res.jobs) newJobsBuffer.push(j);
      if (res.jobs.length && !repJobByCompany.has(c.id)) {
        repJobByCompany.set(c.id, res.jobs[0]);
      }
    }
    if (res && res.processed && res.jobs.length > 0) {
      return { outcome: 'success', extra: { jobs: res.jobs.length } };
    }
    return { outcome: 'no_result', extra: {
      processed: !!(res && res.processed),
      jobs: res && res.jobs ? res.jobs.length : 0,
      errors: res && res.errors && res.errors.length ? res.errors.length : 0,
    }};
  }

  if (stage === 'categorize') {
    if (!categorizerAgent) throw new Error('categorizer LLM config unavailable');
    let rep = repJobByCompany.get(c.id);
    if (!rep) {
      const cp = c.company_profile || {};
      const desc = (cp.description && String(cp.description).trim()) || c.name || '';
      rep = { job_title_normalized: '', job_function: '', description_summary: desc, climate_relevance_reason: '' };
    }
    const { provider, apiKey, model } = categorizerAgent;
    await categorizeCompany(c, rep, taxonomy, { provider, apiKey, model, dryRun: DRY_RUN }, []);
    if (c.climate_tech_category && c.climate_tech_category !== 'None') {
      return { outcome: 'success', extra: {
        category: c.climate_tech_category, confidence: c.category_confidence, resolver: c.category_resolver || 'llm',
      }};
    }
    return { outcome: 'no_result', extra: {
      category: c.climate_tech_category || null,
      category_error: c.category_error || null,
      resolver: c.category_resolver || null,
    }};
  }

  throw new Error(`unknown stage: ${stage}`);
}

// ——————————————————————————————————————————————————————————————
// Enqueue + chain
// ——————————————————————————————————————————————————————————————

function enqueue(c) {
  const stage = getStage(c);
  if (stage === 'done') return;
  if (stageFilterSet && !stageFilterSet.has(stage)) return;

  queues[stage].add(async () => {
    stats.started[stage]++;
    const t0 = Date.now();
    let outcome = 'failure';
    let extra = {};
    let shouldAdvance = false;

    try {
      const res = await runStage(stage, c);
      outcome = res.outcome;
      extra = res.extra || {};
      const ms = Date.now() - t0;
      markDirty();
      recentCompletions.push({ ts: Date.now(), stage });

      if (outcome === 'success') {
        stats.completed[stage]++;
        events.emit(stage, c, 'success', { duration_ms: ms, ...extra });
        log(stage, c, '✓', `${ms}ms`);
        shouldAdvance = true;
      } else if (outcome === 'no_result') {
        stats.no_result[stage]++;
        events.emit(stage, c, 'no_result', { duration_ms: ms, ...extra });
        log(stage, c, '∅', `${ms}ms ${JSON.stringify(extra)}`);
        // For discovery/fingerprint/profile, advance anyway — getStage handles skip-to-categorize
        // and fingerprint/profile are best-effort. For scrape/extract/categorize, don't advance.
        shouldAdvance = stage === 'discovery' || stage === 'fingerprint' || stage === 'profile';
      } else if (outcome === 'skipped') {
        stats.skipped[stage]++;
        events.emit(stage, c, 'skipped', { duration_ms: ms, ...extra });
        log(stage, c, '⊘', JSON.stringify(extra));
        // Skipped stages should advance so getStage re-evaluates (categorize still runs).
        shouldAdvance = true;
      } else if (outcome === 'skipped_signature_match') {
        stats.skipped[stage]++;
        events.emit(stage, c, 'skipped_signature_match', { duration_ms: ms, ...extra });
        log(stage, c, '⊘', `${ms}ms signature-match`);
        shouldAdvance = true;
      }
    } catch (err) {
      const ms = Date.now() - t0;
      stats.failed[stage]++;
      const failure_class = classifyFailure(stage, err, null);
      events.emit(stage, c, 'failure', {
        duration_ms: ms,
        failure_class,
        error: (err && err.message) ? err.message.slice(0, 500) : String(err),
      });
      log(stage, c, '✗', `[${failure_class}] ${(err && err.message) ? err.message.slice(0, 120) : String(err)}`);
      shouldAdvance = false;
    }

    if (shouldAdvance) enqueue(c);
  });
}

// ——————————————————————————————————————————————————————————————
// Periodic save
// ——————————————————————————————————————————————————————————————

async function flushSave() {
  if (!dirty || DRY_RUN) return;
  dirty = false;
  try {
    writeJSONAtomic(COMPANIES_PATH, companies);
  } catch (e) {
    console.error('companies.json save failed:', e.message);
  }
  if (newJobsBuffer.length) {
    try {
      const current = readJSON(JOBS_PATH, []);
      const merged = mergeJobs(current, newJobsBuffer.splice(0));
      writeJSONAtomic(JOBS_PATH, merged);
    } catch (e) {
      console.error('jobs.json save failed:', e.message);
    }
  }
}

let saveTimer = setInterval(flushSave, 5000);

function snapshot() {
  // Trim recentCompletions to last 60s
  const cutoff = Date.now() - 60000;
  while (recentCompletions.length && recentCompletions[0].ts < cutoff) recentCompletions.shift();
  const throughputPerStage = {};
  for (const s of STAGES) throughputPerStage[s] = 0;
  for (const e of recentCompletions) throughputPerStage[e.stage]++;

  const queueDepths = {};
  const inFlight = {};
  for (const s of STAGES) {
    queueDepths[s] = queues[s].size; // waiting
    inFlight[s] = queues[s].pending; // running
  }

  writeSnapshot({
    run_id: events.runId,
    started_at: new Date(startedAt).toISOString(),
    updated_at: new Date().toISOString(),
    uptime_sec: Math.round((Date.now() - startedAt) / 1000),
    queue_depths: queueDepths,
    in_flight: inFlight,
    stats,
    throughput_per_min: throughputPerStage,
    dry_run: DRY_RUN,
  });
}
let snapshotTimer = setInterval(snapshot, 5000);

// ——————————————————————————————————————————————————————————————
// Bootstrap + shutdown
// ——————————————————————————————————————————————————————————————

function printSummary() {
  process.stderr.write('\n== pipeline summary ==\n');
  for (const s of STAGES) {
    process.stderr.write(`  ${s.padEnd(12)} ok=${stats.completed[s]} no_result=${stats.no_result[s]} failed=${stats.failed[s]} skipped=${stats.skipped[s]}\n`);
  }
  process.stderr.write('\n');
}

let shuttingDown = false;
async function shutdown(reason = 'done') {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(saveTimer);
  clearInterval(snapshotTimer);
  await flushSave();
  snapshot();
  events.close();
  clearSnapshot();
  printSummary();
  process.stderr.write(`orchestrator exit: ${reason}\n`);
  process.stderr.write(`events: ${events.path}\n`);
}

process.on('SIGINT', async () => { await shutdown('SIGINT'); process.exit(130); });
process.on('SIGTERM', async () => { await shutdown('SIGTERM'); process.exit(143); });

(async function main() {
  process.stderr.write(`Pipeline: ${targets.length} companies, concurrencies=${JSON.stringify(CONCURRENCIES)}${DRY_RUN ? ' [dry-run]' : ''}\n`);

  // Initial stage tally
  const initialTally = {};
  for (const c of targets) {
    const s = getStage(c);
    initialTally[s] = (initialTally[s] || 0) + 1;
  }
  process.stderr.write(`Initial: ${JSON.stringify(initialTally)}\n\n`);

  for (const c of targets) enqueue(c);

  for (const s of STAGES) await queues[s].onIdle();
  await shutdown('done');
  process.exit(0);
})();
