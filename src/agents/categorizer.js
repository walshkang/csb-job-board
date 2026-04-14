const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const JOBS_PATH = path.join(REPO_ROOT, 'data', 'jobs.json');
const TAX_PATH = path.join(REPO_ROOT, 'data', 'climate-tech-map-industry-categories.json');
const COMPANIES_PATH = path.join(REPO_ROOT, 'data', 'companies.json');

const config = require('../config');
const { callGeminiText } = require('../gemini-text');
const { extractJSON } = require('./enricher');

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
        const p = (async () => {
          try {
            await tasks[taskIndex]();
          } catch (e) {
            // swallow - individual tasks set errors on jobs
          }
        })();
        inFlight.add(p);
        p.finally(() => inFlight.delete(p));
        await delayMs(delayBetweenMs);
      }
      if (inFlight.size > 0) {
        try {
          await Promise.race(Array.from(inFlight));
        } catch (e) {
          // ignore
        }
      }
    }
  };
}

async function categorizeCompany(companyId, companyName, repJob, categoriesList, jobsForCompany, opts) {
  const { apiKey, model, dryRun } = opts;
  const jobTitle = repJob.job_title_normalized || repJob.job_title_raw || '';
  const jobFunction = repJob.job_function || '';
  const climateReason = repJob.climate_relevance_reason || '';
  const descSummary = repJob.description_summary || '';

  const prompt = `You are categorizing a job at a climate-tech company for an MBA-focused job board.\n\nCompany: ${companyName}\nJob title: ${jobTitle}\nJob function: ${jobFunction}\nClimate relevance reason: ${climateReason}\nDescription summary: ${descSummary}\n\nClimate-tech categories (Tech Category Name | Related Opportunity Area | Primary Sector):\n${categoriesList}\n\nTask: Select the single best-matching Tech Category Name for this company/role. If the company clearly operates in one category, use that — the job function doesn't need to match. If the company operates across multiple categories, pick the most specific one. If no category fits (e.g. generic SaaS, pure finance), return "None".\n\nReturn ONLY a JSON object:\n{"climate_tech_category": "Solar PV", "primary_sector": "Electricity", "opportunity_area": "Low-Emissions Generation", "category_confidence": "high|medium|low"}`;

  try {
    const raw = await callGeminiText({ apiKey, model, prompt, maxOutputTokens: 4096 });
    let parsed = null;
    try {
      parsed = extractJSON(raw);
    } catch (e) {
      const err = { message: 'parse_failed', detail: String(e.message || e), raw_response: raw };
      for (const j of jobsForCompany) j.category_error = err;
      console.error(`Company ${companyId} (${companyName}): JSON parse failed`);
      return;
    }

    // Apply parsed fields to all jobs for this company
    const ctc = parsed.climate_tech_category == null ? null : String(parsed.climate_tech_category).trim();
    const primary = parsed.primary_sector == null ? null : String(parsed.primary_sector).trim();
    const opp = parsed.opportunity_area == null ? null : String(parsed.opportunity_area).trim();
    const conf = parsed.category_confidence == null ? null : String(parsed.category_confidence).trim();

    for (const j of jobsForCompany) {
      j.climate_tech_category = ctc;
      j.primary_sector = primary;
      j.opportunity_area = opp;
      j.category_confidence = conf;
      delete j.category_error;
    }

    if (dryRun) {
      console.log(`DRY ${companyId} -> ${ctc} (${conf})`);
    } else {
      console.info(`Company ${companyId} -> ${ctc} (${conf})`);
    }
  } catch (err) {
    const eobj = { message: 'call_failed', detail: String(err.message || err) };
    for (const j of jobsForCompany) j.category_error = eobj;
    console.error(`Company ${companyId} (${companyName}): callGeminiText failed: ${String(err.message || err)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');

  const jobs = readJSONSafe(JOBS_PATH, null);
  if (!jobs) {
    console.error('No data/jobs.json found');
    process.exit(1);
  }
  const companies = readJSONSafe(COMPANIES_PATH, []);
  const taxonomy = readJSONSafe(TAX_PATH, []);

  const categoriesList = taxonomy.map(c => {
    const name = c['Tech Category Name'] || c['Tech category name'] || c.name || '';
    const area = c['Related Opportunity Area'] || c['Related opportunity area'] || '';
    const sector = c['Primary Sector'] || c['Primary sector'] || '';
    return `${name} | ${area} | ${sector}`;
  }).join('\n');

  // Group jobs by company_id
  const byCompany = new Map();
  for (const job of jobs) {
    const cid = job.company_id || job.company || 'unknown';
    if (!byCompany.has(cid)) byCompany.set(cid, []);
    byCompany.get(cid).push(job);
  }

  // Build tasks: one per company
  const tasks = [];
  const apiKey = config.enrichment.apiKey;
  const model = config.enrichment.model;
  const pool = createRateLimitedPool(3, 1000);

  for (const [companyId, jobsForCompany] of byCompany.entries()) {
    // skip when first job already has climate_tech_category and not --force
    const firstJob = jobsForCompany[0] || {};
    if (!force && firstJob.climate_tech_category) continue;

    const companyRecord = (companies || []).find(c => String(c.id) === String(companyId) || String(c.id) === String(firstJob.company_id));
    const companyName = (companyRecord && (companyRecord.name || companyRecord.company || companyRecord.title)) || firstJob.company_name || String(companyId);

    const repJob = firstJob;

    tasks.push(async () => categorizeCompany(companyId, companyName, repJob, categoriesList, jobsForCompany, { apiKey, model, dryRun }));
  }

  if (tasks.length === 0) {
    console.log('No companies to categorize (use --force to re-run)');
    return;
  }

  console.log(`Categorizing ${tasks.length} companies with concurrency=3, delay=1000ms`);
  await pool(tasks);

  if (dryRun) {
    console.log('Dry-run complete. No file written.');
    return;
  }

  try {
    writeJSONAtomic(JOBS_PATH, jobs);
    console.log('Wrote updated data/jobs.json');
  } catch (e) {
    console.error('Failed to write jobs.json:', e.message || e);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
