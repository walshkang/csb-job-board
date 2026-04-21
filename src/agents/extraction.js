const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const enricher = require('./enricher');
const config = require('../config');
const { startRun, endRun } = require('../utils/run-log');
const { streamLLM } = require('../llm-client');
const { tryHtmlAdapters } = require('./extraction/html-adapters');
const { isXmlSitemapOrNonHtml, classifyShape } = require('./extraction/html-adapters/shared');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROMPT_PATH = path.join(REPO_ROOT, 'src', 'prompts', 'extraction.txt');
const OUT_JOBS = path.join(REPO_ROOT, 'data', 'jobs.json');
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts', 'html');
function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function writeJSONAtomic(p, obj) { const tmp = p + '.tmp'; ensureDir(path.dirname(p)); fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8'); fs.renameSync(tmp, p); }

async function callGeminiExtraction(prompt) {
  const opts = config.resolveAgent('extraction');
  if (!opts.apiKey) throw new Error('No LLM API key configured for extraction');
  return streamLLM({ ...opts, prompt, maxOutputTokens: 8192, _agent: 'extraction', onToken: chunk => process.stderr.write(chunk) });
}

function extractJSONFromText(text) {
  if (!text) throw new Error('Empty LLM response');
  let s = text.replace(/```(?:json)?/g, '\n').trim();
  // try array
  const firstArr = s.indexOf('[');
  const lastArr = s.lastIndexOf(']');
  if (firstArr !== -1 && lastArr !== -1 && lastArr > firstArr) {
    const candidate = s.slice(firstArr, lastArr + 1);
    try { return JSON.parse(candidate); } catch (e) {
      const fixed = candidate.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');
      try { return JSON.parse(fixed); } catch (e2) { /* fall through to object */ }
    }
  }
  // fallback: try object
  const firstObj = s.indexOf('{');
  const lastObj = s.lastIndexOf('}');
  if (firstObj !== -1 && lastObj !== -1 && lastObj > firstObj) {
    const candidate = s.slice(firstObj, lastObj + 1);
    try { return JSON.parse(candidate); } catch (e) {
      const fixed = candidate.replace(/,\s*}/g, '}');
      try { return JSON.parse(fixed); } catch (e2) { /* fall through */ }
    }
  }
  throw new Error('No JSON array or object found in LLM response');
}

function resolveUrl(urlStr, base) { if (!urlStr) return null; try { return new URL(urlStr, base).toString(); } catch (e) { return null; } }

function normalizeHtmlBaseUrl(u) {
  if (u == null || u === '') return '';
  const s = String(u).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}
function normalizeEmploymentType(v) { if (!v) return 'full_time'; const s = String(v).toLowerCase().trim().replace(/[-\s]+/g, '_'); const allowed = new Set(['full_time', 'part_time', 'contract', 'intern']); return allowed.has(s) ? s : 'full_time'; }

function isPlaceholder(job) {
  const title = (job.job_title_raw || '').toLowerCase();
  const desc = (job.description_raw || '').toLowerCase();
  if (title.includes('example') || title.includes('test job') || title.includes('sample job')) return true;
  if (desc.includes('this is a sample description') || desc.includes('truncate it at 500 characters')) return true;
  return false;
}

// Map ATS JSON artifacts
function mapGreenhouse(json, company) {
  if (!json || !Array.isArray(json.jobs) && !Array.isArray(json)) return [];
  const jobsArr = Array.isArray(json.jobs) ? json.jobs : json;
  return jobsArr.map(j => ({
    job_title: j.title || j.name || null,
    url: j.absolute_url || j.absoluteUrl || j.url || j.apply_url || j.job_url || null,
    location: j.location && (typeof j.location === 'object') ? (j.location.name || j.location.city || null) : j.location || null,
    employment_type: null,
    description: j.content || j.description || null
  }));
}

function mapLever(json, company) {
  const jobsArr = Array.isArray(json) ? json : (json.jobs || []);
  return jobsArr.map(j => ({
    job_title: j.text || j.title || j.name || null,
    url: j.hostedUrl || j.hostedUrl || j.hostedurl || j.hosted_url || j.hosted_url || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl || j.hostedUrl,
    location: j.categories && (j.categories.location || j.categories.locations) ? (Array.isArray(j.categories.location) ? j.categories.location.join(' | ') : j.categories.location) : null,
    employment_type: null,
    description: j.descriptionPlain || j.description || null
  }));
}

function mapAshby(json, company) {
  if (!json || !Array.isArray(json.jobs)) return [];
  return json.jobs.map(j => {
    const desc = j.descriptionHtml ? String(j.descriptionHtml).replace(/<[^>]+>/g, ' ').trim() : (j.descriptionPlain || null);
    const location = j.location && typeof j.location === 'object' ? (j.location.name || j.location.city || null) : j.location || null;
    const url = j.jobUrl || j.hostedUrl || j.url || null;
    return {
      job_title: j.title || j.name || null,
      url,
      location,
      employment_type: j.employmentType || j.employment_type || null,
      description: desc
    };
  });
}

function mapWorkday(json, company) {
  if (!json || !Array.isArray(json.jobPostings)) return [];
  return json.jobPostings.map(p => {
    const base = (company && (company.careers_page_url || company.domain)) || '';
    const url = p.externalPath ? resolveUrl(p.externalPath, base) : null;
    let description = null;
    if (Array.isArray(p.bulletFields) && p.bulletFields.length) description = p.bulletFields.join('\n');
    else if (p.description) description = p.description;
    else if (p.jobDescription) description = p.jobDescription;
    return {
      job_title: p.title || p.jobTitle || null,
      url,
      location: p.locationsText || p.location || null,
      employment_type: p.employmentType || p.employment_type || null,
      description: description || null
    };
  });
}

function mapWorkable(json, company) {
  if (!json || !Array.isArray(json.results)) return [];
  const slug = company && company.ats_slug ? company.ats_slug : null;
  return json.results.map(item => {
    const loc = item.location && typeof item.location === 'object'
      ? [item.location.city, item.location.region, item.location.country].filter(Boolean).join(', ')
      : (item.location || null);
    let url = item.url || null;
    if (!url && slug && item.shortcode) url = `https://apply.workable.com/${slug}/j/${item.shortcode}`;
    return {
      job_title: item.title || null,
      url,
      location: loc || null,
      employment_type: item.employment_type || null,
      description: item.description ? String(item.description).slice(0, 500) : null
    };
  });
}

function mapRecruitee(json, company) {
  const arr = Array.isArray(json) ? json : (json && Array.isArray(json.offers) ? json.offers : []);
  return arr.map(item => ({
    job_title: item.title || null,
    url: item.url || (item.careers_url || null),
    location: item.remote ? 'Remote' : [item.city, item.country_code].filter(Boolean).join(', ') || null,
    employment_type: item.kind || null,
    description: item.description ? String(item.description).replace(/<[^>]+>/g, '').slice(0, 500) : null
  }));
}

function mapTeamtailor(json, company) {
  const arr = Array.isArray(json) ? json : (json && Array.isArray(json.data) ? json.data : (Array.isArray(json && json.jobs) ? json.jobs : []));
  return arr.map(item => {
    const attrs = item.attributes || {};
    const title = item.title || attrs.title || null;
    let url = item.url || null;
    if (!url && item.links) url = item.links['careersite-job-url'] || null;
    const location = item.location || attrs.location || null;
    return {
      job_title: title,
      url,
      location: location || null,
      employment_type: null,
      description: null
    };
  });
}

const BLOCKER_PATTERNS = [/captcha/i, /please enable cookies/i, /access denied/i, /cookie consent/i, /set your browser to accept cookies/i, /you are being redirected/i];

// runExtraction: calls LLM (or callFn override) on raw HTML, returns array of raw items.
// Items have: { job_title, url, location, employment_type, description }
// On blocker detection returns [{ error: 'page_blocked', detail: '...' }]
async function runExtraction({ html, company, baseUrl, callFn = callGeminiExtraction, promptPath = PROMPT_PATH }) {
  for (const re of BLOCKER_PATTERNS) {
    if (re.test(html)) return [{ error: 'page_blocked', detail: `Matched blocker pattern: ${re}` }];
  }
  const MAX_HTML_CHARS = 12000;
  const htmlForPrompt = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  const promptTemplate = readFileSafe(promptPath) || 'Extract all job listings from this careers page HTML. Return a JSON array. {html}';
  const prompt = enricher.renderPrompt(promptTemplate, { company_name: company, base_url: baseUrl, html: htmlForPrompt });
  process.stderr.write('\n[extraction: ' + (company || 'unknown') + ']\n');
  const rawResponse = await callFn(prompt);
  const parsed = extractJSONFromText(rawResponse);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  // Normalize location arrays and resolve relative URLs at the raw level
  return items.map(it => {
    const resolved = it.url ? resolveUrl(String(it.url), baseUrl) : null;
    let validatedUrl = resolved;
    if (resolved) {
      try {
        const { pathname } = new URL(resolved);
        if (!htmlForPrompt.includes(pathname) && !htmlForPrompt.includes(resolved)) {
          validatedUrl = null;
        }
      } catch (e) {
        validatedUrl = null;
      }
    }
    return {
      ...it,
      url: validatedUrl,
      location: Array.isArray(it.location) ? it.location.map(String).join(' | ') : (it.location || null)
    };
  });
}

function normalizeExtractedItem(it, companyId, companyName, baseUrl, companyCategories = null) {
  const job_title_raw = it.job_title || it.job_title_raw || it.title || null;
  const source_url = it.url ? resolveUrl(it.url, baseUrl) : null;
  const location_raw = it.location || it.location_raw || null;
  const employment_type = normalizeEmploymentType(it.employment_type);
  const description_raw = it.description || it.description_raw || null;
  const description_hash = enricher.sha256(description_raw || '');
  const id = enricher.sha256((description_raw || '') + '|' + (source_url || ''));
  const now = new Date().toISOString();
  return {
    id,
    company_id: companyId,
    company_name: companyName || null,
    job_title_raw: job_title_raw || null,
    source_url: source_url || null,
    location_raw: location_raw || null,
    employment_type: employment_type || null,
    description_raw: description_raw || null,
    description_hash,
    first_seen_at: now,
    last_seen_at: now,
    ...(companyCategories ? companyCategories : {})
  };
}

// Merge extracted jobs with existing jobs.json
function mergeJobs(existingJobs, newJobs) {
  const now = new Date().toISOString();
  existingJobs = Array.isArray(existingJobs) ? existingJobs : [];
  newJobs = Array.isArray(newJobs) ? newJobs : [];

  // maps
  const bySourceAndHash = new Map();
  const bySource = new Map();

  for (const j of existingJobs) {
    const key = (j.source_url || '') + '||' + (j.description_hash || '');
    bySourceAndHash.set(key, j);
    if (j.source_url) {
      const prev = bySource.get(j.source_url);
      if (!prev) bySource.set(j.source_url, j);
      else {
        // keep earlier first_seen_at
        const pTime = Date.parse(prev.first_seen_at || prev.last_seen_at || 0) || 0;
        const jTime = Date.parse(j.first_seen_at || j.last_seen_at || 0) || 0;
        if (jTime < pTime) bySource.set(j.source_url, j);
      }
    }
  }

  for (const nj of newJobs) {
    const key = (nj.source_url || '') + '||' + (nj.description_hash || '');
    const existing = bySourceAndHash.get(key);
    if (existing) {
      // preserve first_seen_at
      existing.last_seen_at = now;
      delete existing.removed_at;
      // update fields from nj if missing
      existing.job_title_raw = existing.job_title_raw || nj.job_title_raw;
      existing.location_raw = existing.location_raw || nj.location_raw;
      existing.employment_type = existing.employment_type || nj.employment_type;
      existing.description_raw = existing.description_raw || nj.description_raw;
    } else if (nj.source_url && bySource.has(nj.source_url)) {
      // collision on source_url only: pick the one with earlier first_seen_at
      const prev = bySource.get(nj.source_url);
      const prevTime = Date.parse(prev.first_seen_at || prev.last_seen_at || 0) || 0;
      const newTime = Date.parse(nj.first_seen_at || nj.last_seen_at || 0) || 0;
      if (newTime < prevTime) {
        // prefer new: replace mapping
        bySource.set(nj.source_url, nj);
        bySourceAndHash.set(key, nj);
      } else {
        // keep prev; but ensure prev.last_seen_at updated
        prev.last_seen_at = now;
        delete prev.removed_at;
      }
    } else {
      // new unique
      bySourceAndHash.set(key, nj);
      if (nj.source_url) bySource.set(nj.source_url, nj);
    }
  }

  // Final dedup: if multiple entries share same source_url, keep earliest first_seen_at
  const finalBySource = new Map();
  for (const v of bySourceAndHash.values()) {
    const s = v.source_url || '';
    if (!s) continue; // skip jobs without source_url for source-based dedup
    const prev = finalBySource.get(s);
    if (!prev) finalBySource.set(s, v);
    else {
      const pTime = Date.parse(prev.first_seen_at || prev.last_seen_at || 0) || 0;
      const vTime = Date.parse(v.first_seen_at || v.last_seen_at || 0) || 0;
      if (vTime < pTime) finalBySource.set(s, v);
    }
  }

  // include jobs without source_url too (unique by id)
  const withoutSource = [];
  for (const v of bySourceAndHash.values()) if (!v.source_url) withoutSource.push(v);

  const merged = [...finalBySource.values(), ...withoutSource];
  // ensure consistent timestamps
  for (const j of merged) {
    if (!j.first_seen_at) j.first_seen_at = now;
    if (!j.last_seen_at) j.last_seen_at = now;
  }

  return merged;
}

function mapRawArtifactItems(raw, company) {
  const platform = (company && company.ats_platform ? String(company.ats_platform).toLowerCase() : '');
  if (platform === 'workable' || (raw && Array.isArray(raw.results))) return mapWorkable(raw, company);
  if (platform === 'teamtailor' || (raw && Array.isArray(raw.data))) return mapTeamtailor(raw, company);
  if (platform === 'recruitee') return mapRecruitee(raw, company);
  if (raw && Array.isArray(raw.jobs) && raw.jobs.length > 0 && raw.jobs[0] && raw.jobs[0].jobUrl !== undefined) return mapAshby(raw, company);
  if (raw && Array.isArray(raw.jobPostings)) return mapWorkday(raw, company);
  if (raw && Array.isArray(raw.jobs)) return mapGreenhouse(raw, company);
  if (Array.isArray(raw)) {
    if (raw.length > 0 && raw[0] && (raw[0].kind !== undefined || raw[0].country_code !== undefined || raw[0].remote !== undefined)) {
      return mapRecruitee(raw, company);
    }
    return mapLever(raw, company);
  }
  return [];
}

function descriptionHashesBySourceUrlFromArtifact(company, opts = {}) {
  const artifactsDir = opts.artifactsDir || ARTIFACTS_DIR;
  const htmlPath = path.join(artifactsDir, `${company.id}.html`);
  const jsonPath = path.join(artifactsDir, `${company.id}.json`);
  const baseUrl = normalizeHtmlBaseUrl(company.careers_page_url || company.domain || '');
  const bySource = new Map();

  let items = null;
  if (fs.existsSync(jsonPath)) {
    const raw = readJsonSafe(jsonPath);
    items = mapRawArtifactItems(raw, company);
  } else if (fs.existsSync(htmlPath)) {
    const html = readFileSafe(htmlPath) || '';
    if (isXmlSitemapOrNonHtml(html)) return null;
    const adapted = tryHtmlAdapters(html, baseUrl);
    if (!adapted || !adapted.items || adapted.items.length === 0) return null;
    items = adapted.items;
  } else {
    return null;
  }

  if (!Array.isArray(items)) return null;
  for (const it of items) {
    const normalized = normalizeExtractedItem(it, company.id, company.name, baseUrl, null);
    if (!normalized.source_url) continue;
    bySource.set(normalized.source_url, normalized.description_hash);
  }
  return bySource;
}

async function extractCompanyJobs(company, opts = {}) {
  const {
    verbose = false,
    artifactsDir = ARTIFACTS_DIR,
    promptPath = PROMPT_PATH,
    callFn = callGeminiExtraction,
    companyCategories = null,
    extractStats = null
  } = opts;

  const htmlPath = path.join(artifactsDir, `${company.id}.html`);
  const jsonPath = path.join(artifactsDir, `${company.id}.json`);
  const extracted = [];
  const errors = [];
  let processed = false;
  /** @type {'json'|'adapter'|'llm'|'xml_or_sitemap'|'adapter_empty'|null} */
  let html_extract_path = null;
  let html_adapter_name = null;
  let extract_failure_reason = null;

  if (fs.existsSync(jsonPath)) {
    try {
      const raw = readJsonSafe(jsonPath);
      const platform = (company && company.ats_platform ? String(company.ats_platform).toLowerCase() : '');
      let items = [];
      let mapperName = 'unknown';
      if (platform === 'workable' || (raw && Array.isArray(raw.results))) {
        items = mapWorkable(raw, company); mapperName = 'workable';
      } else if (platform === 'teamtailor' || (raw && Array.isArray(raw.data))) {
        items = mapTeamtailor(raw, company); mapperName = 'teamtailor';
      } else if (platform === 'recruitee') {
        items = mapRecruitee(raw, company); mapperName = 'recruitee';
      } else if (raw && Array.isArray(raw.jobs) && raw.jobs.length > 0 && raw.jobs[0] && raw.jobs[0].jobUrl !== undefined) {
        items = mapAshby(raw, company); mapperName = 'ashby';
      } else if (raw && Array.isArray(raw.jobPostings)) {
        items = mapWorkday(raw, company); mapperName = 'workday';
      } else if (raw && Array.isArray(raw.jobs)) {
        items = mapGreenhouse(raw, company); mapperName = 'greenhouse';
      } else if (Array.isArray(raw)) {
        // Recruitee returns a bare array too; distinguish by field signature
        if (raw.length > 0 && raw[0] && (raw[0].kind !== undefined || raw[0].country_code !== undefined || raw[0].remote !== undefined)) {
          items = mapRecruitee(raw, company); mapperName = 'recruitee';
        } else {
          items = mapLever(raw, company); mapperName = 'lever';
        }
      }
      if (verbose) console.log(`[${company.id}] json/${mapperName} → ${items.length} job(s)`);
      html_extract_path = 'json';
      for (const it of items) {
        const normalized = normalizeExtractedItem(it, company.id, company.name, company.careers_page_url || company.domain || '', companyCategories);
        if (isPlaceholder(normalized)) continue;
        extracted.push(normalized);
      }
      processed = true;
    } catch (err) {
      if (verbose) console.error(`[${company.id}] error: ${err}`);
      errors.push({ company: company.id, err: String(err) });
    }
  }
  if (!processed && fs.existsSync(htmlPath)) {
    try {
      const html = readFileSafe(htmlPath) || '';
      const baseUrl = normalizeHtmlBaseUrl(company.careers_page_url || company.domain || '');

      if (isXmlSitemapOrNonHtml(html)) {
        errors.push({ company: company.id, err: 'artifact_not_html_xml_or_sitemap' });
        html_extract_path = 'xml_or_sitemap';
        processed = true;
      } else {
        let items = null;
        const adapted = tryHtmlAdapters(html, baseUrl);
        if (adapted && adapted.items.length) {
          items = adapted.items;
          html_extract_path = 'adapter';
          html_adapter_name = adapted.adapterName || null;
          if (extractStats) extractStats.htmlAdapterCompanies += 1;
          if (verbose) console.log(`[${company.id}] html/adapter:${adapted.adapterName} → ${items.length} item(s)`);
        } else {
          const shape = classifyShape(html);
          const llmEnabled = process.env.EXTRACTION_LLM_FALLBACK === '1';
          if (shape === 'other' && llmEnabled) {
            items = await runExtraction({ html, company: company.name || company.id, baseUrl, callFn, promptPath });
            html_extract_path = 'llm';
            if (extractStats) extractStats.htmlLlmCompanies += 1;
            if (verbose) console.log(`[${company.id}] html/llm → ${items.length} item(s)${items[0] && items[0].error ? ` [${items[0].error}]` : ''}`);
          } else {
            html_extract_path = 'adapter_empty';
            extract_failure_reason = 'adapter_empty';
            if (verbose) console.log(`[${company.id}] html/adapter_empty (shape=${shape}, llm_fallback=${llmEnabled ? 'on' : 'off'})`);
          }
        }

        if (Array.isArray(items) && items.length && items[0] && items[0].error === 'page_blocked') {
          errors.push({ company: company.id, err: items[0] });
        } else if (items) {
          for (const it of items) {
            const normalized = normalizeExtractedItem(it, company.id, company.name, baseUrl, companyCategories);
            if (isPlaceholder(normalized)) continue;
            extracted.push(normalized);
          }
        }
      }
      processed = true;
    } catch (err) {
      if (verbose) console.error(`[${company.id}] error: ${err}`);
      errors.push({ company: company.id, err: String(err) });
    }
  }

  return {
    companyId: company.id,
    processed,
    jobs: extracted,
    errors,
    html_extract_path,
    html_adapter_name,
    extract_failure_reason
  };
}

async function batchExtract({ companyFilter = null, dryRun = false, verbose = false }) {
  const runStart = new Date().toISOString();
  const companiesRaw = readJsonSafe(path.join(REPO_ROOT, 'data', 'companies.json')) || [];
  let companies;
  try {
    companies = config.validateCompanies(companiesRaw);
  } catch (err) {
    console.error('Company validation failed:', err.message);
    process.exit(1);
  }
  const categoryByCompanyId = new Map();
  for (const c of companies) {
    if (c.climate_tech_category) {
      categoryByCompanyId.set(c.id, {
        climate_tech_category: c.climate_tech_category || null,
        primary_sector: c.primary_sector || null,
        opportunity_area: c.opportunity_area || null,
        category_confidence: c.category_confidence || null,
      });
    }
  }
  const extracted = [];
  const errors = [];
  const companiesProcessed = [];
  const extractStats = { htmlAdapterCompanies: 0, htmlLlmCompanies: 0 };

  for (const company of companies) {
    if (companyFilter && company.id !== companyFilter) continue;
    const result = await extractCompanyJobs(company, {
      verbose,
      artifactsDir: ARTIFACTS_DIR,
      promptPath: PROMPT_PATH,
      callFn: callGeminiExtraction,
      companyCategories: categoryByCompanyId.get(company.id) || null,
      extractStats
    });
    extracted.push(...result.jobs);
    errors.push(...result.errors);
    if (result.processed) companiesProcessed.push(company.id);
  }

  // Merge into single jobs.json
  const existing = readJsonSafe(OUT_JOBS) || [];
  const merged = mergeJobs(existing, extracted);

  // Mark jobs as removed if their company was processed but they weren't seen this run
  const processedSet = new Set(companiesProcessed);
  let removedCount = 0;
  for (const job of merged) {
    if (!processedSet.has(job.company_id)) continue;
    if (job.removed_at) continue;
    if (job.last_seen_at < runStart) {
      job.removed_at = runStart;
      const first = Date.parse(job.first_seen_at || 0);
      const removed = Date.parse(job.removed_at || 0);
      if (!Number.isNaN(first) && !Number.isNaN(removed) && removed >= first) {
        job.days_live = Math.floor((removed - first) / 86400000);
      }
      removedCount++;
    }
  }

  if (!dryRun) writeJSONAtomic(OUT_JOBS, merged);

  if (verbose) console.log(`Extraction done: ${companiesProcessed.length} companies, ${extracted.length} jobs, ${removedCount} removed, ${errors.length} errors`);
  return {
    companiesProcessed,
    extractedCount: extracted.length,
    removedCount,
    written: dryRun ? 0 : merged.length,
    errors,
    extractStats
  };
}

async function main() {
  const run = startRun('extraction');
  const argv = process.argv.slice(2);
  const input = argv.find(a => a.startsWith('--input=')) ? argv.find(a => a.startsWith('--input=')).split('=')[1] : null;
  const companyArg = argv.find(a => a.startsWith('--company=')) ? argv.find(a => a.startsWith('--company=')).split('=')[1] : null;
  const dryRun = argv.includes('--dry-run');
  const verbose = argv.includes('--verbose');

  if (input) {
    // legacy single-file mode
    const rawBase = argv.find(a => a.startsWith('--base-url=')) ? argv.find(a => a.startsWith('--base-url=')).split('=')[1] : null;
    if (!rawBase) { console.error('--base-url required for --input mode'); process.exit(1); }
    const baseUrl = normalizeHtmlBaseUrl(rawBase);
    const html = readFileSafe(input);
    if (html == null) { console.error('Failed to read input file', input); process.exit(1); }
    try {
      if (isXmlSitemapOrNonHtml(html)) {
        console.error('Input looks like XML sitemap, not HTML; skipping extraction');
        process.exit(1);
      }
      const adapted = tryHtmlAdapters(html, baseUrl);
      const items = adapted && adapted.items.length
        ? adapted.items
        : await runExtraction({ html, company: companyArg || 'unknown', baseUrl, callFn: callGeminiExtraction, promptPath: PROMPT_PATH });
      if (adapted && adapted.items.length) console.log('Source: html adapter', adapted.adapterName);
      console.log('Extracted', Array.isArray(items) ? items.length : 1, 'items');
    } catch (err) { console.error('Extraction failed:', String(err)); process.exit(1); }
    return;
  }

  const res = await batchExtract({ companyFilter: companyArg || null, dryRun, verbose });
  console.log('Extraction summary:');
  console.log('  companies processed:', res.companiesProcessed.length);
  console.log('  extracted items:', res.extractedCount);
  console.log('  departed jobs:', res.departedCount);
  console.log('  jobs written:', res.written);
  console.log('  HTML adapter companies:', res.extractStats.htmlAdapterCompanies);
  console.log('  HTML LLM companies:', res.extractStats.htmlLlmCompanies);
  if (res.errors.length) console.log('  errors:', res.errors.slice(0, 20));
  await endRun(run, { processed: res.companiesProcessed.length, extracted: res.extractedCount, errors: res.errors.length });
}

module.exports = {
  extractJSONFromText,
  resolveUrl,
  normalizeEmploymentType,
  tryHtmlAdapters,
  runExtraction,
  mapGreenhouse,
  mapLever,
  mapAshby,
  mapWorkday,
  mapWorkable,
  mapRecruitee,
  mapTeamtailor,
  normalizeExtractedItem,
  mergeJobs,
  descriptionHashesBySourceUrlFromArtifact,
  extractCompanyJobs,
  batchExtract
};

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
