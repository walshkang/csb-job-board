#!/usr/bin/env node
/**
 * Pipeline Benchmark Runner
 *
 * Selects N companies (randomly or by ID), resets their pipeline state,
 * runs them through the orchestrator, and produces a structured report
 * with per-stage timing, LLM telemetry, and bottleneck analysis.
 *
 * Usage:
 *   node scripts/benchmark.js [options]
 *
 * Options:
 *   --n=15              Number of companies to test (default: 15)
 *   --seed=42           Random seed for reproducibility
 *   --companies=a,b,c   Specific company IDs (comma-separated)
 *   --stages=discovery,scrape  Run only specific stages
 *   --dry-run           Print selected companies without running
 *   --tag=baseline      Tag for this benchmark run
 *   --output=path       Custom output path for report
 *   --no-restore        Don't restore original state after benchmark
 *   --verbose           Show pipeline output
 */

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const COMPANIES_PATH = path.join(REPO_ROOT, 'data', 'companies.json');
const JOBS_PATH = path.join(REPO_ROOT, 'data', 'jobs.json');
const BENCHMARKS_DIR = path.join(REPO_ROOT, 'data', 'benchmarks');
const ORCHESTRATOR_PATH = path.join(REPO_ROOT, 'src', 'orchestrator.js');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name) { return argv.includes(`--${name}`); }
function flagValue(name) {
  const eq = argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const sp = argv.indexOf(`--${name}`);
  if (sp !== -1 && argv[sp + 1] && !argv[sp + 1].startsWith('--')) return argv[sp + 1];
  return null;
}

const N = parseInt(flagValue('n') || '15', 10);
const SEED = flagValue('seed') ? parseInt(flagValue('seed'), 10) : null;
const COMPANY_IDS = flagValue('companies') ? flagValue('companies').split(',').map(s => s.trim()) : null;
const STAGES_FILTER = flagValue('stages') || null;
const DRY_RUN = flag('dry-run');
const TAG = flagValue('tag') || 'benchmark';
const OUTPUT_PATH = flagValue('output') || null;
const NO_RESTORE = flag('no-restore');
const VERBOSE = flag('verbose');

if (flag('help') || flag('h')) {
  console.log(fs.readFileSync(__filename, 'utf8').match(/\/\*\*[\s\S]*?\*\//)[0]);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Seeded RNG (xoshiro128** — deterministic, fast)
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleArray(arr, rng) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJSONAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/** Deep clone a company object for snapshot. */
function snapshot(company) {
  return JSON.parse(JSON.stringify(company));
}

/** Reset a company's pipeline state so it re-runs from scratch. */
function resetCompanyState(company) {
  // Discovery
  delete company.careers_page_url;
  delete company.careers_page_reachable;
  delete company.careers_page_discovery_method;
  delete company.careers_page_failure_reason;
  delete company.ats_platform;
  delete company.llm_attempted;
  delete company.llm_error;

  // Fingerprint
  delete company.fingerprint_attempted_at;
  delete company.ats_detection_source;
  delete company.ats_slug;

  // Scrape
  delete company.last_scraped_at;

  // Extract
  delete company.last_extracted_at;

  // Categorize
  delete company.climate_tech_category;
  delete company.primary_sector;
  delete company.opportunity_area;
  delete company.category_confidence;
  delete company.category_error;
}

// ---------------------------------------------------------------------------
// Company selection
// ---------------------------------------------------------------------------

function selectCompanies(allCompanies) {
  if (COMPANY_IDS) {
    const idSet = new Set(COMPANY_IDS.map(s => s.toLowerCase()));
    const selected = allCompanies.filter(c =>
      idSet.has((c.id || '').toLowerCase()) || idSet.has((c.name || '').toLowerCase())
    );
    if (selected.length === 0) {
      console.error(`No companies matched IDs: ${COMPANY_IDS.join(', ')}`);
      process.exit(1);
    }
    return selected;
  }

  // Filter to companies with domains (otherwise discovery can't work)
  const withDomain = allCompanies.filter(c => c && c.domain);
  if (withDomain.length === 0) {
    console.error('No companies with domains found');
    process.exit(1);
  }

  const rng = mulberry32(SEED || Date.now());
  const shuffled = shuffleArray(withDomain, rng);
  return shuffled.slice(0, Math.min(N, shuffled.length));
}

// ---------------------------------------------------------------------------
// Run orchestrator as subprocess
// ---------------------------------------------------------------------------

function runOrchestrator(companyNames, stages) {
  return new Promise((resolve, reject) => {
    const args = ['--company=' + companyNames.join(',')];
    if (stages) args.push('--stages=' + stages);
    if (VERBOSE) args.push('--verbose');

    const startTime = Date.now();
    const child = fork(ORCHESTRATOR_PATH, args, {
      stdio: VERBOSE ? 'inherit' : 'pipe',
      env: { ...process.env },
    });

    let stderr = '';
    if (!VERBOSE && child.stderr) {
      child.stderr.on('data', d => { stderr += d.toString(); });
    }

    child.on('exit', (code) => {
      resolve({
        exit_code: code,
        duration_ms: Date.now() - startTime,
        stderr: stderr.slice(-5000), // last 5K of stderr for debugging
      });
    });

    child.on('error', (err) => {
      reject(err);
    });

    // Timeout after 10 minutes
    setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      resolve({
        exit_code: -1,
        duration_ms: Date.now() - startTime,
        stderr: 'TIMEOUT: benchmark exceeded 10 minute limit',
      });
    }, 10 * 60 * 1000);
  });
}

// ---------------------------------------------------------------------------
// Analyze results
// ---------------------------------------------------------------------------

function analyzeResults(selectedIds, companiesBefore, companiesAfter, jobsBefore, jobsAfter, orchestratorResult, telemetrySummary) {
  const STAGES = ['discovery', 'fingerprint', 'scrape', 'extract', 'categorize'];
  const perCompany = [];

  for (const id of selectedIds) {
    const before = companiesBefore.find(c => c.id === id) || {};
    const after = companiesAfter.find(c => c.id === id) || {};
    const jobsForCompany = (jobsAfter || []).filter(j => j.company_id === id);
    const hadJobsBefore = (jobsBefore || []).some(j => j.company_id === id);

    perCompany.push({
      id,
      name: after.name || before.name || id,
      domain: after.domain || before.domain,
      discovery: {
        found: after.careers_page_reachable === true,
        method: after.careers_page_discovery_method || null,
        url: after.careers_page_url || null,
        failure_reason: after.careers_page_failure_reason || null,
        llm_used: !!after.llm_attempted,
      },
      fingerprint: {
        ats_platform: after.ats_platform || null,
        attempted: !!after.fingerprint_attempted_at,
      },
      scrape: {
        scraped: !!after.last_scraped_at,
      },
      extract: {
        extracted: !!after.last_extracted_at,
        jobs_found: jobsForCompany.length,
        had_jobs_before: hadJobsBefore,
      },
      categorize: {
        category: after.climate_tech_category || null,
        confidence: after.category_confidence || null,
      },
    });
  }

  // Per-stage aggregates
  const perStage = {};
  for (const stage of STAGES) {
    const successes = perCompany.filter(c => {
      if (stage === 'discovery') return c.discovery.found;
      if (stage === 'fingerprint') return c.fingerprint.attempted;
      if (stage === 'scrape') return c.scrape.scraped;
      if (stage === 'extract') return c.extract.extracted;
      if (stage === 'categorize') return !!c.categorize.category;
      return false;
    });

    perStage[stage] = {
      success: successes.length,
      total: perCompany.length,
      success_rate_pct: Math.round((successes.length / perCompany.length) * 100),
    };
  }

  // LLM stats from telemetry
  const llmByAgent = telemetrySummary ? telemetrySummary.byAgent : {};
  for (const stage of STAGES) {
    const agentKey = stage === 'categorize' ? 'categorizer' : stage;
    if (llmByAgent[agentKey]) {
      perStage[stage].llm_calls = llmByAgent[agentKey].total_calls;
      perStage[stage].llm_avg_latency_ms = llmByAgent[agentKey].avg_latency_ms;
      perStage[stage].llm_prompt_chars = llmByAgent[agentKey].total_prompt_chars;
      perStage[stage].llm_response_chars = llmByAgent[agentKey].total_response_chars;
    }
  }

  // Jobs analysis
  const newJobIds = new Set((jobsAfter || []).map(j => j.id));
  const oldJobIds = new Set((jobsBefore || []).map(j => j.id));
  const addedJobs = [...newJobIds].filter(id => !oldJobIds.has(id)).length;

  // Discovery method distribution
  const methodDist = {};
  for (const c of perCompany) {
    const m = c.discovery.method || 'none';
    methodDist[m] = (methodDist[m] || 0) + 1;
  }

  // ATS distribution
  const atsDist = {};
  for (const c of perCompany) {
    const a = c.fingerprint.ats_platform || 'unknown';
    atsDist[a] = (atsDist[a] || 0) + 1;
  }

  // Bottleneck analysis
  const stageSuccessRates = STAGES.map(s => ({ stage: s, rate: perStage[s].success_rate_pct }));
  stageSuccessRates.sort((a, b) => a.rate - b.rate);
  const worstStage = stageSuccessRates[0];

  const stageLLMCalls = STAGES.map(s => ({ stage: s, calls: perStage[s].llm_calls || 0 }));
  stageLLMCalls.sort((a, b) => b.calls - a.calls);
  const mostLLMCalls = stageLLMCalls[0];

  return {
    per_company: perCompany,
    per_stage: perStage,
    discovery_methods: methodDist,
    ats_distribution: atsDist,
    jobs: {
      before: (jobsBefore || []).length,
      after: (jobsAfter || []).length,
      added: addedJobs,
    },
    bottleneck_analysis: {
      lowest_success_rate: { stage: worstStage.stage, rate_pct: worstStage.rate },
      most_llm_calls: { stage: mostLLMCalls.stage, calls: mostLLMCalls.calls },
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       Pipeline Benchmark Runner          ║');
  console.log('╚══════════════════════════════════════════╝');

  // Load companies
  const allCompanies = readJSON(COMPANIES_PATH);
  if (!allCompanies) {
    console.error('Cannot read data/companies.json');
    process.exit(1);
  }

  // Select target companies
  const selected = selectCompanies(allCompanies);
  const selectedIds = selected.map(c => c.id);
  const selectedNames = selected.map(c => c.name || c.id);

  console.log(`\nSelected ${selected.length} companies${SEED ? ` (seed=${SEED})` : ''}:`);
  for (const c of selected) {
    console.log(`  • ${(c.name || c.id).padEnd(35)} ${c.domain || 'no domain'}`);
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: exiting without running pipeline.');
    process.exit(0);
  }

  // Snapshot original state for restore
  const companiesBefore = allCompanies.map(snapshot);
  const jobsBefore = readJSON(JOBS_PATH) || [];

  // Reset selected companies
  console.log('\nResetting pipeline state for selected companies...');
  const selectedSet = new Set(selectedIds);
  for (const c of allCompanies) {
    if (selectedSet.has(c.id)) {
      resetCompanyState(c);
    }
  }

  // Remove existing artifacts for selected companies
  const artifactsDir = path.join(REPO_ROOT, 'artifacts', 'html');
  for (const id of selectedIds) {
    for (const ext of ['.html', '.json', '.playwright.html']) {
      const p = path.join(artifactsDir, `${id}${ext}`);
      try { fs.unlinkSync(p); } catch (_) {}
    }
  }

  // Write reset state
  writeJSONAtomic(COMPANIES_PATH, allCompanies);
  console.log('State reset complete.');

  // Initialize telemetry for this run
  const { LLMTelemetry } = require(path.join(REPO_ROOT, 'src', 'utils', 'llm-telemetry'));
  const telemetry = LLMTelemetry.instance();
  telemetry.reset(TAG);
  telemetry.enableStreaming();

  // Run the orchestrator
  console.log(`\nRunning pipeline (${selectedNames.length} companies)...`);
  const startTime = Date.now();

  const orchestratorResult = await runOrchestrator(selectedNames, STAGES_FILTER);

  const totalDuration = Date.now() - startTime;
  console.log(`\nPipeline completed in ${(totalDuration / 1000).toFixed(1)}s (exit code: ${orchestratorResult.exit_code})`);

  // Read post-run state
  const companiesAfter = readJSON(COMPANIES_PATH) || [];
  const jobsAfter = readJSON(JOBS_PATH) || [];

  // Collect telemetry
  const telemetrySummary = telemetry.summarize();
  const telemetryPath = telemetry.flush();
  telemetry.close();

  // Analyze
  const analysis = analyzeResults(selectedIds, companiesBefore, companiesAfter, jobsBefore, jobsAfter, orchestratorResult, telemetrySummary);

  // Build report
  const report = {
    meta: {
      tag: TAG,
      n: selected.length,
      seed: SEED,
      stages_filter: STAGES_FILTER,
      timestamp: new Date().toISOString(),
      total_duration_ms: totalDuration,
      orchestrator_exit_code: orchestratorResult.exit_code,
    },
    summary: {
      total_duration_ms: totalDuration,
      total_llm_calls: telemetrySummary.overall.total_calls,
      llm_successful: telemetrySummary.overall.successful,
      llm_failed: telemetrySummary.overall.failed,
      total_prompt_chars: telemetrySummary.overall.total_prompt_chars,
      total_response_chars: telemetrySummary.overall.total_response_chars,
      avg_llm_latency_ms: telemetrySummary.overall.avg_latency_ms,
      p50_llm_latency_ms: telemetrySummary.overall.p50_ms,
      p95_llm_latency_ms: telemetrySummary.overall.p95_ms,
      estimated_cost_usd: telemetrySummary.overall.estimated_cost_usd,
    },
    per_stage: analysis.per_stage,
    discovery_methods: analysis.discovery_methods,
    ats_distribution: analysis.ats_distribution,
    jobs: analysis.jobs,
    bottleneck_analysis: analysis.bottleneck_analysis,
    llm_by_agent: telemetrySummary.byAgent,
    llm_by_model: telemetrySummary.byModel,
    per_company: analysis.per_company,
    telemetry_file: telemetryPath,
  };

  // Write report
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = OUTPUT_PATH || path.join(BENCHMARKS_DIR, `${TAG}-${ts}.json`);
  writeJSONAtomic(reportPath, report);

  // Also write as latest for easy access
  const latestPath = path.join(BENCHMARKS_DIR, 'latest.json');
  writeJSONAtomic(latestPath, report);

  // Print summary
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║           Benchmark Results              ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Tag:              ${TAG}`);
  console.log(`  Companies:        ${selected.length}`);
  console.log(`  Total duration:   ${(totalDuration / 1000).toFixed(1)}s`);
  console.log(`  LLM calls:        ${telemetrySummary.overall.total_calls} (${telemetrySummary.overall.successful} ok, ${telemetrySummary.overall.failed} failed)`);
  console.log(`  Avg LLM latency:  ${telemetrySummary.overall.avg_latency_ms}ms`);
  console.log(`  P95 LLM latency:  ${telemetrySummary.overall.p95_ms}ms`);
  console.log(`  Prompt chars:     ${(telemetrySummary.overall.total_prompt_chars / 1000).toFixed(1)}K`);
  console.log(`  Response chars:   ${(telemetrySummary.overall.total_response_chars / 1000).toFixed(1)}K`);
  console.log(`  Est. cost:        $${telemetrySummary.overall.estimated_cost_usd}`);
  console.log(`  Jobs added:       ${analysis.jobs.added}`);

  console.log('\n  Per-stage success rates:');
  for (const [stage, data] of Object.entries(analysis.per_stage)) {
    const llmInfo = data.llm_calls ? ` (${data.llm_calls} LLM calls, avg ${data.llm_avg_latency_ms}ms)` : '';
    console.log(`    ${stage.padEnd(14)} ${data.success}/${data.total} (${data.success_rate_pct}%)${llmInfo}`);
  }

  console.log('\n  Discovery methods:', JSON.stringify(analysis.discovery_methods));
  console.log('  ATS platforms:', JSON.stringify(analysis.ats_distribution));

  console.log(`\n  Bottleneck: ${analysis.bottleneck_analysis.lowest_success_rate.stage} (${analysis.bottleneck_analysis.lowest_success_rate.rate_pct}% success)`);
  console.log(`  Most LLM calls: ${analysis.bottleneck_analysis.most_llm_calls.stage} (${analysis.bottleneck_analysis.most_llm_calls.calls} calls)`);

  console.log(`\n  Report: ${reportPath}`);
  console.log(`  Latest: ${latestPath}`);
  console.log(`  Telemetry: ${telemetryPath}`);

  // Restore original state unless --no-restore
  if (!NO_RESTORE) {
    console.log('\n  Restoring original company state...');
    writeJSONAtomic(COMPANIES_PATH, companiesBefore);
    writeJSONAtomic(JOBS_PATH, jobsBefore);
    console.log('  Restored ✓');
  } else {
    console.log('\n  --no-restore: keeping benchmark state in companies.json');
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
