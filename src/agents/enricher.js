const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const JOBS_PATH = path.join(REPO_ROOT, 'data', 'jobs.json');
const TAX_PATH = path.join(REPO_ROOT, 'data', 'climate-tech-map-industry-categories.json');
const PROMPT_PATH = path.join(REPO_ROOT, 'src', 'prompts', 'enrichment.txt');
const ENRICHMENT_PROMPT_VERSION = '1.0.0';

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-2.1';
const API_URL = 'https://api.anthropic.com/v1/complete';

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

function callAnthropic(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const body = JSON.stringify({ model, prompt, max_tokens_to_sample: 1200, temperature: 0.0 });

  return new Promise((resolve, reject) => {
    const req = https.request(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const text = json.completion || json.completion || json.output || json.text || json.completion_text || (typeof json === 'string' ? json : null);
          resolve(text || JSON.stringify(json));
        } catch (err) {
          // not JSON -> return raw
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
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

  const raw = await callAnthropic(prompt);
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

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const batchSizeArg = args.find(a => a.startsWith('--batch-size='));
  const BATCH_SIZE = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) || 10 : 10;

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
  for (const job of jobs) {
    const prevVersion = job.enrichment_prompt_version || null;
    const descHash = sha256(job.description_raw || '');
    const requiredFields = ['job_title_normalized','job_function','seniority_level','location_type','mba_relevance_score','description_summary','climate_relevance_confirmed'];
    const missing = requiredFields.some(f => job[f] == null);
    const changed = job.description_raw_hash !== descHash;
    if (force || prevVersion !== ENRICHMENT_PROMPT_VERSION || changed || missing) toEnrich.push(job);
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
    await Promise.all(batch.map(async (job) => {
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
    }));

    // write back after each batch
    try {
      writeJSONAtomic(JOBS_PATH, jobs);
      console.log(`Wrote updated jobs.json after batch ${i+1}`);
    } catch (e) {
      console.error('Failed to write jobs.json:', e.message || e);
    }
  }

  // print distribution
  console.log('\nEnrichment complete');
  console.log('Total enriched:', enrichedCount);
  console.log('MBA relevance buckets (0-19,20-39,40-59,60-79,80-100):', scoreBuckets.join(', '));
  const totalClimate = climateTrue + climateFalse || 1;
  console.log('Climate relevance true/false:', climateTrue, '/', climateFalse, `( ${Math.round((climateTrue/totalClimate)*100)}% true )`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
