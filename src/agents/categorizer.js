const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const JOBS_PATH = path.join(REPO_ROOT, 'data', 'jobs.json');
const TAX_PATH = path.join(REPO_ROOT, 'data', 'climate-tech-map-industry-categories.json');
const COMPANIES_PATH = path.join(REPO_ROOT, 'data', 'companies.json');

const config = require('../config');
const { callLLM } = require('../llm-client');
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
            // swallow - individual tasks handle errors
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

async function categorizeCompany(companyRecord, repJob, categoriesList, opts, samples) {
  const { provider, apiKey, model, dryRun } = opts;
  const companyId = companyRecord.id;
  const companyName = companyRecord.name || companyRecord.company || String(companyId);
  const jobTitle = repJob.job_title_normalized || repJob.job_title_raw || '';
  const jobFunction = repJob.job_function || '';
  const climateReason = repJob.climate_relevance_reason || '';
  const descSummary = repJob.description_summary || '';

  const companyProfile = (companyRecord.company_profile && companyRecord.company_profile.scraped_description) ? companyRecord.company_profile.scraped_description : null;
  const pitchbookKeywords = (companyRecord.company_profile && companyRecord.company_profile.keywords) ? companyRecord.company_profile.keywords : null;
  const samplesText = (!samples || samples.length === 0) ? 'None' : samples.map(s => `- ${s.title}: ${s.summary || ''}`).join('\n');

  const promptTemplate = fs.readFileSync(path.join(__dirname, '../prompts/categorizer.txt'), 'utf8');
  const prompt = promptTemplate
    .replace('{company_name}', companyName)
    .replace('{company_profile}', companyProfile || 'N/A')
    .replace('{pitchbook_keywords}', pitchbookKeywords || 'N/A')
    .replace('{sample_roles}', samplesText)
    .replace('{job_title}', jobTitle)
    .replace('{job_function}', jobFunction)
    .replace('{description_summary}', descSummary)
    .replace('{categories_list}', categoriesList);

  try {
    const raw = await callLLM({ provider, apiKey, model, prompt, maxOutputTokens: 4096 });
    let parsed = null;
    try {
      parsed = extractJSON(raw);
    } catch (e) {
      console.error(`Company ${companyId} (${companyName}): JSON parse failed`);
      companyRecord.category_error = String(e.message || e);
      return;
    }

    const ctc = parsed.climate_tech_category == null ? null : String(parsed.climate_tech_category).trim();
    const primary = parsed.primary_sector == null ? null : String(parsed.primary_sector).trim();
    const opp = parsed.opportunity_area == null ? null : String(parsed.opportunity_area).trim();
    const conf = parsed.category_confidence == null ? null : String(parsed.category_confidence).trim();

    companyRecord.climate_tech_category = ctc;
    companyRecord.primary_sector = primary;
    companyRecord.opportunity_area = opp;
    companyRecord.category_confidence = conf;
    delete companyRecord.category_error;

    if (dryRun) {
      console.log(`DRY ${companyId} -> ${ctc} (${conf})`);
    } else {
      console.info(`Company ${companyId} -> ${ctc} (${conf})`);
    }
  } catch (err) {
    console.error(`Company ${companyId} (${companyName}): call failed: ${String(err.message || err)}`);
    companyRecord.category_error = String(err.message || err);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');

  const jobs = readJSONSafe(JOBS_PATH, []);
  const companies = readJSONSafe(COMPANIES_PATH, null);
  if (!companies) { console.error('No data/companies.json found'); process.exit(1); }
  const taxonomy = readJSONSafe(TAX_PATH, []);

  const categoriesList = taxonomy.map(c => {
    const name = c['Tech Category Name'] || c['Tech category name'] || c.name || '';
    const area = c['Related Opportunity Area'] || c['Related opportunity area'] || '';
    const sector = c['Primary Sector'] || c['Primary sector'] || '';
    const desc = c.short_description || '';
    const kws = Array.isArray(c.keywords) && c.keywords.length ? c.keywords.join(', ') : '';
    return `${name} | ${area} | ${sector} | ${desc}${kws ? ` | example keywords: ${kws}` : ''}`;
  }).join('\n');

  // Build representative job map: company_id → best job (prefer enriched)
  const repJobByCompany = new Map();
  // Also build a small samples map: company_id → up to 5 {title, summary}
  const samplesByCompany = new Map();
  for (const job of jobs) {
    const cid = job.company_id;
    if (!cid) continue;
    const existing = repJobByCompany.get(cid);
    if (!existing || (job.last_enriched_at && !existing.last_enriched_at)) {
      repJobByCompany.set(cid, job);
    }
    const arr = samplesByCompany.get(cid) || [];
    if (arr.length < 5) {
      arr.push({ title: job.job_title_normalized || job.job_title_raw || '', summary: job.description_summary || '' });
      samplesByCompany.set(cid, arr);
    }
  }

  const { provider, apiKey, model } = config.resolveAgent('categorizer');
  const pool = createRateLimitedPool(3, 1000);

  const tasks = [];
  for (const company of companies) {
    // Skip if already categorized unless --force
    if (!force && company.climate_tech_category) continue;

    // Representative job: prefer a real job, otherwise synthesize from company description
    let repJob = repJobByCompany.get(company.id);
    if (!repJob) {
      const cp = company.company_profile || {};
      const desc = (cp.description && String(cp.description).trim()) || company.description || company.name || '';
      repJob = {
        job_title_normalized: '',
        job_function: '',
        description_summary: desc,
        climate_relevance_reason: '',
      };
    }

    const samples = (samplesByCompany.get(company.id) || []);
    tasks.push(async () => categorizeCompany(company, repJob, categoriesList, { provider, apiKey, model, dryRun }, samples));
  }

  if (tasks.length === 0) {
    console.log('No companies to categorize (use --force to re-run)');
    return;
  }

  console.log(`Categorizing ${tasks.length} companies with concurrency=3, delay=1000ms`);
  await pool(tasks);

  if (dryRun) {
    console.log('Dry-run complete. No files written.');
    return;
  }

  // Write companies (source of truth for category)
  try {
    writeJSONAtomic(COMPANIES_PATH, companies);
    console.log('Wrote updated data/companies.json');
  } catch (e) {
    console.error('Failed to write companies.json:', e.message || e);
    process.exit(1);
  }

  // Scrub category fields from jobs (they now live on companies)
  let scrubbed = 0;
  for (const job of jobs) {
    if ('climate_tech_category' in job || 'primary_sector' in job || 'opportunity_area' in job || 'category_confidence' in job || 'category_error' in job) {
      delete job.climate_tech_category;
      delete job.primary_sector;
      delete job.opportunity_area;
      delete job.category_confidence;
      delete job.category_error;
      scrubbed++;
    }
  }
  if (scrubbed > 0) {
    try {
      writeJSONAtomic(JOBS_PATH, jobs);
      console.log(`Scrubbed category fields from ${scrubbed} job(s) in data/jobs.json`);
    } catch (e) {
      console.error('Failed to write jobs.json:', e.message || e);
    }
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
