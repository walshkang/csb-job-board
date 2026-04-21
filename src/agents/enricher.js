const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const JOBS_PATH = path.join(REPO_ROOT, 'data', 'jobs.json');
const TAX_PATH = path.join(REPO_ROOT, 'data', 'climate-tech-map-industry-categories.json');
const PROMPT_PATH = path.join(REPO_ROOT, 'src', 'prompts', 'enrichment.txt');
const ENRICHMENT_PROMPT_VERSION = '1.3.4';

const config = require('../config');
const { startRun, endRun } = require('../utils/run-log');
const { callLLM, streamLLM } = require('../llm-client');
const Progress = require('../utils/progress');

const JOB_FUNCTIONS = new Set(['engineering','product','design','operations','sales','marketing','finance','legal','hr','data_science','strategy','policy','supply_chain','customer_success','other']);
const MBA_RELEVANCE = new Set(['low', 'medium', 'high']);
const SENIORITY_LEVELS = new Set(['intern','entry','mid','senior','staff','director','vp','c_suite','unknown']);
const MBA_HIGH_FUNCTIONS = new Set(['strategy', 'finance', 'product', 'legal', 'policy']);
const MBA_HIGH_SENIORITIES = new Set(['mid', 'senior', 'staff', 'director', 'vp', 'c_suite']);
const MBA_LOW_FUNCTIONS = new Set(['engineering', 'hr', 'customer_success']);
const MBA_LOW_SENIORITIES = new Set(['intern', 'entry']);

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

async function callGeminiEnrichment(prompt, { stream = false, label = '' } = {}) {
  const { provider, apiKey, model, fallbackModel } = config.resolveAgent('enrichment');
  if (!apiKey) throw new Error('No LLM API key configured for enrichment');
  const opts = {
    provider,
    apiKey,
    model,
    fallbackModel: provider === 'anthropic' ? null : (fallbackModel || null),
    prompt,
    maxOutputTokens: 4096,
  };
  if (stream) {
    const prefix = label ? `\n[${label}] ` : '\n';
    process.stderr.write(prefix);
    return streamLLM({ ...opts, _agent: 'enrichment', onToken: chunk => process.stderr.write(chunk) });
  }
  return callLLM({ ...opts, _agent: 'enrichment' });
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

  let seniorityLevel = parsed.seniority_level ? String(parsed.seniority_level).toLowerCase().trim() : null;
  if (!SENIORITY_LEVELS.has(seniorityLevel)) seniorityLevel = 'unknown';
  out.seniority_level = seniorityLevel;

  let mbaRelevance = parsed.mba_relevance ? String(parsed.mba_relevance).toLowerCase().trim() : null;
  if (!MBA_RELEVANCE.has(mbaRelevance)) mbaRelevance = null;
  out.mba_relevance = mbaRelevance;

  const cr = parsed.climate_relevance_confirmed;
  out.climate_relevance_confirmed = (cr === true || cr === 'true' || cr === 'True');
  out.climate_relevance_reason = parsed.climate_relevance_reason ? String(parsed.climate_relevance_reason).trim() : null;

  return out;
}

function normalizeJobTitleDeterministic(rawTitle) {
  let normalized = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  const replacements = [
    [/\bSr\.?(?=\s|$)/gi, 'Senior'],
    [/\bJr\.?(?=\s|$)/gi, 'Junior'],
    [/\bEng\.?(?=\s|$)/gi, 'Engineer'],
    [/\bMgr\.?(?=\s|$)/gi, 'Manager'],
    [/\bDir\.?(?=\s|$)/gi, 'Director'],
    [/\bAssoc\.?(?=\s|$)/gi, 'Associate']
  ];

  for (const [pattern, replacement] of replacements) {
    normalized = normalized.replace(pattern, replacement);
  }

  normalized = normalized.replace(/ (I{1,3}|IV|VI{0,3}|IX|[1-9])$/i, '');
  return normalized.replace(/\s+/g, ' ').trim();
}

function lookupDeterministicMbaRelevance(job_function, seniority_level) {
  if (job_function == null || seniority_level == null || seniority_level === 'unknown') return null;
  if (MBA_HIGH_FUNCTIONS.has(job_function) && MBA_HIGH_SENIORITIES.has(seniority_level)) return 'high';
  if (seniority_level === 'intern') return 'low';
  if (MBA_LOW_FUNCTIONS.has(job_function) && MBA_LOW_SENIORITIES.has(seniority_level)) return 'low';
  return 'medium';
}

function resolveDeterministic(job) {
  const title = String(job.job_title_raw || job.title || '').trim();
  const description = String(job.description_raw || job.description || '').trim();
  const location = String(job.location_raw || job.location || '').trim();
  const titleAndDescription = `${title} ${description}`.trim();
  const job_title_normalized = normalizeJobTitleDeterministic(title);
  let job_function = null;
  if (/\b(chief of staff|strategy\s*&?\s*ops|corporate strategy)\b/i.test(title)) job_function = 'strategy';
  else if (/\bproduct manager\b|\btechnical product\b/i.test(title)) job_function = 'product';
  else if (/\b(fp&a|financial planning|controller|treasurer|corporate accounting|finance manager|cfo)\b/i.test(title)) job_function = 'finance';
  else if (/\b(general counsel|legal counsel|attorney|compliance officer)\b/i.test(title)) job_function = 'legal';
  else if (/\b(data scientist|data analyst|analytics engineer|ml engineer)\b/i.test(title)) job_function = 'data_science';
  else if (/\b(policy|government affairs|regulatory affairs|public affairs)\b/i.test(title)) job_function = 'policy';
  else if (/\b(marketing|brand|content|communications|pr\b|public relations|growth)\b/i.test(title)) job_function = 'marketing';
  else if (/\b(business development|bd\b|partnerships|sales ops|account executive|account manager|account rep)\b/i.test(title)) job_function = 'sales';
  else if (/\b(procurement|logistics|materials|supply chain|planning)\b/i.test(title)) job_function = 'supply_chain';
  else if (/\b(program manager|project manager|operations manager|ops manager)\b/i.test(title)) job_function = 'operations';
  else if (/\b(people operations|recruiter|talent|hrbp|hr business|human resources)\b/i.test(title)) job_function = 'hr';
  else if (/\b(customer success|customer support|renewals|implementation specialist)\b/i.test(title)) job_function = 'customer_success';
  else if (/\b(product designer|ux|ui designer|visual designer|graphic designer)\b/i.test(title)) job_function = 'design';
  else if (/\b(engineer|developer|architect|swe|sde|devops|sre|platform)\b/i.test(title)) job_function = 'engineering';

  let seniority_level = null;
  if (/\b(intern|internship)\b/i.test(title)) seniority_level = 'intern';
  else if (/\b(ceo|cto|coo|cfo|cpo|chief\s+\w+\s+officer)\b/i.test(title)) seniority_level = 'c_suite';
  else if (/\b(vp|vice president)\b/i.test(title)) seniority_level = 'vp';
  else if (/\b(director|head of)\b/i.test(title)) seniority_level = 'director';
  else if (/\b(staff|principal)\b/i.test(title)) seniority_level = 'staff';
  else if (/\b(senior|sr\.?|lead)\b/i.test(title)) seniority_level = 'senior';
  else if (/\b(junior|jr\.?|associate|entry)\b/i.test(title)) seniority_level = 'entry';
  else if (/\bmanager\b/i.test(title) && !/\b(people|engineering|product|program|project|general|senior)\s+manager\b/i.test(title)) seniority_level = 'mid';
  else seniority_level = 'unknown';

  let employment_type = 'full_time';
  if (/\bintern(ship)?\b/i.test(titleAndDescription)) employment_type = 'intern';
  else if (/\b(contract|contractor|consultant)\b/i.test(titleAndDescription)) employment_type = 'contract';
  else if (/\bpart[- ]time\b/i.test(titleAndDescription)) employment_type = 'part_time';

  let location_type = 'unknown';
  if (/\bremote\b/i.test(location)) location_type = 'remote';
  else if (/\bhybrid\b/i.test(location)) location_type = 'hybrid';
  else if (location.length > 0) location_type = 'on_site';

  const mba_relevance = lookupDeterministicMbaRelevance(job_function, seniority_level);
  return { job_title_normalized, job_function, seniority_level, employment_type, location_type, mba_relevance };
}

async function enrichJob(job, categories, promptTemplate, options = {}) {
  const deterministic = resolveDeterministic(job);

  // Skip LLM call when there's no description — apply null defaults and mark complete.
  if (!job.description_raw) {
    job.job_title_normalized = deterministic.job_title_normalized || job.job_title_normalized || null;
    job.job_function = deterministic.job_function ?? job.job_function ?? 'other';
    job.seniority_level = deterministic.seniority_level ?? 'unknown';
    job.employment_type = deterministic.employment_type;
    job.location_type = deterministic.location_type;
    job.mba_relevance = deterministic.mba_relevance ?? (MBA_RELEVANCE.has(job.mba_relevance) ? job.mba_relevance : 'low');
    job.description_summary = null;
    job.climate_relevance_confirmed = false;
    job.climate_relevance_reason = null;
    job.enrichment_prompt_version = ENRICHMENT_PROMPT_VERSION;
    job.description_raw_hash = sha256('');
    job.last_enriched_at = new Date().toISOString();
    delete job.enrichment_error;
    return;
  }

  const rawDesc = (job.description_raw || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const desc = rawDesc.slice(0, 8000);
  const prompt = renderPrompt(promptTemplate, {
    job_title_raw: job.job_title_raw || job.title || '',
    company_name: job.company_name || job.company || '',
    location_raw: job.location_raw || job.location || '',
    description_raw: desc,
    category_names: categories.join(', ')
  });

  const raw = await callGeminiEnrichment(prompt, options);
  const parsed = extractJSON(raw);
  const sanitized = sanitize(parsed);

  // assign fields to job
  job.job_title_normalized = deterministic.job_title_normalized || job.job_title_normalized || null;
  job.job_function = deterministic.job_function ?? sanitized.job_function ?? job.job_function ?? 'other';
  job.seniority_level = deterministic.seniority_level ?? sanitized.seniority_level ?? 'unknown';
  job.employment_type = deterministic.employment_type;
  job.location_type = deterministic.location_type;
  job.mba_relevance = deterministic.mba_relevance ??
    (MBA_RELEVANCE.has(sanitized.mba_relevance) ? sanitized.mba_relevance : null) ??
    (MBA_RELEVANCE.has(job.mba_relevance) ? job.mba_relevance : 'low');
  job.climate_relevance_confirmed = sanitized.climate_relevance_confirmed === true;
  job.climate_relevance_reason = sanitized.climate_relevance_reason || job.climate_relevance_reason || null;
  if (job.climate_relevance_confirmed === true) job.climate_relevance_reason = null;

  job.enrichment_prompt_version = ENRICHMENT_PROMPT_VERSION;
  job.description_raw_hash = sha256(job.description_raw || '');
  job.last_enriched_at = new Date().toISOString();

  // clear any previous error
  delete job.enrichment_error;
}

// Batch enrichment: accept 2-10 jobs and return results mapped back by index.
async function enrichJobBatch(jobsArray, categories, promptTemplate, options = {}) {
  const N = jobsArray.length;
  if (N < 2 || N > 10) throw new Error('enrichJobBatch requires 2-10 jobs');

  const deterministicByJob = jobsArray.map(job => resolveDeterministic(job));
  for (let i = 0; i < N; i++) {
    jobsArray[i].seniority_level = deterministicByJob[i].seniority_level;
    jobsArray[i].employment_type = deterministicByJob[i].employment_type;
    jobsArray[i].location_type = deterministicByJob[i].location_type;
  }

  // build numbered jobs list
  const jobsRendered = jobsArray.map((job, idx) => {
    const title = job.job_title_raw || job.title || '';
    const company = job.company_name || job.company || '';
    const location = job.location_raw || job.location || '';
    const description = (job.description_raw || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
    return `Job ${idx + 1}:\nTitle: ${title}\nCompany: ${company}\nLocation: ${location}\nDescription: ${description}`;
  }).join('\n\n');

  // extract field rules from the single-job prompt if present
  let fieldRules = promptTemplate;
  const frIdx = promptTemplate.indexOf('## Field rules');
  if (frIdx !== -1) fieldRules = promptTemplate.slice(frIdx);

  const batchTemplate = fs.readFileSync(path.join(__dirname, '../prompts/enrichment-batch.txt'), 'utf8');
  const prompt = batchTemplate
    .replace('{n}', String(N))
    .replace('{n}', String(N)) // second occurrence in "exactly {n} objects"
    .replace('{category_names}', categories.join(', '))
    .replace('{jobs}', jobsRendered)
    .replace('{field_rules}', fieldRules);

  const raw = await callGeminiEnrichment(prompt, options);

  // Try to extract an outermost JSON array first
  let parsedArray = null;
  try {
    if (!raw) throw new Error('Empty LLM response');
    const s = raw.replace(/```(?:json)?/g, '\n').trim();
    const firstArr = s.indexOf('[');
    const lastArr = s.lastIndexOf(']');
    if (firstArr !== -1 && lastArr !== -1 && lastArr > firstArr) {
      const candidate = s.slice(firstArr, lastArr + 1);
      parsedArray = JSON.parse(candidate);
    }
  } catch (e) {
    parsedArray = null;
  }

  // Fallback: try extractJSON and unwrap array from object
  if (!Array.isArray(parsedArray)) {
    try {
      const maybeObj = extractJSON(raw);
      if (Array.isArray(maybeObj)) parsedArray = maybeObj;
      else if (maybeObj && typeof maybeObj === 'object') {
        const vals = Object.values(maybeObj);
        const found = vals.find(v => Array.isArray(v));
        if (found) parsedArray = found;
      }
    } catch (e) {
      parsedArray = null;
    }
  }

  const now = new Date().toISOString();
  if (!Array.isArray(parsedArray) || parsedArray.length !== N) {
    // set metadata and errors so these jobs will be retried individually later
    for (let i = 0; i < N; i++) {
      const job = jobsArray[i];
      job.enrichment_prompt_version = ENRICHMENT_PROMPT_VERSION;
      job.description_raw_hash = sha256(job.description_raw || '');
      job.last_enriched_at = now;
      job.enrichment_error = `batch result missing for index ${i}`;
    }
    throw new Error('Failed to parse batch array of expected length');
  }

  // Map results back to jobs by index
  for (let i = 0; i < N; i++) {
    const job = jobsArray[i];
    const res = parsedArray[i];
    job.enrichment_prompt_version = ENRICHMENT_PROMPT_VERSION;
    job.description_raw_hash = sha256(job.description_raw || '');
    job.last_enriched_at = now;
    if (res && typeof res === 'object') {
      const sanitized = sanitize(res);
      job.job_title_normalized = deterministicByJob[i].job_title_normalized || job.job_title_normalized || null;
      job.job_function = deterministicByJob[i].job_function ?? sanitized.job_function ?? job.job_function ?? 'other';
      job.seniority_level = deterministicByJob[i].seniority_level ?? sanitized.seniority_level ?? 'unknown';
      job.employment_type = deterministicByJob[i].employment_type;
      job.location_type = deterministicByJob[i].location_type;
      job.mba_relevance = deterministicByJob[i].mba_relevance ??
        (MBA_RELEVANCE.has(sanitized.mba_relevance) ? sanitized.mba_relevance : null) ??
        (MBA_RELEVANCE.has(job.mba_relevance) ? job.mba_relevance : 'low');
      job.description_summary = sanitized.description_summary || job.description_summary || null;
      job.climate_relevance_confirmed = sanitized.climate_relevance_confirmed === true;
      job.climate_relevance_reason = sanitized.climate_relevance_reason || job.climate_relevance_reason || null;
      if (job.climate_relevance_confirmed === true) job.climate_relevance_reason = null;
      delete job.enrichment_error;
    } else {
      job.enrichment_error = `batch result missing for index ${i}`;
    }
  }
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
  const run = startRun('enricher');
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const verbose = args.includes('--verbose');
  const batchMode = args.includes('--batch-mode');
  const useStream = !args.includes('--no-stream') && !batchMode;
  const batchSizeArg = args.find(a => a.startsWith('--batch-size='));
  const defaultBatch = batchMode ? 5 : 10;
  const BATCH_SIZE = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) || defaultBatch : defaultBatch;
  const concurrencyArg = args.find(a => a.startsWith('--concurrency='));
  const delayArg = args.find(a => a.startsWith('--delay='));
  const CONCURRENCY = concurrencyArg ? parseInt(concurrencyArg.split('=')[1], 10) || 3 : 3;
  const DELAY_BETWEEN_MS = delayArg ? parseInt(delayArg.split('=')[1], 10) || (batchMode ? 2000 : 1500) : (batchMode ? 2000 : 1500);

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
      const requiredFields = ['job_title_normalized','job_function','seniority_level','employment_type','location_type','mba_relevance','climate_relevance_confirmed'];
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
  const progress = new Progress(toEnrich.length, 'enricher');

  const batches = chunkArray(toEnrich, BATCH_SIZE);
  let enrichedCount = 0; let errorCountLocal = 0;
  const mbaBuckets = { low: 0, medium: 0, high: 0, unknown: 0 };
  let climateTrue = 0, climateFalse = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`Processing batch ${i+1}/${batches.length} (${batch.length} jobs)`);

    let tasks = [];

    if (batchMode) {
      // single task per batch: call enrichJobBatch once
      tasks = [async () => {
        const enrichOptions = { stream: useStream, label: batch.map(j => j.id || j.job_title_raw || '').join(',') };
        try {
          await enrichJobBatch(batch, categories, promptTemplate, enrichOptions);
          if (verbose) {
            for (const job of batch) {
              if (!job.enrichment_error) {
                console.log(`  [${job.company_name || job.company_id}] "${job.job_title_normalized || job.job_title_raw}" | fn=${job.job_function} seniority=${job.seniority_level} mba=${job.mba_relevance} climate=${job.climate_relevance_confirmed}`);
              }
            }
          }
          // update counters per job
          for (const job of batch) {
            if (!job.enrichment_error) {
              enrichedCount += 1;
              const mba = MBA_RELEVANCE.has(job.mba_relevance) ? job.mba_relevance : 'unknown';
              mbaBuckets[mba] += 1;
              if (job.climate_relevance_confirmed) climateTrue += 1; else climateFalse += 1;
            } else {
              errorCountLocal += 1;
            }
          }
        } catch (err) {
          // mark any without errors
          for (let k = 0; k < batch.length; k++) {
            const job = batch[k];
            if (!job.enrichment_error) job.enrichment_error = String(err.message || err);
          }
          errorCountLocal += batch.length;
          console.error('Failed to enrich batch', i + 1, err.message || err);
        } finally {
          try { progress.tick(enrichedCount + errorCountLocal, batch.map(j => j.job_title_raw || '').join('; ')); } catch (_) {}
        }
      }];
    } else {
      // existing per-job tasks
      tasks = batch.map(job => async () => {
        const enrichOptions = { stream: useStream, label: job.id || job.job_title_raw || '' };
        try {
          await enrichJob(job, categories, promptTemplate, enrichOptions);
          if (verbose) console.log(`  [${job.company_name || job.company_id}] "${job.job_title_normalized || job.job_title_raw}" | fn=${job.job_function} seniority=${job.seniority_level} mba=${job.mba_relevance} climate=${job.climate_relevance_confirmed}`);
          enrichedCount += 1;
          const mba = MBA_RELEVANCE.has(job.mba_relevance) ? job.mba_relevance : 'unknown';
          mbaBuckets[mba] += 1;
          if (job.climate_relevance_confirmed) climateTrue += 1; else climateFalse += 1;
        } catch (err) {
          job.enrichment_error = String(err.message || err);
          errorCountLocal += 1;
          console.error('Failed to enrich job', job.id || job.url || job.job_title_raw, err.message || err);
        } finally {
          try { progress.tick(enrichedCount + errorCountLocal, job.job_title_raw || ''); } catch (_) {}
        }
      });
    }

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
  progress.done();
  const errorCount = jobs.filter(j => j.enrichment_error).length;
  console.log('\nEnrichment complete');
  console.log('Total enriched:', enrichedCount);
  console.log('Jobs with enrichment_error:', errorCount);
  console.log('MBA relevance buckets (low,medium,high,unknown):', `${mbaBuckets.low}, ${mbaBuckets.medium}, ${mbaBuckets.high}, ${mbaBuckets.unknown}`);
  const totalClimate = climateTrue + climateFalse || 1;
  console.log('Climate relevance true/false:', climateTrue, '/', climateFalse, `( ${Math.round((climateTrue/totalClimate)*100)}% true )`);
  // finalize run log
  await endRun(run, { processed: toEnrich.length, enriched: enrichedCount, errors: errorCount });
}

module.exports = {
  sha256,
  extractJSON,
  sanitize,
  resolveDeterministic,
  renderPrompt,
  chunkArray,
  ENRICHMENT_PROMPT_VERSION,
  PROMPT_PATH,
  enrichJob,
  enrichJobBatch
};

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
