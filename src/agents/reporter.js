const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const SCRAPE_FILE = path.join(DATA_DIR, 'scrape_runs.json');
const COMPANIES_FILE = path.join(DATA_DIR, 'companies.json');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const SMALL_BODY_THRESHOLD = 5120; // bytes (5 KB)

async function safeReadJson(filePath) {
  try {
    const txt = await fs.readFile(filePath, 'utf8');
    return JSON.parse(txt);
  } catch (err) {
    return [];
  }
}

function addIfMissing(obj, key) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) obj[key] = 0;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

async function main() {
  const [scrapes, companies, jobs] = await Promise.all([
    safeReadJson(SCRAPE_FILE),
    safeReadJson(COMPANIES_FILE),
    safeReadJson(JOBS_FILE),
  ]);

  // --- Scrape summary ---
  const scrape = {
    total: 0,
    success: 0,
    error: 0,
    by_method: {
      greenhouse_api: 0,
      lever_api: 0,
      ashby_api: 0,
      workday_api: 0,
      direct_html: 0,
      playwright_html: 0,
    },
    by_status_code: {},
    small_body_count: 0,
    errors: [],
  };

  for (const r of Array.isArray(scrapes) ? scrapes : []) {
    scrape.total += 1;
    if (r && r.success) scrape.success += 1;
    else scrape.error += 1;

    const method = (r && r.method) || 'unknown';
    const m = String(method).toLowerCase();
    if (m.includes('greenhouse')) scrape.by_method.greenhouse_api += 1;
    else if (m.includes('lever')) scrape.by_method.lever_api += 1;
    else if (m.includes('ashby')) scrape.by_method.ashby_api += 1;
    else if (m.includes('workday')) scrape.by_method.workday_api += 1;
    else if (m.includes('playwright')) scrape.by_method.playwright_html += 1;
    else if (m.includes('direct') || m.includes('html')) scrape.by_method.direct_html += 1;
    else {
      // unknown method: add as-is
      addIfMissing(scrape.by_method, m);
      scrape.by_method[m] += 1;
    }

    const codeKey = r && r.status_code != null ? String(r.status_code) : 'unknown';
    addIfMissing(scrape.by_status_code, codeKey);
    scrape.by_status_code[codeKey] += 1;

    if (r && typeof r.byte_length === 'number' && r.byte_length < SMALL_BODY_THRESHOLD) {
      scrape.small_body_count += 1;
    }

    if (!r || !r.success) {
      const errText = (r && r.error) || (r && r.status_code ? `status_code:${r.status_code}` : 'unknown error');
      if (scrape.errors.length < 20) scrape.errors.push({ company_id: r && r.company_id, error: errText });
    }
  }

  // --- Discovery / companies ---
  const discovery = {
    total_companies: 0,
    reachable: 0,
    not_reachable: 0,
    reachable_pct: 0,
    by_method: {},
    by_ats_platform: {
      greenhouse: 0,
      lever: 0,
      ashby: 0,
      workday: 0,
      custom: 0,
      unknown: 0,
    },
  };

  for (const c of Array.isArray(companies) ? companies : []) {
    discovery.total_companies += 1;
    if (c && c.careers_page_reachable) discovery.reachable += 1;
    else discovery.not_reachable += 1;

    const method = (c && c.careers_page_discovery_method) || 'unknown';
    addIfMissing(discovery.by_method, method);
    discovery.by_method[method] += 1;

    const ats = (c && c.ats_platform) || null;
    const atsKey = ats ? String(ats).toLowerCase() : 'unknown';
    if (atsKey.includes('greenhouse')) discovery.by_ats_platform.greenhouse += 1;
    else if (atsKey.includes('lever')) discovery.by_ats_platform.lever += 1;
    else if (atsKey.includes('ashby')) discovery.by_ats_platform.ashby += 1;
    else if (atsKey.includes('workday')) discovery.by_ats_platform.workday += 1;
    else if (atsKey === 'unknown') discovery.by_ats_platform.unknown += 1;
    else discovery.by_ats_platform.custom += 1;
  }

  discovery.reachable_pct = discovery.total_companies === 0 ? 0 : round1((discovery.reachable / discovery.total_companies) * 100);

  // --- Extraction / jobs ---
  const total_jobs = Array.isArray(jobs) ? jobs.length : 0;
  const enriched = (Array.isArray(jobs) ? jobs.filter(j => j && j.last_enriched_at) : []).length;
  const enrichment_errors = (Array.isArray(jobs) ? jobs.filter(j => j && j.enrichment_error) : []).length;
  const missing_title = (Array.isArray(jobs) ? jobs.filter(j => !j || !j.job_title_raw) : []).length;
  const missing_description = (Array.isArray(jobs) ? jobs.filter(j => !j || !j.description_raw) : []).length;

  const extraction = {
    total_jobs,
    enriched,
    enrichment_errors,
    enrichment_error_rate_pct: total_jobs === 0 ? 0 : round1((enrichment_errors / total_jobs) * 100),
    missing_title,
    missing_description,
  };

  // --- Enrichment aggregates ---
  const climate_confirmed = (Array.isArray(jobs) ? jobs.filter(j => j && j.climate_relevance_confirmed) : []).length;
  const mbaScores = (Array.isArray(jobs) ? jobs.map(j => (j && typeof j.mba_relevance_score === 'number' ? j.mba_relevance_score : null)).filter(n => n !== null) : []);
  const mba_relevance_avg = mbaScores.length === 0 ? 0 : round1(mbaScores.reduce((a,b) => a + b, 0) / mbaScores.length);
  const enrichment = {
    climate_confirmed_pct: total_jobs === 0 ? 0 : round1((climate_confirmed / total_jobs) * 100),
    mba_relevance_avg,
    by_job_function: {},
    by_seniority: {},
  };

  for (const j of Array.isArray(jobs) ? jobs : []) {
    const fn = (j && j.job_function) || 'unknown';
    addIfMissing(enrichment.by_job_function, fn);
    enrichment.by_job_function[fn] += 1;

    const s = (j && j.seniority_level) || 'unknown';
    addIfMissing(enrichment.by_seniority, s);
    enrichment.by_seniority[s] += 1;
  }

  const out = {
    run_at: new Date().toISOString(),
    scrape,
    discovery,
    extraction,
    enrichment,
  };

  // ensure runs dir exists
  try {
    await fs.mkdir(RUNS_DIR, { recursive: true });
  } catch (err) {
    // ignore
  }

  const now = new Date();
  const Y = now.getUTCFullYear();
  const M = String(now.getUTCMonth() + 1).padStart(2, '0');
  const D = String(now.getUTCDate()).padStart(2, '0');
  const H = String(now.getUTCHours()).padStart(2, '0');
  const fileName = `${Y}-${M}-${D}-${H}.json`;
  const filePath = path.join(RUNS_DIR, fileName);
  const latestPath = path.join(RUNS_DIR, 'latest.json');

  await fs.writeFile(filePath, JSON.stringify(out, null, 2), 'utf8');
  await fs.writeFile(latestPath, JSON.stringify(out, null, 2), 'utf8');

  console.log(`Wrote run summary to ${filePath} and ${latestPath}`);
}

main().catch(err => {
  console.error('Reporter failed:', err);
  process.exit(1);
});
