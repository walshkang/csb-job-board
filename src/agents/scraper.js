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

const CONCURRENCY = 3;
const TIMEOUT_MS = 15000;
const MAX_RETRIES = 2; // up to 2 retries (total attempts = 1 + MAX_RETRIES)

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
    // ignore
  }
}

async function loadCompanies(companiesPath) {
  try {
    const raw = await fsp.readFile(companiesPath, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('companies.json must be an array');
    return arr.filter(c => c && c.careers_page_reachable === true);
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

async function handleCompany(company, index) {
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
    error: null
  };

  if (!careersUrl) {
    result.error = 'No careers_page_url';
    await appendScrapeRun(result);
    return result;
  }

  // detect ATS
  const ghToken = extractGreenhouseToken(careersUrl);
  const leverSlug = extractLeverSlug(careersUrl);

  try {
    if (ghToken) {
      // Greenhouse API
      const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${ghToken}/jobs`;
      result.method = 'greenhouse_api';
      const ua = chooseUserAgent(index);
      const res = await attemptFetchWithRetries(apiUrl, { headers: { 'User-Agent': ua, Accept: 'application/json' } });
      result.status_code = res.status;
      result.content_type = res.headers.get('content-type') || null;
      const body = await res.text();
      result.byte_length = Buffer.byteLength(body, 'utf8');
      if (result.byte_length < 1024) console.warn(`[warn] greenhouse response small for ${companyId} (${result.byte_length} bytes)`);
      await saveArtifact(companyId, 'greenhouse_api', body, true);
      result.success = res.ok;
      await appendScrapeRun(result);
      return result;
    }

    if (leverSlug) {
      // Lever API
      const apiUrl = `https://api.lever.co/v0/postings/${leverSlug}?mode=json`;
      result.method = 'lever_api';
      const ua = chooseUserAgent(index);
      const res = await attemptFetchWithRetries(apiUrl, { headers: { 'User-Agent': ua, Accept: 'application/json' } });
      result.status_code = res.status;
      result.content_type = res.headers.get('content-type') || null;
      const body = await res.text();
      result.byte_length = Buffer.byteLength(body, 'utf8');
      if (result.byte_length < 1024) console.warn(`[warn] lever response small for ${companyId} (${result.byte_length} bytes)`);
      await saveArtifact(companyId, 'lever_api', body, true);
      result.success = res.ok;
      await appendScrapeRun(result);
      return result;
    }

    // fallback: direct HTML fetch
    result.method = 'direct_html';
    const ua = chooseUserAgent(index);
    const res = await attemptFetchWithRetries(careersUrl, { headers: { 'User-Agent': ua, Accept: 'text/html' } });
    result.status_code = res.status;
    result.content_type = res.headers.get('content-type') || null;
    const body = await res.text();
    result.byte_length = Buffer.byteLength(body, 'utf8');
    if (result.byte_length < 1024) console.warn(`[warn] HTML response small for ${companyId} (${result.byte_length} bytes). Possible block or empty page.`);
    await saveArtifact(companyId, 'direct_html', body, false);
    result.success = res.ok;
    await appendScrapeRun(result);
    return result;
  } catch (err) {
    result.error = err.message || String(err);
    await appendScrapeRun(result);
    return result;
  }
}

async function run(companiesPath) {
  // load companies
  let companies = [];
  try {
    companies = await loadCompanies(companiesPath);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  console.log(`Found ${companies.length} companies with careers_page_reachable=true`);
  // concurrency pool
  let i = 0;
  const results = [];
  const pool = new Array(CONCURRENCY).fill(null).map(async () => {
    while (i < companies.length) {
      const idx = i++;
      const c = companies[idx];
      try {
        // sprinkle index into UA choice
        const res = await handleCompany(c, idx);
        results.push(res);
      } catch (err) {
        console.error(`Error handling company ${c && (c.id || c.name)}: ${err.message}`);
      }
    }
  });

  await Promise.all(pool);
  console.log('Scrape run complete');
  return results;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  let companiesPath = DEFAULT_COMPANIES_PATH;
  argv.forEach(arg => {
    if (arg.startsWith('--companies=')) companiesPath = path.resolve(process.cwd(), arg.split('=')[1]);
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node src/agents/scraper.js [--companies=path/to/companies.json]');
      process.exit(0);
    }
  });

  run(companiesPath).catch(err => {
    console.error('Fatal error during scrape:', err);
    process.exit(1);
  });
}
