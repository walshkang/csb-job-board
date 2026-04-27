const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const JOBS_PATH = path.join(REPO_ROOT, 'data', 'jobs.json');
const TAX_PATH = path.join(REPO_ROOT, 'data', 'climate-tech-map-industry-categories.json');
const COMPANIES_PATH = path.join(REPO_ROOT, 'data', 'companies.json');

const config = require('../config');
const { callLLM } = require('../llm-client');
const { extractJSON } = require('./enricher');
const BATCH_MAX = 10;

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

function normalizeKeyword(value) {
  if (value == null) return '';
  return String(value).toLowerCase().trim().replace(/\s+/g, ' ');
}

function getCategoryName(category) {
  return category['Tech Category Name'] || category['Tech category name'] || category.name || '';
}

function getOpportunityArea(category) {
  return category['Related Opportunity Area'] || category['Related opportunity area'] || null;
}

function getPrimarySector(category) {
  return category['Primary Sector'] || category['Primary sector'] || null;
}

function buildKeywordIndex(taxonomy) {
  const keywordToCategoryIds = new Map();
  const categoryById = new Map();

  for (const category of taxonomy) {
    const categoryId = getCategoryName(category);
    if (!categoryId) continue;

    categoryById.set(categoryId, category);
    const keywords = Array.isArray(category.keywords) ? category.keywords : [];
    for (const keyword of keywords) {
      const normalized = normalizeKeyword(keyword);
      if (!normalized) continue;
      if (!keywordToCategoryIds.has(normalized)) keywordToCategoryIds.set(normalized, new Set());
      keywordToCategoryIds.get(normalized).add(categoryId);
    }
  }

  return { keywordToCategoryIds, categoryById };
}

const TAXONOMY_AT_LOAD = readJSONSafe(TAX_PATH, []);
const MODULE_KEYWORD_INDEX = buildKeywordIndex(TAXONOMY_AT_LOAD);
const TAXONOMY_INDEX_CACHE = new WeakMap();

function getKeywordIndexForTaxonomy(taxonomy) {
  if (!Array.isArray(taxonomy)) return MODULE_KEYWORD_INDEX;
  if (taxonomy === TAXONOMY_AT_LOAD) return MODULE_KEYWORD_INDEX;
  const cached = TAXONOMY_INDEX_CACHE.get(taxonomy);
  if (cached) return cached;
  const built = buildKeywordIndex(taxonomy);
  TAXONOMY_INDEX_CACHE.set(taxonomy, built);
  return built;
}

function resolveByRule(companyRecord, keywordIndex = MODULE_KEYWORD_INDEX) {
  const pitchbookKeywords = companyRecord && companyRecord.company_profile && companyRecord.company_profile.keywords;
  if (!Array.isArray(pitchbookKeywords) || pitchbookKeywords.length === 0) return null;

  const scores = new Map();
  for (const keyword of pitchbookKeywords) {
    const normalized = normalizeKeyword(keyword);
    if (!normalized) continue;
    const matchedCategoryIds = keywordIndex.keywordToCategoryIds.get(normalized);
    if (!matchedCategoryIds) continue;
    for (const categoryId of matchedCategoryIds) {
      scores.set(categoryId, (scores.get(categoryId) || 0) + 1);
    }
  }

  if (scores.size === 0) return null;

  let topScore = -1;
  let topCategoryIds = [];
  for (const [categoryId, score] of scores.entries()) {
    if (score > topScore) {
      topScore = score;
      topCategoryIds = [categoryId];
    } else if (score === topScore) {
      topCategoryIds.push(categoryId);
    }
  }

  if (topCategoryIds.length !== 1) return null;
  const categoryId = topCategoryIds[0];
  const category = keywordIndex.categoryById.get(categoryId);
  if (!category) return null;
  return { category, confidence: 'high', resolver: 'rule' };
}

async function categorizeCompany(companyRecord, repJob, taxonomy, opts, samples) {
  const { provider, apiKey, model, dryRun } = opts;
  const companyId = companyRecord.id;
  const companyName = companyRecord.name || companyRecord.company || String(companyId);
  const jobTitle = repJob.job_title_normalized || repJob.job_title_raw || '';
  const jobFunction = repJob.job_function || '';
  const climateReason = repJob.climate_relevance_reason || '';

  const rawDesc = companyRecord.company_profile && companyRecord.company_profile.description;  const trimmedDesc = rawDesc != null ? String(rawDesc).trim() : '';
  const companyProfile = trimmedDesc || null;
  const pitchbookKeywords = (companyRecord.company_profile && companyRecord.company_profile.keywords) ? companyRecord.company_profile.keywords : null;

  if (!pitchbookKeywords) {
    console.info(`[categorize] ${companyId} skipped — no PitchBook keywords`);
    return;
  }

  const taxonomyList = Array.isArray(taxonomy) ? taxonomy : TAXONOMY_AT_LOAD;
  const keywordIndex = getKeywordIndexForTaxonomy(taxonomyList);
  const resolvedByRule = resolveByRule(companyRecord, keywordIndex);
  if (resolvedByRule) {
    const { category, confidence, resolver } = resolvedByRule;
    const ctc = getCategoryName(category);
    const primary = getPrimarySector(category);
    const opp = getOpportunityArea(category);
    companyRecord.climate_tech_category = ctc;
    companyRecord.primary_sector = primary;
    companyRecord.opportunity_area = opp;
    companyRecord.category_confidence = confidence;
    companyRecord.category_resolver = resolver;
    delete companyRecord.category_error;
    console.info(`[categorize] ${companyId} -> ${ctc} (${confidence}) [${resolver}]`);
    return;
  }

  const samplesText = (!samples || samples.length === 0) ? 'None' : samples.map(s => `- ${s.title}: ${s.summary || ''}`).join('\n');

  // Build company signal token set for keyword overlap scoring
  const signalStr = [
    companyName,
    companyProfile || '',
    Array.isArray(pitchbookKeywords) ? pitchbookKeywords.join(' ') : (pitchbookKeywords || ''),
    jobTitle,
    repJob.description_summary || '',
  ].join(' ').toLowerCase();
  const signalTokens = new Set(signalStr.split(/\W+/).filter(Boolean));

  // Score each category by keyword token overlap
  const scored = taxonomyList.map(c => {
    const name = getCategoryName(c);
    const kws = Array.isArray(c.keywords) ? c.keywords : [];
    let score = 0;
    for (const kw of kws) {
      for (const tok of kw.toLowerCase().split(/\W+/).filter(Boolean)) {
        if (signalTokens.has(tok)) score++;
      }
    }
    return { c, name, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const anyMatch = scored[0].score > 0;
  const shortlist = anyMatch ? scored.slice(0, 10) : scored;

  const topScores = scored.slice(0, 3).map(s => `${s.score}:${s.name}`).join(', ');
  console.info(`[categorize] ${companyId} shortlisted ${shortlist.length}/${taxonomyList.length} categories (top scores: ${topScores})`);

  const categoriesList = shortlist.map(({ c }) => {
    const name = getCategoryName(c);
    const area = getOpportunityArea(c) || '';
    const sector = getPrimarySector(c) || '';
    const desc = c.short_description || '';
    const kws = Array.isArray(c.keywords) && c.keywords.length ? c.keywords.join(', ') : '';
    return `- Category: ${name}\n  Opportunity Area: ${area}\n  Primary Sector: ${sector}\n  Description: ${desc}${kws ? `\n  Keywords: ${kws}` : ''}`;
  }).join('\n\n');

  const promptTemplate = fs.readFileSync(path.join(__dirname, '../prompts/categorizer.txt'), 'utf8');
  const prompt = promptTemplate
    .replace('{company_name}', companyName)
    .replace('{company_profile}', companyProfile || 'N/A')
    .replace('{pitchbook_keywords}', pitchbookKeywords || 'N/A')
    .replace('{sample_roles}', samplesText)
    .replace('{job_title}', jobTitle)
    .replace('{job_function}', jobFunction)
    .replace('{description_summary}', repJob.description_summary || 'N/A')
    .replace('{categories_list}', categoriesList);

  try {
    const raw = await callLLM({ provider, apiKey, model, prompt, maxOutputTokens: 4096, _agent: 'categorizer' });
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
    companyRecord.category_resolver = 'llm';
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

function asStringOrNull(value) {
  if (value == null) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

function asNumberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function batchCategorize(entries, taxonomy, llmConfig) {
  if (!Array.isArray(entries) || entries.length < 1) {
    throw new Error('batchCategorize requires at least one entry');
  }
  if (entries.length > BATCH_MAX) {
    throw new Error(`batchCategorize supports at most ${BATCH_MAX} entries`);
  }

  const results = new Map();
  const taxonomyList = Array.isArray(taxonomy) ? taxonomy : TAXONOMY_AT_LOAD;
  const categoriesList = taxonomyList.map((c) => {
    const name = getCategoryName(c);
    const area = getOpportunityArea(c) || '';
    const sector = getPrimarySector(c) || '';
    const desc = c.short_description || '';
    const kws = Array.isArray(c.keywords) && c.keywords.length ? c.keywords.join(', ') : '';
    return `- Category: ${name}\n  Opportunity Area: ${area}\n  Primary Sector: ${sector}\n  Description: ${desc}${kws ? `\n  Keywords: ${kws}` : ''}`;
  }).join('\n\n');

  const requestEntries = entries.map(({ company, rep }) => {
    const companyId = company.id;
    const companyName = company.name || company.company || String(companyId);
    const profileDesc = company && company.company_profile && company.company_profile.description;
    const companyProfile = profileDesc == null ? '' : String(profileDesc).trim();
    const pitchbookKeywords = company && company.company_profile && Array.isArray(company.company_profile.keywords)
      ? company.company_profile.keywords
      : [];
    const jobTitle = (rep && (rep.job_title_normalized || rep.job_title_raw)) || '';
    const jobFunction = (rep && rep.job_function) || '';
    return {
      company_id: companyId,
      company_name: companyName,
      company_profile: companyProfile || null,
      pitchbook_keywords: pitchbookKeywords,
      representative_job_title: jobTitle,
      representative_job_function: jobFunction,
    };
  });

  const promptTemplate = fs.readFileSync(path.join(__dirname, '../prompts/categorizer-batch.txt'), 'utf8');
  const prompt = promptTemplate
    .replace('{batch_entries}', JSON.stringify(requestEntries, null, 2))
    .replace('{categories_list}', categoriesList);

  const { provider, apiKey, model, dryRun } = llmConfig || {};
  if (dryRun) {
    for (const { company } of entries) {
      results.set(company.id, { error: 'dry_run' });
    }
    return results;
  }

  const raw = await callLLM({ provider, apiKey, model, prompt, maxOutputTokens: 4096, _agent: 'categorizer' });
  let parsed;
  try {
    parsed = extractJSON(raw);
  } catch (err) {
    throw new Error(`batchCategorize JSON parse failed: ${String(err.message || err)}`);
  }

  if (!parsed || !Array.isArray(parsed.results)) {
    throw new Error('batchCategorize response missing results array');
  }

  const byId = new Map();
  for (const row of parsed.results) {
    if (!row || typeof row !== 'object') continue;
    const companyId = asStringOrNull(row.company_id);
    if (!companyId) continue;
    byId.set(companyId, row);
  }

  for (const { company } of entries) {
    const row = byId.get(String(company.id));
    if (!row) {
      results.set(company.id, { error: 'missing_result' });
      continue;
    }
    const category = asStringOrNull(row.category);
    const confidence = asNumberOrNull(row.confidence);
    const reason = asStringOrNull(row.reason);
    const company_description = asStringOrNull(row.company_description);
    if (!category || confidence == null) {
      results.set(company.id, { error: 'malformed_result', reason: reason || null });
      continue;
    }
    results.set(company.id, { category, confidence, reason: reason || null, company_description });
  }

  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');

  const jobs = readJSONSafe(JOBS_PATH, []);
  const companies = readJSONSafe(COMPANIES_PATH, null);
  if (!companies) { console.error('No data/companies.json found'); process.exit(1); }
  const taxonomy = readJSONSafe(TAX_PATH, []);

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
    tasks.push(async () => categorizeCompany(company, repJob, taxonomy, { provider, apiKey, model, dryRun }, samples));
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

module.exports = {
  categorizeCompany,
  batchCategorize,
  BATCH_MAX,
  buildKeywordIndex,
  resolveByRule
};

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
