const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const enricher = require('./enricher');
const config = require('../config');
const { callGeminiText } = require('../gemini-text');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROMPT_PATH = path.join(REPO_ROOT, 'src', 'prompts', 'extraction.txt');
const OUT_JOBS = path.join(REPO_ROOT, 'data', 'jobs.json');
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts', 'html');
function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function writeJSONAtomic(p, obj) { const tmp = p + '.tmp'; ensureDir(path.dirname(p)); fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8'); fs.renameSync(tmp, p); }

async function callGeminiExtraction(prompt) {
  const apiKey = config.extraction.apiKey;
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
  return callGeminiText({
    apiKey,
    model: config.extraction.model,
    prompt,
    maxOutputTokens: 1200,
  });
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
function normalizeEmploymentType(v) { if (!v) return null; const s = String(v).toLowerCase().trim().replace(/[-\s]+/g, '_'); const allowed = new Set(['full_time','part_time','contract','intern']); return allowed.has(s) ? s : null; }

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
  const rawResponse = await callFn(prompt);
  const parsed = extractJSONFromText(rawResponse);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  // Normalize location arrays and resolve relative URLs at the raw level
  return items.map(it => ({
    ...it,
    url: it.url ? resolveUrl(String(it.url), baseUrl) : null,
    location: Array.isArray(it.location) ? it.location.map(String).join(' | ') : (it.location || null)
  }));
}

function normalizeExtractedItem(it, companyId, companyName, baseUrl) {
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
    job_title_raw: job_title_raw || null,
    source_url: source_url || null,
    location_raw: location_raw || null,
    employment_type: employment_type || null,
    description_raw: description_raw || null,
    description_hash,
    first_seen_at: now,
    last_seen_at: now
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

async function batchExtract({ companyFilter = null, dryRun = false, verbose = false }) {
  const companiesRaw = readJsonSafe(path.join(REPO_ROOT, 'data', 'companies.json')) || [];
  let companies;
  try {
    companies = config.validateCompanies(companiesRaw);
  } catch (err) {
    console.error('Company validation failed:', err.message);
    process.exit(1);
  }
  const extracted = [];
  const errors = [];
  const companiesProcessed = [];

  for (const company of companies) {
    if (companyFilter && company.id !== companyFilter) continue;
    const htmlPath = path.join(ARTIFACTS_DIR, `${company.id}.html`);
    const jsonPath = path.join(ARTIFACTS_DIR, `${company.id}.json`);
    let processed = false;
    if (fs.existsSync(jsonPath)) {
      try {
        const raw = readJsonSafe(jsonPath);
        // try detect platform shape
        let items = [];
        if (raw && raw.jobs && Array.isArray(raw.jobs)) items = mapGreenhouse(raw, company);
        else if (Array.isArray(raw)) items = mapLever(raw, company);
        else items = [];
        for (const it of items) extracted.push(normalizeExtractedItem(it, company.id, company.name, company.careers_page_url || company.domain || ''));
        processed = true;
      } catch (err) { errors.push({ company: company.id, err: String(err) }); }
    }
    if (!processed && fs.existsSync(htmlPath)) {
      try {
        const html = readFileSafe(htmlPath) || '';
        const baseUrl = company.careers_page_url || company.domain || '';
        const items = await runExtraction({ html, company: company.name || company.id, baseUrl, callFn: callGeminiExtraction, promptPath: PROMPT_PATH });
        if (Array.isArray(items) && items.length && items[0] && items[0].error === 'page_blocked') {
          errors.push({ company: company.id, err: items[0] });
        } else {
          for (const it of items) extracted.push(normalizeExtractedItem(it, company.id, company.name, baseUrl));
        }
        processed = true;
      } catch (err) { errors.push({ company: company.id, err: String(err) }); }
    }
    if (processed) companiesProcessed.push(company.id);
  }

  // Merge into single jobs.json
  const existing = readJsonSafe(OUT_JOBS) || [];
  const merged = mergeJobs(existing, extracted);
  if (!dryRun) writeJSONAtomic(OUT_JOBS, merged);

  return { companiesProcessed, extractedCount: extracted.length, written: dryRun ? 0 : merged.length, errors };
}

async function main() {
  const argv = process.argv.slice(2);
  const input = argv.find(a => a.startsWith('--input=')) ? argv.find(a => a.startsWith('--input=')).split('=')[1] : null;
  const companyArg = argv.find(a => a.startsWith('--company=')) ? argv.find(a => a.startsWith('--company=')).split('=')[1] : null;
  const dryRun = argv.includes('--dry-run');

  if (input) {
    // legacy single-file mode
    const baseUrl = argv.find(a => a.startsWith('--base-url=')) ? argv.find(a => a.startsWith('--base-url=')).split('=')[1] : null;
    if (!baseUrl) { console.error('--base-url required for --input mode'); process.exit(1); }
    const html = readFileSafe(input);
    if (html == null) { console.error('Failed to read input file', input); process.exit(1); }
    try {
      const items = await runExtraction({ html, company: companyArg || 'unknown', baseUrl, callFn: callGeminiExtraction, promptPath: PROMPT_PATH });
      console.log('Extracted', Array.isArray(items) ? items.length : 1, 'items');
    } catch (err) { console.error('Extraction failed:', String(err)); process.exit(1); }
    return;
  }

  const res = await batchExtract({ companyFilter: companyArg || null, dryRun });
  console.log('Extraction summary:');
  console.log('  companies processed:', res.companiesProcessed.length);
  console.log('  extracted items:', res.extractedCount);
  console.log('  jobs written:', res.written);
  if (res.errors.length) console.log('  errors:', res.errors.slice(0, 20));
}

module.exports = {
  extractJSONFromText,
  resolveUrl,
  normalizeEmploymentType,
  runExtraction,
  mapGreenhouse,
  mapLever,
  normalizeExtractedItem,
  mergeJobs,
  batchExtract
};

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
