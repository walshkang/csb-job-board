#!/usr/bin/env node
/**
 * Prompt Auto-Optimizer (Karpathy-style autoresearch)
 *
 * Iteratively mutates a target prompt, benchmarks each mutation,
 * keeps improvements, and reverts regressions.
 *
 * Usage:
 *   node scripts/optimize-prompts.js [options]
 *
 * Options:
 *   --target=extraction       Which prompt to optimize (extraction|enrichment|categorizer)
 *   --n=10                    Companies per benchmark run (default: 10)
 *   --max-iterations=5        Max optimization iterations (default: 5)
 *   --seed=42                 Fixed seed for consistent company selection
 *   --objective=balanced      quality|speed|cost|balanced (default: balanced)
 *   --evaluator-model=...     Model for the meta-evaluator (default: from config)
 *   --dry-run                 Show proposed mutations without applying or benchmarking
 *   --verbose                 Show pipeline output during benchmarks
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const PROMPTS_DIR = path.join(REPO_ROOT, 'src', 'prompts');
const HISTORY_DIR = path.join(REPO_ROOT, 'data', 'prompt-history');
const BENCHMARKS_DIR = path.join(REPO_ROOT, 'data', 'benchmarks');

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

const TARGET = flagValue('target') || 'extraction';
const N = parseInt(flagValue('n') || '10', 10);
const MAX_ITERATIONS = parseInt(flagValue('max-iterations') || '5', 10);
const SEED = flagValue('seed') ? parseInt(flagValue('seed'), 10) : 42;
const OBJECTIVE = flagValue('objective') || 'balanced';
const EVALUATOR_MODEL = flagValue('evaluator-model') || null;
const DRY_RUN = flag('dry-run');
const VERBOSE = flag('verbose');

// Map target names to prompt file paths
const PROMPT_FILES = {
  'extraction': 'extraction.txt',
  'enrichment': 'enrichment.txt',
  'categorizer': 'categorizer.txt',
};

if (!PROMPT_FILES[TARGET]) {
  console.error(`Unknown target: ${TARGET}. Valid: ${Object.keys(PROMPT_FILES).join(', ')}`);
  process.exit(1);
}

const OBJECTIVE_DESCRIPTIONS = {
  quality: 'maximize extraction accuracy and success rate (minimize failures, maximize jobs found)',
  speed: 'minimize total wall-clock time and LLM latency',
  cost: 'minimize total LLM token usage (prompt + response chars)',
  balanced: 'optimize a balance of quality (60%), speed (20%), and cost (20%)',
};

if (flag('help') || flag('h')) {
  console.log(fs.readFileSync(__filename, 'utf8').match(/\/\*\*[\s\S]*?\*\//)[0]);
  process.exit(0);
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

function readPrompt(target) {
  return fs.readFileSync(path.join(PROMPTS_DIR, PROMPT_FILES[target]), 'utf8');
}

function writePrompt(target, content) {
  fs.writeFileSync(path.join(PROMPTS_DIR, PROMPT_FILES[target]), content, 'utf8');
}

/**
 * Compute a single scalar score from a benchmark report.
 * Higher = better.
 */
function computeScore(report, objective) {
  if (!report || !report.summary) return 0;

  const s = report.summary;
  const stages = report.per_stage || {};

  // Quality: average success rate across stages + jobs found
  const stageRates = Object.values(stages).map(st => st.success_rate_pct || 0);
  const avgSuccessRate = stageRates.length > 0
    ? stageRates.reduce((a, b) => a + b, 0) / stageRates.length
    : 0;
  const jobsFound = report.jobs?.added || 0;
  // Normalize jobs to 0-100 scale (assume 50 jobs is excellent for N=10)
  const jobsScore = Math.min(100, (jobsFound / (N * 5)) * 100);
  const qualityScore = avgSuccessRate * 0.7 + jobsScore * 0.3;

  // Speed: inverse of total duration (normalize to 0-100, assume 60s is baseline)
  const durationSec = (s.total_duration_ms || 60000) / 1000;
  const speedScore = Math.max(0, Math.min(100, (60 / durationSec) * 100));

  // Cost: inverse of total chars (normalize to 0-100, assume 200K chars is baseline)
  const totalChars = (s.total_prompt_chars || 0) + (s.total_response_chars || 0);
  const costScore = Math.max(0, Math.min(100, (200000 / Math.max(totalChars, 1)) * 100));

  const weights = {
    quality: { quality: 1.0, speed: 0.0, cost: 0.0 },
    speed: { quality: 0.0, speed: 1.0, cost: 0.0 },
    cost: { quality: 0.0, speed: 0.0, cost: 1.0 },
    balanced: { quality: 0.6, speed: 0.2, cost: 0.2 },
  };

  const w = weights[objective] || weights.balanced;
  return Math.round(
    qualityScore * w.quality +
    speedScore * w.speed +
    costScore * w.cost
  );
}

/**
 * Run a benchmark and return the report.
 */
function runBenchmark(tag) {
  const args = [
    'scripts/benchmark.js',
    `--n=${N}`,
    `--seed=${SEED}`,
    `--tag=${tag}`,
    '--no-restore', // keep state so we can inspect sample outputs
  ];
  if (VERBOSE) args.push('--verbose');

  console.log(`  Running benchmark: ${tag}...`);
  try {
    const result = execFileSync('node', args, {
      cwd: REPO_ROOT,
      stdio: VERBOSE ? 'inherit' : 'pipe',
      timeout: 15 * 60 * 1000, // 15 min max
      env: { ...process.env },
    });
    if (!VERBOSE && result) {
      // Print last few lines of output
      const lines = result.toString().split('\n');
      const tail = lines.slice(-8).join('\n');
      console.log(tail);
    }
  } catch (err) {
    console.error(`  Benchmark failed: ${err.message}`);
  }

  // Read the latest report
  const report = readJSON(path.join(BENCHMARKS_DIR, 'latest.json'));
  if (!report) {
    console.error('  No benchmark report produced');
    return null;
  }
  return report;
}

/**
 * Collect sample outputs and failures for the meta-evaluator.
 */
function collectSamples(report) {
  const samples = { outputs: [], failures: [] };
  if (!report || !report.per_company) return samples;

  for (const c of report.per_company.slice(0, 5)) {
    if (c.extract?.jobs_found > 0 || c.categorize?.category) {
      samples.outputs.push({
        company: c.name,
        discovery: c.discovery?.found ? `✓ ${c.discovery.method}` : `✗ ${c.discovery.failure_reason || 'not_found'}`,
        jobs: c.extract?.jobs_found || 0,
        category: c.categorize?.category || 'none',
      });
    }
    if (!c.discovery?.found || (!c.extract?.extracted && c.discovery?.found)) {
      samples.failures.push({
        company: c.name,
        stage_failed: !c.discovery?.found ? 'discovery' : !c.scrape?.scraped ? 'scrape' : 'extract',
        reason: c.discovery?.failure_reason || 'unknown',
      });
    }
  }

  return samples;
}

/**
 * Call the meta-evaluator LLM to propose a prompt mutation.
 */
async function proposeMutation(currentPrompt, report, previousIterations, iteration) {
  const config = require(path.join(REPO_ROOT, 'src', 'config'));
  const { callLLM } = require(path.join(REPO_ROOT, 'src', 'llm-client'));

  const metaTemplate = fs.readFileSync(path.join(PROMPTS_DIR, 'optimization.txt'), 'utf8');
  const samples = collectSamples(report);

  const stageResults = Object.entries(report.per_stage || {})
    .map(([s, d]) => `  ${s}: ${d.success}/${d.total} (${d.success_rate_pct}%) ${d.llm_calls ? `[${d.llm_calls} LLM calls]` : ''}`)
    .join('\n');

  const prevText = previousIterations.length === 0
    ? 'None — this is the first iteration.'
    : previousIterations.map((p, i) =>
        `Iteration ${i + 1}: ${p.mutation_type} — "${p.mutation_description}" → score ${p.score_before} → ${p.score_after} (${p.kept ? 'KEPT' : 'REVERTED'})`
      ).join('\n');

  const prompt = metaTemplate
    .replace('{target_agent}', TARGET)
    .replace('{objective}', OBJECTIVE)
    .replace('{iteration}', String(iteration))
    .replace('{max_iterations}', String(MAX_ITERATIONS))
    .replace('{current_prompt}', currentPrompt)
    .replace('{n}', String(N))
    .replace('{total_llm_calls}', String(report.summary?.total_llm_calls || 0))
    .replace('{llm_successful}', String(report.summary?.llm_successful || 0))
    .replace('{llm_failed}', String(report.summary?.llm_failed || 0))
    .replace('{avg_latency_ms}', String(report.summary?.avg_llm_latency_ms || 0))
    .replace('{p95_latency_ms}', String(report.summary?.p95_llm_latency_ms || 0))
    .replace('{total_prompt_chars}', String(report.summary?.total_prompt_chars || 0))
    .replace('{total_response_chars}', String(report.summary?.total_response_chars || 0))
    .replace('{estimated_cost}', String(report.summary?.estimated_cost_usd || 0))
    .replace('{stage_results}', stageResults)
    .replace('{sample_outputs}', JSON.stringify(samples.outputs, null, 2))
    .replace('{sample_failures}', JSON.stringify(samples.failures, null, 2))
    .replace('{previous_iterations}', prevText)
    .replace('{objective_description}', OBJECTIVE_DESCRIPTIONS[OBJECTIVE] || OBJECTIVE_DESCRIPTIONS.balanced);

  const agentConfig = config.resolveAgent('enrichment'); // use enrichment model as the evaluator
  const result = await callLLM({
    ...agentConfig,
    model: EVALUATOR_MODEL || agentConfig.model,
    prompt,
    maxOutputTokens: 8192,
    _agent: 'optimizer',
  });

  // Parse the response
  const text = result.replace(/```(?:json)?/g, '\n').trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('Meta-evaluator did not return valid JSON');
  }
  return JSON.parse(text.slice(firstBrace, lastBrace + 1));
}

/**
 * Save a prompt version to history.
 */
function saveToHistory(target, version, prompt, benchmark, mutation) {
  const dir = path.join(HISTORY_DIR, target);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `v${version}-prompt.txt`), prompt, 'utf8');
  if (benchmark) {
    writeJSONAtomic(path.join(dir, `v${version}-benchmark.json`), benchmark);
  }
  if (mutation) {
    writeJSONAtomic(path.join(dir, `v${version}-mutation.json`), mutation);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       Prompt Auto-Optimizer              ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Target:       ${TARGET} (${PROMPT_FILES[TARGET]})`);
  console.log(`  Objective:    ${OBJECTIVE} — ${OBJECTIVE_DESCRIPTIONS[OBJECTIVE]}`);
  console.log(`  Companies:    ${N} (seed=${SEED})`);
  console.log(`  Max iters:    ${MAX_ITERATIONS}`);
  console.log(`  Evaluator:    ${EVALUATOR_MODEL || 'default from config'}`);
  console.log(`  Dry run:      ${DRY_RUN}`);

  const originalPrompt = readPrompt(TARGET);
  let currentPrompt = originalPrompt;
  const previousIterations = [];

  // Step 1: Baseline benchmark
  console.log('\n━━━ Baseline ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  let baselineReport;
  if (DRY_RUN) {
    console.log('  [dry-run] Skipping baseline benchmark.');
    console.log(`  Current prompt (${currentPrompt.length} chars):`);
    console.log('  ' + currentPrompt.split('\n').slice(0, 5).join('\n  ') + '\n  ...');
    baselineReport = { summary: { total_llm_calls: 0, llm_successful: 0, llm_failed: 0 }, per_stage: {}, per_company: [] };
  } else {
    baselineReport = runBenchmark(`${TARGET}-baseline`);
    if (!baselineReport) {
      console.error('Baseline benchmark failed. Aborting.');
      process.exit(1);
    }
  }

  let baselineScore = computeScore(baselineReport, OBJECTIVE);
  let bestScore = baselineScore;
  let bestPrompt = currentPrompt;

  saveToHistory(TARGET, 0, currentPrompt, baselineReport, null);
  console.log(`  Baseline score: ${baselineScore}`);

  // Step 2: Optimization loop
  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    console.log(`\n━━━ Iteration ${i}/${MAX_ITERATIONS} ━━━━━━━━━━━━━━━━━━━━━━`);

    // Propose mutation
    console.log('  Proposing mutation...');
    let mutation;
    try {
      mutation = await proposeMutation(currentPrompt, baselineReport, previousIterations, i);
    } catch (err) {
      console.error(`  Meta-evaluator failed: ${err.message}`);
      continue;
    }

    console.log(`  Type: ${mutation.mutation_type}`);
    console.log(`  Description: ${mutation.mutation_description}`);
    console.log(`  Expected impact: ${mutation.expected_impact}`);

    if (mutation.mutation_type === 'converged') {
      console.log('\n  ✓ Meta-evaluator reports convergence. Stopping.');
      break;
    }

    if (!mutation.new_prompt) {
      console.error('  No new_prompt in mutation response. Skipping.');
      continue;
    }

    // Validate placeholders are preserved
    const placeholders = (currentPrompt.match(/\{[a-z_]+\}/g) || []).sort();
    const newPlaceholders = (mutation.new_prompt.match(/\{[a-z_]+\}/g) || []).sort();
    const missing = placeholders.filter(p => !newPlaceholders.includes(p));
    if (missing.length > 0) {
      console.error(`  ⚠ Mutation removes required placeholders: ${missing.join(', ')}. Skipping.`);
      previousIterations.push({
        mutation_type: mutation.mutation_type,
        mutation_description: mutation.mutation_description + ' [REJECTED: missing placeholders]',
        score_before: bestScore,
        score_after: bestScore,
        kept: false,
      });
      continue;
    }

    if (DRY_RUN) {
      console.log(`\n  [dry-run] Would apply mutation:`);
      console.log(`  New prompt (${mutation.new_prompt.length} chars, was ${currentPrompt.length}):`);
      const diff = mutation.new_prompt.length - currentPrompt.length;
      console.log(`  Size change: ${diff > 0 ? '+' : ''}${diff} chars`);
      console.log('  ' + mutation.new_prompt.split('\n').slice(0, 5).join('\n  ') + '\n  ...');
      previousIterations.push({
        mutation_type: mutation.mutation_type,
        mutation_description: mutation.mutation_description,
        score_before: bestScore,
        score_after: bestScore,
        kept: false,
      });
      continue;
    }

    // Apply mutation
    writePrompt(TARGET, mutation.new_prompt);
    console.log(`  Applied mutation (${currentPrompt.length} → ${mutation.new_prompt.length} chars)`);

    // Benchmark with new prompt
    const newReport = runBenchmark(`${TARGET}-v${i}`);
    if (!newReport) {
      console.error('  Benchmark failed with new prompt. Reverting.');
      writePrompt(TARGET, currentPrompt);
      previousIterations.push({
        mutation_type: mutation.mutation_type,
        mutation_description: mutation.mutation_description,
        score_before: bestScore,
        score_after: 0,
        kept: false,
      });
      continue;
    }

    const newScore = computeScore(newReport, OBJECTIVE);
    console.log(`  Score: ${bestScore} → ${newScore} (${newScore > bestScore ? '✓ better' : newScore === bestScore ? '— same' : '✗ worse'})`);

    saveToHistory(TARGET, i, mutation.new_prompt, newReport, mutation);

    if (newScore >= bestScore) {
      // Keep the improvement
      console.log(`  ✓ Keeping mutation.`);
      currentPrompt = mutation.new_prompt;
      bestScore = newScore;
      bestPrompt = mutation.new_prompt;
      baselineReport = newReport; // use new results as baseline for next iteration
      previousIterations.push({
        mutation_type: mutation.mutation_type,
        mutation_description: mutation.mutation_description,
        score_before: bestScore,
        score_after: newScore,
        kept: true,
      });
    } else {
      // Revert
      console.log(`  ✗ Reverting to previous prompt.`);
      writePrompt(TARGET, currentPrompt);
      previousIterations.push({
        mutation_type: mutation.mutation_type,
        mutation_description: mutation.mutation_description,
        score_before: bestScore,
        score_after: newScore,
        kept: false,
      });
    }
  }

  // Summary
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║         Optimization Summary             ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Target:           ${TARGET}`);
  console.log(`  Objective:        ${OBJECTIVE}`);
  console.log(`  Iterations:       ${previousIterations.length}`);
  console.log(`  Baseline score:   ${baselineScore}`);
  console.log(`  Final score:      ${bestScore}`);
  const improvement = bestScore - baselineScore;
  console.log(`  Improvement:      ${improvement > 0 ? '+' : ''}${improvement} points`);
  console.log(`  Mutations kept:   ${previousIterations.filter(p => p.kept).length}/${previousIterations.length}`);

  if (previousIterations.length > 0) {
    console.log('\n  Iteration history:');
    for (const [i, p] of previousIterations.entries()) {
      const icon = p.kept ? '✓' : '✗';
      console.log(`    ${icon} ${i + 1}. [${p.mutation_type}] ${p.mutation_description}`);
      console.log(`       Score: ${p.score_before} → ${p.score_after}`);
    }
  }

  const promptSizeDelta = bestPrompt.length - originalPrompt.length;
  console.log(`\n  Prompt size: ${originalPrompt.length} → ${bestPrompt.length} (${promptSizeDelta > 0 ? '+' : ''}${promptSizeDelta} chars)`);
  console.log(`  History: ${HISTORY_DIR}/${TARGET}/`);

  // Ensure best prompt is written
  if (!DRY_RUN && bestPrompt !== originalPrompt) {
    writePrompt(TARGET, bestPrompt);
    console.log(`  Final prompt written to ${PROMPT_FILES[TARGET]}`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Optimizer failed:', err);
  process.exit(1);
});
