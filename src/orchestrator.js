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
const { scrapeCompany, normalizeJobUrl } = require('./agents/scraper');
const { extractCompanyJobs, mergeJobs, descriptionHashesBySourceUrlFromArtifact } = require('./agents/extraction');
const { diffScrapeUrls } = require('./utils/scrape-diff');
const { enrichJob, ENRICHMENT_PROMPT_VERSION, PROMPT_PATH } = require('./agents/enricher');
const { categorizeCompany, batchCategorize, BATCH_MAX } = require('./agents/categorizer');
const { getStage, nextStage, STAGES, classifyLane } = require('./utils/pipeline-stages');
const {
  EventSink,
  writeSnapshot,
  clearSnapshot,
  writeLastRunSummary,
  classifyFailure,
  classifyLlmMessage,
  isTransient,
} = require('./utils/pipeline-events');
const { runWithRetry } = require('./utils/retry-policy');
const { CircuitBreaker } = require('./utils/circuit-breaker');
const { AdaptiveController } = require('./utils/adaptive-concurrency');
const {
  queueCircuitResetCommand,
  consumeCircuitResetCommands,
} = require('./utils/circuit-commands');

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
  wrds_ingest: 1,
  profile: 6,
  discovery: 12,
  fingerprint: 4,
  scrape: 5,
  extract: 4,
  enrich: 6,
  categorize: 10,
};
const RETRY_MAX_ATTEMPTS = 3;
const CATEGORIZE_BATCH_WAIT_MS = 2000;
const BREAKER_COMMANDS_PATH = path.join(REPO_ROOT, 'data', 'runs', 'circuit-reset-commands.json');
const BREAKER_DEFAULTS = Object.freeze({
  windowSize: 20,
  minSamples: 5,
  threshold: 0.5,
  cooldownMs: 60_000,
});
const ADAPTIVE_TARGETS = Object.freeze({
  wrds_ingest: { p95MaxMs: 60000, queueDepthTrigger: 1 },
  profile: { p95MaxMs: 3_000, queueDepthTrigger: 3 },
  discovery: { p95MaxMs: 4_000, queueDepthTrigger: 5 },
  fingerprint: { p95MaxMs: 3_000, queueDepthTrigger: 2 },
  scrape: { p95MaxMs: 8_000, queueDepthTrigger: 2 },
  extract: { p95MaxMs: 5_000, queueDepthTrigger: 2 },
  enrich: { p95MaxMs: 12_000, queueDepthTrigger: 3 },
  categorize: { p95MaxMs: 10_000, queueDepthTrigger: 4 },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function computeRetryDelayMs(attempt) {
  const base = 500 * Math.pow(2, attempt - 1);
  const jitter = 0.8 + (Math.random() * 0.4);
  return Math.max(0, Math.round(base * jitter));
}

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

function computeDaysLive(firstSeenAt, removedAt) {
  const first = Date.parse(firstSeenAt || 0);
  const removed = Date.parse(removedAt || 0);
  if (Number.isNaN(first) || Number.isNaN(removed) || removed < first) return 0;
  return Math.floor((removed - first) / 86400000);
}

function buildWarmScrapeDecision(company, scrapeResult) {
  const currentUrls = Array.isArray(scrapeResult && scrapeResult.job_urls)
    ? scrapeResult.job_urls.map((u) => normalizeJobUrl(u)).filter(Boolean)
    : [];
  if (!currentUrls.length) return null;

  const jobs = readJSON(JOBS_PATH, []);
  const companyJobs = jobs.filter((job) => job && job.company_id === company.id);
  const activeJobs = companyJobs.filter((job) => !job.removed_at);
  const priorUrls = activeJobs
    .map((job) => normalizeJobUrl(job.source_url))
    .filter(Boolean);
  const diff = diffScrapeUrls({ priorUrls, currentUrls });
  const now = new Date().toISOString();

  const byUrl = new Map();
  for (const job of companyJobs) {
    const normalized = normalizeJobUrl(job.source_url);
    if (!normalized) continue;
    if (!byUrl.has(normalized)) byUrl.set(normalized, []);
    byUrl.get(normalized).push(job);
  }

  const touched = [];
  for (const url of diff.existing) {
    const entries = byUrl.get(url) || [];
    for (const job of entries) {
      job.last_seen_at = now;
      if (job.removed_at) delete job.removed_at;
      touched.push(job);
    }
  }
  for (const url of diff.removed) {
    const entries = byUrl.get(url) || [];
    for (const job of entries) {
      if (!job.removed_at) {
        job.removed_at = now;
        job.days_live = computeDaysLive(job.first_seen_at, job.removed_at);
      }
      touched.push(job);
    }
  }

  const hashMap = descriptionHashesBySourceUrlFromArtifact(company, { artifactsDir: ARTIFACTS_DIR });
  let hashChurn = true;
  if (hashMap) {
    hashChurn = false;
    for (const url of diff.existing) {
      const expectedHash = hashMap.get(url);
      const existingJobs = (byUrl.get(url) || []).filter((job) => !job.removed_at || diff.existing.has(url));
      if (!expectedHash || existingJobs.length === 0 || existingJobs.some((job) => job.description_hash !== expectedHash)) {
        hashChurn = true;
        break;
      }
    }
  }

  return {
    now,
    diff,
    touched,
    noDelta: diff.netNew.size === 0 && !hashChurn,
  };
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

const enricherAgent = (() => {
  try { return config.resolveAgent('enrichment'); } catch (e) { return null; }
})();

const enrichPromptTemplate = (() => {
  try { return fs.readFileSync(PROMPT_PATH, 'utf8'); } catch (e) { return null; }
})();

const enrichCategories = (() => {
  return taxonomy.map(c => c['Tech Category Name'] || c['Tech category name'] || c.name).filter(Boolean);
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

// Track extracted jobs per company for inline enrich (same objects, mutations propagate to buffer)
const companyExtractedJobs = new Map();

function buildCompanyJobDiff(c, jobsNow = []) {
  const jobsById = new Map();
  for (const job of initialJobs) {
    if (!job || job.company_id !== c.id) continue;
    jobsById.set(job.id, job);
  }
  for (const job of newJobsBuffer) {
    if (!job || job.company_id !== c.id) continue;
    jobsById.set(job.id, job);
  }
  const priorUrls = [];
  for (const job of jobsById.values()) {
    if (job.removed_at) continue;
    const normalized = normalizeJobUrl(job.source_url);
    if (normalized) priorUrls.push(normalized);
  }
  const currentUrls = Array.isArray(jobsNow)
    ? jobsNow.map((job) => normalizeJobUrl(job && job.source_url)).filter(Boolean)
    : [];
  const diff = diffScrapeUrls({ priorUrls, currentUrls });
  return {
    net_new: diff.netNew.size,
    existing: diff.existing.size,
    removed: diff.removed.size,
  };
}

function getCompanyActiveSourceUrls(companyId) {
  const jobsById = new Map();
  for (const job of initialJobs) {
    if (!job || job.company_id !== companyId) continue;
    jobsById.set(job.id, job);
  }
  for (const job of newJobsBuffer) {
    if (!job || job.company_id !== companyId) continue;
    jobsById.set(job.id, job);
  }
  const activeUrls = new Set();
  for (const job of jobsById.values()) {
    if (!job || job.removed_at) continue;
    const normalized = normalizeJobUrl(job.source_url);
    if (normalized) activeUrls.add(normalized);
  }
  return Array.from(activeUrls);
}

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
const breakers = Object.fromEntries(
  STAGES.map((stage) => [stage, new CircuitBreaker(BREAKER_DEFAULTS)])
);
const adaptiveControllers = Object.fromEntries(
  STAGES.map((stage) => {
    const current = CONCURRENCIES[stage];
    return [stage, new AdaptiveController({
      stage,
      min: Math.max(1, Math.floor(current / 2)),
      max: current * 2,
      target: ADAPTIVE_TARGETS[stage],
      breaker: breakers[stage],
      queue: queues[stage],
      getQueueDepth: () => queues[stage].size,
    })];
  })
);

const stats = { started: {}, completed: {}, no_result: {}, failed: {}, skipped: {} };
for (const s of STAGES) {
  stats.started[s] = 0; stats.completed[s] = 0; stats.no_result[s] = 0; stats.failed[s] = 0; stats.skipped[s] = 0;
}
const statsByLane = {
  cold: { started: {}, completed: {}, no_result: {}, failed: {}, skipped: {} },
  warm: { started: {}, completed: {}, no_result: {}, failed: {}, skipped: {} },
};
for (const lane of ['cold', 'warm']) {
  for (const s of STAGES) {
    statsByLane[lane].started[s] = 0;
    statsByLane[lane].completed[s] = 0;
    statsByLane[lane].no_result[s] = 0;
    statsByLane[lane].failed[s] = 0;
    statsByLane[lane].skipped[s] = 0;
  }
}

function bumpLaneStat(lane, kind, stage) {
  if (!statsByLane[lane] || !statsByLane[lane][kind] || !Object.prototype.hasOwnProperty.call(statsByLane[lane][kind], stage)) {
    return;
  }
  statsByLane[lane][kind][stage]++;
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
function normalizeScrapeStageResult(result) {
  if (result && result.skipped_signature_match) {
    return {
      outcome: 'skipped',
      extra: {
        reason: 'signature_match',
        method: result.method,
        status_code: result.status_code,
        preflight_url_count: result.preflight_url_count || result.job_count || 0,
      },
      companyOutcome: 'skipped_signature_match',
    };
  }
  if (result && result.success) {
    return {
      outcome: 'success',
      extra: {
        method: result.method,
        status_code: result.status_code,
        byte_length: result.byte_length,
      },
      companyOutcome: 'success',
    };
  }
  return {
    outcome: 'no_result',
    extra: {
      method: result && result.method,
      status_code: result && result.status_code,
      error: result && result.error,
    },
    companyOutcome: 'no_result',
  };
}

function buildCategorizeOutcome(c) {
  if (c.climate_tech_category && c.climate_tech_category !== 'None') {
    return {
      outcome: 'success',
      extra: {
        category: c.climate_tech_category,
        confidence: c.category_confidence,
        resolver: c.category_resolver || 'llm',
        category_source: c.category_source || null,
      },
    };
  }
  const failureClass = c.category_error ? classifyLlmMessage(c.category_error) : null;
  return {
    outcome: 'no_result',
    extra: {
      category: c.climate_tech_category || null,
      category_error: c.category_error || null,
      resolver: c.category_resolver || null,
      category_source: c.category_source || null,
      failure_class: failureClass || null,
      error_origin: failureClass ? 'provider' : null,
    },
  };
}

function applyBatchCategorizeResult(c, row) {
  c.climate_tech_category = row.category;
  c.primary_sector = null;
  c.opportunity_area = null;
  c.category_confidence = row.confidence;
  c.category_resolver = 'llm_batch';
  delete c.category_error;
}

function createCategorizeBatcher({ waitMs, maxBatchSize, dryRun, categorizerAgent, taxonomy }) {
  let pending = [];
  let timer = null;
  let flushInFlight = null;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  async function flush(reason = 'manual') {
    if (flushInFlight) {
      await flushInFlight;
      if (!pending.length) return;
    }
    if (!pending.length) return;

    clearTimer();
    const entries = pending;
    pending = [];

    flushInFlight = (async () => {
      const { provider, apiKey, model } = categorizerAgent;
      try {
        const map = await batchCategorize(
          entries.map((e) => ({ company: e.company, rep: e.rep })),
          taxonomy,
          { provider, apiKey, model, dryRun }
        );
        process.stderr.write(`[categorize-batch] flushed=${entries.length} trigger=${reason} est_calls_saved=${Math.max(0, entries.length - 1)}\n`);

        for (const entry of entries) {
          const batchResult = map.get(entry.company.id);
          if (batchResult && !batchResult.error) {
            applyBatchCategorizeResult(entry.company, batchResult);
            entry.resolve(buildCategorizeOutcome(entry.company));
            continue;
          }

          try {
            await categorizeCompany(entry.company, entry.rep, taxonomy, { provider, apiKey, model, dryRun }, entry.samples || []);
            entry.resolve(buildCategorizeOutcome(entry.company));
          } catch (err) {
            entry.reject(err);
          }
        }
      } catch (err) {
        for (const entry of entries) entry.reject(err);
      }
    })();

    try {
      await flushInFlight;
    } finally {
      flushInFlight = null;
      if (pending.length >= maxBatchSize) {
        await flush('size');
      }
    }
  }

  function enqueue({ company, rep, samples }) {
    return new Promise((resolve, reject) => {
      pending.push({ company, rep, samples, resolve, reject });
      if (pending.length === 1) {
        timer = setTimeout(() => {
          flush('timeout').catch(() => {});
        }, waitMs);
      }
      if (pending.length >= maxBatchSize) {
        flush('size').catch(() => {});
      }
    });
  }

  return { enqueue, flush };
}

const categorizeBatcher = categorizerAgent
  ? createCategorizeBatcher({
    waitMs: CATEGORIZE_BATCH_WAIT_MS,
    maxBatchSize: BATCH_MAX,
    dryRun: DRY_RUN,
    categorizerAgent,
    taxonomy,
  })
  : null;

let wrdsIngestPromise = null;

async function runStage(stage, c) {
  if (stage === 'wrds_ingest') {
    const { run: runWrds } = require('./agents/wrds-ingest');
    if (!wrdsIngestPromise) {
      wrdsIngestPromise = runWrds({ verbose: VERBOSE, dryRun: DRY_RUN }).finally(() => {
        wrdsIngestPromise = null;
      });
    }
    const result = await wrdsIngestPromise;
    c.wrds_last_updated = new Date().toISOString(); // prevent looping

    // Sync memory from WRDS ingest results to prevent data loss on flushSave
    // and ensure subsequent stages have the fresh data (Lane 1/2 routing).
    if (result.merged && result.merged.length > 0) {
      companies.splice(0, companies.length, ...result.merged);
      
      for (const target of targets) {
        const fresh = companies.find(comp => comp.id === target.id);
        if (fresh) Object.assign(target, fresh);
      }
      
      // Auto-enqueue newly discovered companies if running without filters
      if (!COMPANY_FILTER && !LIMIT) {
        const targetIds = new Set(targets.map(t => t.id));
        let newEnqueued = 0;
        for (const fresh of companies) {
          if (!targetIds.has(fresh.id)) {
            targets.push(fresh);
            enqueue(fresh);
            newEnqueued++;
          }
        }
        if (newEnqueued > 0) {
          process.stderr.write(`\n[orchestrator] Auto-enqueued ${newEnqueued} new companies from WRDS ingestion.\n`);
        }
      }
    }

    if (result.skipped) return { outcome: 'skipped', extra: { reason: result.reason } };
    return { outcome: 'success', extra: { fetched: result.fetched, added: result.added, updated: result.updated } };
  }

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
    const normalized = normalizeScrapeStageResult(result);
    c.last_scrape_outcome = normalized.companyOutcome;
    if (normalized.outcome === 'success' && c.lane === 'warm') {
      const decision = buildWarmScrapeDecision(c, result);
      if (decision) {
        if (decision.touched.length) {
          for (const job of decision.touched) newJobsBuffer.push(job);
        }
        if (decision.noDelta) {
          c.last_extracted_at = decision.now;
          c.last_enriched_at = decision.now;
          c.last_scrape_outcome = 'no_delta';
          stats.skipped.extract++;
          bumpLaneStat(c.lane, 'skipped', 'extract');
          events.emit('extract', c, 'skipped', {
            reason: 'no_delta',
            existing: decision.diff.existing.size,
            net_new: decision.diff.netNew.size,
            removed: decision.diff.removed.size,
          });
        }
      }
    }
    return { outcome: normalized.outcome, extra: normalized.extra };
  }

  if (stage === 'extract') {
    if (!c.careers_page_reachable) return { outcome: 'skipped', extra: { reason: 'unreachable' } };
    const existingJobUrls = c.lane === 'warm' ? getCompanyActiveSourceUrls(c.id) : undefined;
    const res = await extractCompanyJobs(c, { verbose: VERBOSE, existingJobUrls });
    c.last_extracted_at = new Date().toISOString();
    if (res && Array.isArray(res.jobs)) {
      for (const j of res.jobs) newJobsBuffer.push(j);
      companyExtractedJobs.set(c.id, res.jobs);
      if (res.jobs.length && !repJobByCompany.has(c.id)) {
        repJobByCompany.set(c.id, res.jobs[0]);
      }
    }
    const htmlExtra = {
      html_extract_path: res && res.html_extract_path != null ? res.html_extract_path : null,
      html_adapter_name: res && res.html_adapter_name != null ? res.html_adapter_name : null,
      extract_failure_reason: res && res.extract_failure_reason != null ? res.extract_failure_reason : null,
    };
    const diffExtra = buildCompanyJobDiff(c, res && res.jobs);
    if (res && res.processed && res.jobs.length > 0) {
      return { outcome: 'success', extra: { jobs: res.jobs.length, ...diffExtra, ...htmlExtra } };
    }
    return { outcome: 'no_result', extra: {
      processed: !!(res && res.processed),
      jobs: res && res.jobs ? res.jobs.length : 0,
      errors: res && res.errors && res.errors.length ? res.errors.length : 0,
      ...diffExtra,
      ...htmlExtra,
    }};
  }

  if (stage === 'enrich') {
    if (!enricherAgent || !enrichPromptTemplate) throw new Error('enricher config or prompt unavailable');
    // Jobs extracted this run are already in newJobsBuffer (same object refs); mutations persist.
    // For companies extracted in a prior run, fall back to initialJobs.
    const freshJobs = companyExtractedJobs.get(c.id) || [];
    const freshIds = new Set(freshJobs.map(j => j.id));
    const priorUnenriched = initialJobs.filter(
      j => j.company_id === c.id && !j.last_enriched_at && !freshIds.has(j.id)
    );
    // prior unenriched jobs need to enter the buffer so mutations are saved
    for (const j of priorUnenriched) newJobsBuffer.push(j);
    const toEnrich = [...freshJobs, ...priorUnenriched].filter(j => !j.last_enriched_at);
    const { provider, apiKey, model } = enricherAgent;
    let enriched = 0;
    let failed = 0;
    for (const job of toEnrich) {
      try {
        await enrichJob(job, enrichCategories, enrichPromptTemplate, { provider, apiKey, model, stream: false, label: job.id });
        enriched++;
        if (!repJobByCompany.has(c.id) || job.last_enriched_at) repJobByCompany.set(c.id, job);
      } catch (err) {
        failed++;
        job.enrichment_error = (err && err.message) ? err.message.slice(0, 200) : String(err);
      }
    }
    c.last_enriched_at = new Date().toISOString();
    markDirty();
    return {
      outcome: toEnrich.length === 0 || enriched > 0 ? 'success' : 'no_result',
      extra: { total: toEnrich.length, enriched, failed },
    };
  }

  if (stage === 'categorize') {
    if (!categorizerAgent) throw new Error('categorizer LLM config unavailable');
    let rep = repJobByCompany.get(c.id);
    const profileDesc = ((c.company_profile && c.company_profile.description) || '').trim();
    if (!rep && profileDesc.length < 80) {
      return { outcome: 'skipped', extra: { reason: 'insufficient_signal', description_len: profileDesc.length } };
    }
    if (!rep) {
      rep = { job_title_normalized: '', job_function: '', climate_relevance_reason: '' };
    }
    const { mapCategory } = require('./agents/taxonomy-mapper');
    const { provider, apiKey, model } = categorizerAgent;
    await mapCategory(c, rep, taxonomy, { provider, apiKey, model, dryRun: DRY_RUN });
    return buildCategorizeOutcome(c);
  }

  throw new Error(`unknown stage: ${stage}`);
}

// ——————————————————————————————————————————————————————————————
// Enqueue + chain
// ——————————————————————————————————————————————————————————————

function enqueue(c) {
  c.lane = classifyLane(c);
  const stage = getStage(c);
  if (stage === 'done') return;
  if (stageFilterSet && !stageFilterSet.has(stage)) return;
  const breaker = breakers[stage];
  if (breaker && !breaker.allow()) {
    return;
  }

  queues[stage].add(async () => {
    stats.started[stage]++;
    bumpLaneStat(c.lane, 'started', stage);
    const t0 = Date.now();
    let outcome = 'failure';
    let extra = {};
    let shouldAdvance = false;

    const retryResult = await runWithRetry({
      maxAttempts: RETRY_MAX_ATTEMPTS,
      run: () => runStage(stage, c),
      classifyFailure: (err) => classifyFailure(stage, err, null),
      isTransient,
      computeDelayMs: computeRetryDelayMs,
      onRetry: async ({ attempt, failure_class, next_delay_ms, err }) => {
        events.emit(stage, c, 'retry', {
          attempt,
          failure_class,
          next_delay_ms,
          error: (err && err.message) ? err.message.slice(0, 500) : String(err),
        });
        log(stage, c, '↻', `attempt=${attempt} class=${failure_class} next=${next_delay_ms}ms`);
      },
      onFinalFailure: async () => {},
      sleep,
    });

    if (retryResult.status === 'success') {
      const res = retryResult.result;
      outcome = res.outcome;
      extra = res.extra || {};
      const ms = Date.now() - t0;
      markDirty();
      recentCompletions.push({ ts: Date.now(), stage });

      if (outcome === 'success') {
        if (breaker) breaker.record('success');
        adaptiveControllers[stage].recordOutcome({ duration_ms: ms, outcome: 'success' });
        stats.completed[stage]++;
        bumpLaneStat(c.lane, 'completed', stage);
        events.emit(stage, c, 'success', { duration_ms: ms, ...extra });
        log(stage, c, '✓', `${ms}ms`);
        shouldAdvance = true;
      } else if (outcome === 'no_result') {
        adaptiveControllers[stage].recordOutcome({ duration_ms: ms, outcome: 'success' });
        stats.no_result[stage]++;
        bumpLaneStat(c.lane, 'no_result', stage);
        events.emit(stage, c, 'no_result', { duration_ms: ms, ...extra });
        log(stage, c, '∅', `${ms}ms ${JSON.stringify(extra)}`);
        // For discovery/fingerprint/profile, advance anyway — getStage handles skip-to-categorize
        // and fingerprint/profile are best-effort. For scrape/extract/categorize, don't advance.
        shouldAdvance = stage === 'discovery' || stage === 'fingerprint' || stage === 'profile';
      } else if (outcome === 'skipped') {
        adaptiveControllers[stage].recordOutcome({ duration_ms: ms, outcome: 'success' });
        stats.skipped[stage]++;
        bumpLaneStat(c.lane, 'skipped', stage);
        events.emit(stage, c, 'skipped', { duration_ms: ms, ...extra });
        log(stage, c, '⊘', JSON.stringify(extra));
        // Skipped stages should advance so getStage re-evaluates (categorize still runs).
        shouldAdvance = true;
      }
    } else {
      if (breaker) breaker.record('failure');
      const err = retryResult.err;
      const ms = Date.now() - t0;
      adaptiveControllers[stage].recordOutcome({ duration_ms: ms, outcome: 'failure' });
      stats.failed[stage]++;
      bumpLaneStat(c.lane, 'failed', stage);
      const failure_class = retryResult.failure_class;
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

let saveTimer = null;

function processCircuitResetCommands() {
  const commands = consumeCircuitResetCommands(BREAKER_COMMANDS_PATH, STAGES);
  for (const command of commands) {
    const breaker = breakers[command.stage];
    if (!breaker) continue;
    breaker.reset();
    log(command.stage, { name: 'circuit-breaker' }, '↺', 'manual reset');
  }
}

function snapshot() {
  processCircuitResetCommands();
  for (const s of STAGES) adaptiveControllers[s].tick();
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
  const breakerSnapshots = {};
  const adaptiveSnapshots = {};
  const concurrencyCurrent = {};
  for (const s of STAGES) {
    breakerSnapshots[s] = breakers[s].snapshot();
    adaptiveSnapshots[s] = adaptiveControllers[s].snapshot();
    concurrencyCurrent[s] = queues[s].concurrency;
  }

  const payload = {
    run_id: events.runId,
    started_at: new Date(startedAt).toISOString(),
    updated_at: new Date().toISOString(),
    uptime_sec: Math.round((Date.now() - startedAt) / 1000),
    queue_depths: queueDepths,
    in_flight: inFlight,
    stats,
    stats_by_lane: statsByLane,
    throughput_per_min: throughputPerStage,
    breakers: breakerSnapshots,
    adaptive_concurrency: adaptiveSnapshots,
    concurrency_current: concurrencyCurrent,
    dry_run: DRY_RUN,
  };
  writeSnapshot(payload);
  return payload;
}
let snapshotTimer = null;

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
  if (saveTimer) clearInterval(saveTimer);
  if (snapshotTimer) clearInterval(snapshotTimer);
  if (categorizeBatcher) await categorizeBatcher.flush('onIdle');
  await flushSave();
  const finalSnapshot = snapshot();
  events.close();
  writeLastRunSummary({
    ...finalSnapshot,
    finished_at: new Date().toISOString(),
    exit_reason: reason,
    events_path: events.path,
  });
  clearSnapshot();
  printSummary();
  process.stderr.write(`orchestrator exit: ${reason}\n`);
  process.stderr.write(`events: ${events.path}\n`);
}

process.on('SIGINT', async () => { await shutdown('SIGINT'); process.exit(130); });
process.on('SIGTERM', async () => { await shutdown('SIGTERM'); process.exit(143); });

async function main() {
  saveTimer = setInterval(flushSave, 5000);
  snapshotTimer = setInterval(snapshot, 5000);
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
  if (categorizeBatcher) await categorizeBatcher.flush('onIdle');
  await shutdown('done');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  runStage,
  normalizeScrapeStageResult,
  createCategorizeBatcher,
  queueCircuitReset: (stage) => queueCircuitResetCommand(BREAKER_COMMANDS_PATH, stage),
  breakers,
  snapshot,
  queues,
  adaptiveControllers,
};
