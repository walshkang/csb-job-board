const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const JOBS_PATH = path.join(REPO_ROOT, 'data', 'jobs.json');
const TAX_PATH = path.join(REPO_ROOT, 'data', 'climate-tech-map-industry-categories.json');
const PROMPT_PATH = path.join(REPO_ROOT, 'src', 'prompts', 'enrichment.txt');
const ENRICHMENT_PROMPT_VERSION = '1.1.0';

const config = require('../config');
const { callGeminiText } = require('../gemini-text');

const JOB_FUNCTIONS = new Set(['engineering','product','design','operations','sales','marketing','finance','legal','hr','data_science','strategy','policy','supply_chain','other']);
const SENIORITY = new Set(['intern','entry','mid','senior','staff','director','vp','c_suite']);
const LOCATION_TYPES = new Set(['remote','hybrid','on_site','unknown']);

function readJSONSafe(p, fallback) {
  try {
    const txt = fs.readFileSync(p, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    return fallback;
  }
}

function writeJSONAtomic(p, obj) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text || '', 'utf8').digest('hex');
}

function renderPrompt(template, vars) {
  let out = template;
  Object.keys(vars).forEach(k => {
    const safe = String(vars[k] == null ? '' : vars[k]);
    out = out.split('{' + k + '}').join(safe);
  });
  return out;
}

async function callGeminiEnrichment(prompt) {
  const apiKey = config.enrichment.apiKey;
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
  return callGeminiText({
    apiKey,
    model: config.enrichment.model,
    fallbackModel: config.enrichment.fallbackModel || null,
    prompt,
    maxOutputTokens: 1200,
  });
}

function extractJSON(text) {
  if (!text) throw new Error('Empty LLM response');
  // strip code fences
  let s = text.replace(/```(?:json)?/g, '\n').trim();
  // find first { and last }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) throw new Error('No JSON object found in LLM response');
  const candidate = s.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch (e) {
    // try to fix common issues: trailing commas
    const fixed = candidate.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    try { return JSON.parse(fixed); } catch (e2) { throw new Error('Failed to parse JSON from LLM response'); }
  }
}

function sanitize(parsed) {
  const out = {};
  if (parsed.job_title_normalized) out.job_title_normalized = String(parsed.job_title_normalized).trim();
  out.job_function = parsed.job_function ? String(parsed.job_function).toLowerCase().trim() : null;
  if (!JOB_FUNCTIONS.has(out.job_function)) out.job_function = 'other';

  out.seniority_level = parsed.seniority_level ? String(parsed.seniority_level).toLowerCase().trim() : null;
  if (!SENIORITY.has(out.seniority_level)) out.seniority_level = null;

  out.location_type = parsed.location_type ? String(parsed.location_type).toLowerCase().trim() : 'unknown';
  if (!LOCATION_TYPES.has(out.location_type)) out.location_type = 'unknown';

  let score = null;
  if (typeof parsed.mba_relevance_score === 'number') score = Math.round(parsed.mba_relevance_score);
  else if (typeof parsed.mba_relevance_score === 'string') {
    const n = parseInt(parsed.mba_relevance_score.replace(/[^0-9]/g, ''), 10);
    if (!Number.isNaN(n)) score = n;
  }
  if (score == null) score = 0;
  score = Math.max(0, Math.min(100, score));
  out.mba_relevance_score = score;

  out.description_summary = parsed.description_summary ? String(parsed.description_summary).trim() : null;

  const cr = parsed.climate_relevance_confirmed;
  out.climate_relevance_confirmed = (cr === true || cr === 'true' || cr === 'True');
  out.climate_relevance_reason = parsed.climate_relevance_reason ? String(parsed.climate_relevance_reason).trim() : null;

  return out;
}

async function enrichJob(job, categories, promptTemplate) {
  const desc = (job.description_raw || '').slice(0, 8000);
  const prompt = renderPrompt(promptTemplate, {
    job_title_raw: job.job_title_raw || job.title || '',
    company_name: job.company_name || job.company || '',
    location_raw: job.location_raw || job.location || '',
    description_raw: desc,
    category_names: categories.join(', ')
  });

  const raw = await callGeminiEnrichment(prompt);
  const parsed = extractJSON(raw);
  const sanitized = sanitize(parsed);

  // assign fields to job
  job.job_title_normalized = sanitized.job_title_normalized || job.job_title_normalized || null;
  job.job_function = sanitized.job_function || job.job_function || 'other';
  job.seniority_level = sanitized.seniority_level || job.seniority_level || null;
  job.location_type = sanitized.location_type || job.location_type || 'unknown';
  job.mba_relevance_score = typeof sanitized.mba_relevance_score === 'number' ? sanitized.mba_relevance_score : (job.mba_relevance_score || 0);
  job.description_summary = sanitized.description_summary || job.description_summary || null;
  job.climate_relevance_confirmed = sanitized.climate_relevance_confirmed === true;
  job.climate_relevance_reason = sanitized.climate_relevance_reason || job.climate_relevance_reason || null;

  job.enrichment_prompt_version = ENRICHMENT_PROMPT_VERSION;
  job.description_raw_hash = sha256(job.description_raw || '');
  job.last_enriched_at = new Date().toISOString();

  // clear any previous error
  delete job.enrichment_error;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function delayMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createRateLimitedPool(concurrency = 3, delayBetweenMs = 1500) {
  return async function runTasks(tasks) {
    const inFlight = new Set();
    let index = 0;
    while (index < tasks.length || inFlight.size > 0) {
      while (index < tasks.length && inFlight.size < concurrency) {
        const taskIndex = index++;
        let p = null;
        p = (async () => {
          try {
            await tasks[taskIndex]();
          } catch (e) {
            // task handles its own error; swallow here to keep pool running
          }
        })();
        inFlight.add(p);
        p.finally(() => inFlight.delete(p));
        // throttle starts
        await delayMs(delayBetweenMs);
      }
      if (inFlight.size > 0) {
        try {
          await Promise.race(Array.from(inFlight));
        } catch (e) {
          // ignore - individual tasks already handle errors
        }
      }
    }
  };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const batchSizeArg = args.find(a => a.startsWith('--batch-size='));
  const BATCH_SIZE = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) || 10 : 10;
  const concurrencyArg = args.find(a => a.startsWith('--concurrency='));
  const delayArg = args.find(a => a.startsWith('--delay='));
  const CONCURRENCY = concurrencyArg ? parseInt(concurrencyArg.split('=')[1], 10) || 3 : 3;
  const DELAY_BETWEEN_MS = delayArg ? parseInt(delayArg.split('=')[1], 10) || 1500 : 1500;

  const jobs = readJSONSafe(JOBS_PATH, null);
  if (!jobs) {
    console.error('No data/jobs.json found at', JOBS_PATH);
    process.exit(1);
  }

  const taxonomy = readJSONSafe(TAX_PATH, []);
  const categories = taxonomy.map(c => c['Tech Category Name'] || c['Tech category name'] || c.name).filter(Boolean);

  const promptTemplate = readJSONSafe(PROMPT_PATH, null) || fs.readFileSync(PROMPT_PATH, 'utf8');

  // decide which jobs to enrich
  const toEnrich = [];
  const retryErrors = args.includes('--retry-errors');
  if (retryErrors) {
    for (const job of jobs) {
      if (job.enrichment_error) toEnrich.push(job);
    }
  } else {
    for (const job of jobs) {
      const prevVersion = job.enrichment_prompt_version || null;
      const descHash = sha256(job.description_raw || '');
      const requiredFields = ['job_title_normalized','job_function','seniority_level','location_type','mba_relevance_score','description_summary','climate_relevance_confirmed'];
      const missing = requiredFields.some(f => job[f] == null);
      const changed = job.description_raw_hash !== descHash;
      if (force || prevVersion !== ENRICHMENT_PROMPT_VERSION || changed || missing) toEnrich.push(job);
    }
  }

  if (toEnrich.length === 0) {
    console.log('No jobs require enrichment. Use --force to re-run.');
    return;
  }

  console.log(`Enriching ${toEnrich.length} jobs in batches of ${BATCH_SIZE}...`);

  const batches = chunkArray(toEnrich, BATCH_SIZE);
  let enrichedCount = 0;
  const scoreBuckets = [0,0,0,0,0]; // 0-19,20-39,40-59,60-79,80-100
  let climateTrue = 0, climateFalse = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`Processing batch ${i+1}/${batches.length} (${batch.length} jobs)`);

    const tasks = batch.map(job => async () => {
      try {
        await enrichJob(job, categories, promptTemplate);
        enrichedCount += 1;
        const s = job.mba_relevance_score || 0;
        const idx = Math.min(4, Math.floor(s / 20));
        scoreBuckets[idx] += 1;
        if (job.climate_relevance_confirmed) climateTrue += 1; else climateFalse += 1;
      } catch (err) {
        job.enrichment_error = String(err.message || err);
        console.error('Failed to enrich job', job.id || job.url || job.job_title_raw, err.message || err);
      }
    });

    const pool = createRateLimitedPool(CONCURRENCY, DELAY_BETWEEN_MS);
    await pool(tasks);

    // write back after each batch
    try {
      writeJSONAtomic(JOBS_PATH, jobs);
      console.log(`Wrote updated jobs.json after batch ${i+1}`);
    } catch (e) {
      console.error('Failed to write jobs.json:', e.message || e);
    }
  }

  // print distribution
  const errorCount = jobs.filter(j => j.enrichment_error).length;
  console.log('\nEnrichment complete');
  console.log('Total enriched:', enrichedCount);
  console.log('Jobs with enrichment_error:', errorCount);
  console.log('MBA relevance buckets (0-19,20-39,40-59,60-79,80-100):', scoreBuckets.join(', '));
  const totalClimate = climateTrue + climateFalse || 1;
  console.log('Climate relevance true/false:', climateTrue, '/', climateFalse, `( ${Math.round((climateTrue/totalClimate)*100)}% true )`);
}

module.exports = {
  sha256,
  extractJSON,
  sanitize,
  renderPrompt,
  chunkArray,
  ENRICHMENT_PROMPT_VERSION
};

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
