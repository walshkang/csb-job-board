#!/usr/bin/env node
/* Scraper Agent - src/agents/scraper.js
   - Reads companies list (default: data/companies.json)
   - For companies with careers_page_reachable === true, fetch raw HTML or API JSON
   - ATS adapters: greenhouse, lever; fallback: direct HTML
   - Concurrency: 3
   - Retries: up to 2 retries on 429/5xx with exponential backoff
   - Timeout: 15s per request
   - Rotate between multiple User-Agent strings
   - Writes artifacts to artifacts/html/{company_id}.html or .json
   - Appends run entries to data/scrape_runs.json
*/

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('../config');
const { startRun, endRun } = require('../utils/run-log');
const { fetchRenderedHtml, closeBrowser } = require('../utils/browser');

const SCRAPER_BLOCKER_PATTERNS = [/captcha/i, /please enable cookies/i, /access denied/i, /cookie consent/i, /you are being redirected/i];

// Prefer global fetch, fallback to node-fetch if not available
let fetchImpl = global.fetch;
try {
  if (!fetchImpl) {
    // eslint-disable-next-line global-require
    fetchImpl = require('node-fetch');
  }
} catch (e) {
  // will throw at runtime if fetch not available
}

const USER_AGENTS = [
  // 6 realistic UA strings
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
];

const DEFAULT_COMPANIES_PATH = path.resolve(__dirname, '../../data/companies.json');
const ARTIFACTS_DIR = path.resolve(__dirname, '../../artifacts/html');
const SCRAPE_RUNS_PATH = path.resolve(__dirname, '../../data/scrape_runs.json');

const TIMEOUT_MS = 15000;
const MAX_RETRIES = 2; // up to 2 retries (total attempts = 1 + MAX_RETRIES)

// Provider concurrency limits
const PROVIDER_LIMITS = {
  greenhouse_api: 5,
  lever_api: 5,
  ashby_api: 5,
  workday_api: 2,
  direct_html: 3
};

// Minimal semaphore implementation per provider
const providerSemaphores = {};
for (const [k, limit] of Object.entries(PROVIDER_LIMITS)) {
  providerSemaphores[k] = { count: 0, limit, queue: [] };
}
function acquireProvider(provider) {
  if (!providerSemaphores[provider]) providerSemaphores[provider] = { count: 0, limit: 3, queue: [] };
  const sem = providerSemaphores[provider];
  return new Promise(resolve => {
    if (sem.count < sem.limit) {
      sem.count += 1;
      resolve();
    } else {
      sem.queue.push(resolve);
    }
  });
}
function releaseProvider(provider) {
  if (!providerSemaphores[provider]) providerSemaphores[provider] = { count: 0, limit: 3, queue: [] };
  const sem = providerSemaphores[provider];
  sem.count = Math.max(0, sem.count - 1);
  if (sem.queue.length > 0) {
    const next = sem.queue.shift();
    sem.count += 1;
    next();
  }
}

function chooseUserAgent(i) {
  return USER_AGENTS[i % USER_AGENTS.length];
}

function extractGreenhouseToken(url) {
  try {
    const u = new URL(url);
    // Match boards.greenhouse.io/<token>
    if (/boards\.greenhouse\.io$/.test(u.hostname) || /boards\.greenhouse\.io/.test(url)) {
      const m = u.pathname.match(/^\/([^\/]+)/);
      if (m && m[1]) return m[1];
    }
    // sometimes: https://company.greenhouse.io/ -> token may be company (subdomain)
    const hostParts = u.hostname.split('.');
    if (hostParts.length >= 3 && hostParts[1] === 'greenhouse' && hostParts[2] === 'io') {
      return hostParts[0];
    }
  } catch (e) {
    return null;
  }
  return null;
}

function extractLeverSlug(url) {
  try {
    const u = new URL(url);
    // Only treat as Lever when hostname indicates lever.co
    const host = u.hostname.toLowerCase();
    if (host.endsWith('lever.co') || host.endsWith('jobs.lever.co') || host.includes('lever.co')) {
      // common pattern: jobs.lever.co/{company} or /postings/{company}
      const m = u.pathname.match(/^\/(?:postings\/)?([^\/]+)(?:\/|$)/);
      if (m && m[1]) return m[1];
      const hostParts = host.split('.');
      if (hostParts[0] && hostParts[0] !== 'www') return hostParts[0];
    }
  } catch (e) {
    return null;
  }
  return null;
}

function extractAshbySlug(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes('ashbyhq.com') || host.includes('jobs.ashbyhq.com')) {
      // Try query param first
      const qp = u.searchParams.get('organizationHostedJobsPageName');
      if (qp) return qp;
      // Otherwise use last path segment
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
      // fallback to hostname subdomain
      const hostParts = host.split('.');
      if (hostParts.length >= 3) return hostParts[0];
    }
  } catch (e) {
    return null;
  }
  return null;
}

function extractWorkdayTenant(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes('myworkdayjobs.com') || host.includes('workday.com') || (host.includes('wd') && host.includes('workday'))) {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length) return { baseUrl: `${u.protocol}//${u.hostname}`, tenant: parts[0] };
    }
  } catch (e) {
    return null;
  }
  return null;
}

async function fetchWithRetries(url, opts = {}, attempt = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...opts, signal: controller.signal, redirect: 'follow' });
    return res;
  } catch (err) {
    if (attempt < MAX_RETRIES && (err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT')) {
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(r => setTimeout(r, delay));
      return fetchWithRetries(url, opts, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function attemptFetchWithRetries(url, opts = {}, attempt = 0) {
  try {
    const res = await fetchWithRetries(url, opts, attempt);
    if (!res) throw new Error('No response');
    // Retry on 429 or 5xx
    if ((res.status === 429 || (res.status >= 500 && res.status < 600)) && attempt < MAX_RETRIES) {
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(r => setTimeout(r, delay));
      return attemptFetchWithRetries(url, opts, attempt + 1);
    }
    return res;
  } catch (err) {
    // bubble up
    throw err;
  }
}

async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (e) {
    console.error('[scraper] Failed to create directory', dir, ':', e.message);
    throw e;
  }
}

async function loadCompanies(companiesPath) {
  try {
    const raw = await fsp.readFile(companiesPath, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('companies.json must be an array');
    const validated = config.validateCompanies(arr);
    return validated.filter(c => c && c.careers_page_reachable === true);
  } catch (e) {
    throw new Error(`Failed to read companies file at ${companiesPath}: ${e.message}`);
  }
}

// Serialize all scrape_runs writes to avoid concurrent read-modify-write races
let scrapeRunsQueue = Promise.resolve();
function appendScrapeRun(entry) {
  scrapeRunsQueue = scrapeRunsQueue.then(async () => {
    let arr = [];
    try {
      const raw = await fsp.readFile(SCRAPE_RUNS_PATH, 'utf8');
      arr = JSON.parse(raw);
      if (!Array.isArray(arr)) arr = [];
    } catch (e) {
      arr = [];
    }
    arr.push(entry);
    await fsp.mkdir(path.dirname(SCRAPE_RUNS_PATH), { recursive: true });
    const tmp = SCRAPE_RUNS_PATH + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(arr, null, 2), 'utf8');
    await fsp.rename(tmp, SCRAPE_RUNS_PATH);
  });
  return scrapeRunsQueue;
}

async function saveArtifact(companyId, method, content, isJson = false) {
  await ensureDir(ARTIFACTS_DIR);
  const ext = isJson ? 'json' : 'html';
  const p = path.join(ARTIFACTS_DIR, `${companyId}.${ext}`);
  await fsp.writeFile(p, content, 'utf8');
  return p;
}

async function scrapeCompany(company, opts = {}) {
  const { index = 0, verbose = false } = opts;
  const companyId = company.id || company.company_id || company.name || `company-${index}`;
  const careersUrl = company.careers_page_url || company.careers_url || company.url;
  const result = {
    company_id: companyId,
    scraped_at: new Date().toISOString(),
    status_code: null,
    content_type: null,
    byte_length: 0,
    method: null,
    success: false,
    error: null,
    status: null
  };

  if (!careersUrl) {
    result.error = 'No careers_page_url';
    result.success = false;
    result.status = 'error';
    await appendScrapeRun(result);
    return result;
  }

  // detect ATS
  const ghToken = extractGreenhouseToken(careersUrl);
  const leverSlug = extractLeverSlug(careersUrl);
  const ashbySlug = extractAshbySlug(careersUrl);
  const workdayInfo = extractWorkdayTenant(careersUrl); // { baseUrl, tenant } or null

  // choose provider key (priority: configured ats_platform, greenhouse, lever, ashby, workday, html)
  let providerKey = 'direct_html';
  if (company && company.ats_platform && company.ats_platform !== 'custom') {
    const p = String(company.ats_platform).toLowerCase();
    if (p === 'greenhouse') providerKey = 'greenhouse_api';
    else if (p === 'lever') providerKey = 'lever_api';
    else if (p === 'ashby') providerKey = 'ashby_api';
    else if (p === 'workday') providerKey = 'workday_api';
  } else {
    if (ghToken) providerKey = 'greenhouse_api';
    else if (leverSlug) providerKey = 'lever_api';
    else if (ashbySlug) providerKey = 'ashby_api';
    else if (workdayInfo && workdayInfo.tenant) providerKey = 'workday_api';
  }
  if (verbose) console.log(`[${companyId}] provider: ${providerKey} | url: ${careersUrl}`);

  await acquireProvider(providerKey);
  try {
    const ua = chooseUserAgent(index);

    if (providerKey === 'greenhouse_api') {
      const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${ghToken}/jobs?content=true`;
      result.method = 'greenhouse_api';
      const res = await attemptFetchWithRetries(apiUrl, { headers: { 'User-Agent': ua, Accept: 'application/json' } });
      result.status_code = res.status;
      result.content_type = res.headers.get('content-type') || null;
      const body = await res.text();
      result.byte_length = Buffer.byteLength(body, 'utf8');
      if (result.byte_length < 1024) console.warn(`[warn] greenhouse response small for ${companyId} (${result.byte_length} bytes)`);
      await saveArtifact(companyId, 'greenhouse_api', body, true);
      result.success = res.ok;
      result.status = result.success ? 'success' : 'error';
      if (verbose) console.log(`[${companyId}] ${result.method} → ${result.status_code} (${result.byte_length}b)`);
      await appendScrapeRun(result);
      return result;
    }

    if (providerKey === 'lever_api') {
      const apiUrl = `https://api.lever.co/v0/postings/${leverSlug}?mode=json`;
      result.method = 'lever_api';
      const res = await attemptFetchWithRetries(apiUrl, { headers: { 'User-Agent': ua, Accept: 'application/json' } });
      result.status_code = res.status;
      result.content_type = res.headers.get('content-type') || null;
      const body = await res.text();
      result.byte_length = Buffer.byteLength(body, 'utf8');
      if (result.byte_length < 1024) console.warn(`[warn] lever response small for ${companyId} (${result.byte_length} bytes)`);
      await saveArtifact(companyId, 'lever_api', body, true);
      result.success = res.ok;
      result.status = result.success ? 'success' : 'error';
      if (verbose) console.log(`[${companyId}] ${result.method} → ${result.status_code} (${result.byte_length}b)`);
      await appendScrapeRun(result);
      return result;
    }

    if (providerKey === 'ashby_api') {
      // Ashby: POST to their job-board endpoint with organizationHostedJobsPageName slug
      const apiUrl = `https://jobs.ashbyhq.com/api/non-user-facing/job-board/jobs?organizationHostedJobsPageName=${encodeURIComponent(ashbySlug)}`;
      result.method = 'ashby_api';
      const res = await attemptFetchWithRetries(apiUrl, { method: 'POST', headers: { 'User-Agent': ua, 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}' });
      result.status_code = res.status;
      result.content_type = res.headers.get('content-type') || null;
      const body = await res.text();
      result.byte_length = Buffer.byteLength(body, 'utf8');
      if (result.byte_length < 256) console.warn(`[warn] ashby response small for ${companyId} (${result.byte_length} bytes)`);
      await saveArtifact(companyId, 'ashby_api', body, true);
      result.success = res.ok;
      result.status = result.success ? 'success' : 'error';
      if (verbose) console.log(`[${companyId}] ${result.method} → ${result.status_code} (${result.byte_length}b)`);
      await appendScrapeRun(result);
      return result;
    }

    if (providerKey === 'workday_api') {
      // Workday: construct jobs endpoint
      if (!workdayInfo || !workdayInfo.tenant) {
        console.warn(`[warn] Could not parse Workday tenant for ${companyId} (${careersUrl}), falling back to HTML`);
      } else {
        const apiUrl = `${workdayInfo.baseUrl}/wday/cxs/${workdayInfo.tenant}/jobs`;
        result.method = 'workday_api';
        const res = await attemptFetchWithRetries(apiUrl, { headers: { 'User-Agent': ua, Accept: 'application/json' } });
        result.status_code = res.status;
        result.content_type = res.headers.get('content-type') || null;
        const body = await res.text();
        result.byte_length = Buffer.byteLength(body, 'utf8');
        if (result.byte_length < 256) console.warn(`[warn] workday response small for ${companyId} (${result.byte_length} bytes)`);
        await saveArtifact(companyId, 'workday_api', body, true);
        result.success = res.ok;
        result.status = result.success ? 'success' : 'error';
        if (verbose) console.log(`[${companyId}] ${result.method} → ${result.status_code} (${result.byte_length}b)`);
        await appendScrapeRun(result);
        return result;
      }
      // fall through to HTML fetch if parsing failed
    }

    // fallback: direct HTML fetch
    result.method = 'direct_html';
    const res = await attemptFetchWithRetries(careersUrl, { headers: { 'User-Agent': ua, Accept: 'text/html' } });
    result.status_code = res.status;
    result.content_type = res.headers.get('content-type') || null;
    let body = await res.text();
    result.byte_length = Buffer.byteLength(body, 'utf8');
    if (result.byte_length < 1024) console.warn(`[warn] HTML response small for ${companyId} (${result.byte_length} bytes). Possible block or empty page.`);
    await saveArtifact(companyId, 'direct_html', body, false);
    result.success = res.ok;

    const isSpаShell = result.byte_length > 5120 && (body.match(/<a\s[^>]*href/gi) || []).length < 4;
    if (verbose) console.log(`[${companyId}] direct_html → ${result.status_code} (${result.byte_length}b)${isSpаShell ? ' [SPA shell detected]' : ''}`);

    // If response looks suspicious, try Playwright-rendered HTML fallback.
    // Link-density check catches JS-heavy SPAs that return 200 with a React shell
    // (e.g. <div id="root"></div>) — these have few <a href> tags despite being large.
    const hasBlocker = SCRAPER_BLOCKER_PATTERNS.some(re => re.test(body));
    const looksSuspicious = !hasBlocker && (
      (result.status_code >= 400 && result.status_code < 500) ||
      result.byte_length < 5120 ||
      !((result.content_type || '').includes('text/html')) ||
      isSpаShell
    );
    if (looksSuspicious) {
      try {
        const rendered = await fetchRenderedHtml(careersUrl, TIMEOUT_MS);
        if (rendered) {
          await ensureDir(ARTIFACTS_DIR);
          // Keep original HTML for debugging, but also overwrite the primary artifact
          // so extraction.js (which reads {id}.html) gets the rendered content.
          await fsp.writeFile(path.join(ARTIFACTS_DIR, `${companyId}.playwright.html`), rendered, 'utf8');
          await saveArtifact(companyId, 'playwright_html', rendered, false);
          result.method = 'playwright_html';
          result.content_type = 'text/html';
          result.byte_length = Buffer.byteLength(rendered, 'utf8');
          result.status_code = 200;
          result.success = true;
          result.status = 'success';
          body = rendered;
          if (verbose) console.log(`[${companyId}] playwright fallback → ${result.byte_length}b`);
        }
      } catch (e) {
        console.warn(`[warn] Playwright fallback failed for ${companyId}: ${e && e.message}`);
      }
    }

    result.status = result.success ? 'success' : 'error';
    await appendScrapeRun(result);
    return result;
  } catch (err) {
    result.error = err.message || String(err);
    result.success = false;
    result.status = 'error';
    if (verbose) console.log(`[${companyId}] error: ${err.message}`);
    await appendScrapeRun(result);
    return result;
  } finally {
    releaseProvider(providerKey);
  }
}

async function run(companiesPath, companyFilter = null) {
  const run = startRun('scraper');
  try {
    // load companies
    let companies = [];
    try {
      companies = await loadCompanies(companiesPath);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }

    const verbose = process.argv.includes('--verbose');

    console.log(`Found ${companies.length} companies with careers_page_reachable=true`);

    // Worker pool — drains the queue CONCURRENCY companies at a time rather than
    // firing all simultaneously. Semaphores still gate per-provider limits.
    const CONCURRENCY = 10;
    const results = [];
    const queue = companies
      .filter(c => !companyFilter || c.id === companyFilter)
      .map((c, idx) => ({ c, idx }));
    async function worker() {
      while (queue.length > 0) {
        const { c, idx } = queue.shift();
        try {
          results.push(await scrapeCompany(c, { index: idx, verbose }));
        } catch (err) {
          console.error(`Error handling company ${c && (c.id || c.name)}: ${err.message}`);
          results.push(null);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, companies.length) }, worker));
    console.log('Scrape run complete');
    const finalResults = results.filter(Boolean);
    const processed = finalResults.length;
    const errors = finalResults.filter(r => !r.success).length;
    await endRun(run, { processed, errors });
    return finalResults;
  } finally {
    // ensure Playwright browser is closed
    try {
      await closeBrowser();
    } catch (e) {
      // ignore
    }
  }
}

module.exports = {
  scrapeCompany,
  run
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  let companiesPath = DEFAULT_COMPANIES_PATH;
  let companyFilter = null;
  argv.forEach(arg => {
    if (arg.startsWith('--companies=')) companiesPath = path.resolve(process.cwd(), arg.split('=')[1]);
    if (arg.startsWith('--company=')) companyFilter = arg.split('=')[1];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node src/agents/scraper.js [--companies=path/to/companies.json] [--company=id]');
      process.exit(0);
    }
  });

  run(companiesPath, companyFilter).catch(err => {
    console.error('Fatal error during scrape:', err);
    process.exit(1);
  });
}
