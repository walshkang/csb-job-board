#!/usr/bin/env node
/*
  Discovery Agent (Slice 2)
  Usage: node src/agents/discovery.js [--force] [--verbose]

  Reads data/companies.json and discovers careers page URLs using:
    1) Standard URL patterns
    2) Sitemap
    3) LLM fallback (Gemini) if GEMINI_API_KEY present

  Writes updates back to data/companies.json every 10 companies (atomic tmp-rename).
*/

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const config = require('../config');
const { callGeminiText, DailyQuotaError } = require('../gemini-text');

const CONCURRENCY = 5;
const BATCH_SAVE_SIZE = 10;
const REQUEST_TIMEOUT_MS = 10000; // 10s
const DOMAIN_MIN_INTERVAL_MS = 1000; // 1 request / second per domain
const MAX_FETCH_RETRIES = 4;
const RETRY_BASE_MS = 1000;

const STANDARD_PATHS = [
  '/careers',
  '/jobs',
  '/careers/',
  '/jobs/',
  '/career',
  '/about/careers',
  '/about/jobs',
  '/company/careers',
  '/join',
  '/join-us',
  '/join-the-team',
  '/work-with-us',
  '/work-here',
  '/openings',
  '/positions',
  '/hiring',
];

function usage() {
  console.log('Usage: node src/agents/discovery.js [--force] [--verbose] [--limit=N]');
}

function parseLimitArg(argv) {
  const arg = argv.find(a => a.startsWith('--limit='));
  if (!arg) return null;
  const n = parseInt(String(arg.split('=')[1]).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function log(...args) { console.log('[discovery]', ...args); }
function warn(...args) { console.warn('[discovery]', ...args); }
function verboseLog(enabled, ...args) { if (enabled) console.log('[discovery]', ...args); }

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Atomic save (write tmp then rename)
async function atomicSaveJson(filePath, data) {
  const tmp = `${filePath}.tmp`;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.promises.rename(tmp, filePath);
}

// Per-domain queue to enforce >=1 request/sec
const domainMap = new Map();
function scheduleDomainTask(domain, fn) {
  let info = domainMap.get(domain);
  if (!info) {
    info = { queue: Promise.resolve(), last: 0 };
    domainMap.set(domain, info);
  }
  const now = Date.now();
  const wait = Math.max(0, DOMAIN_MIN_INTERVAL_MS - (now - info.last));
  info.last = now + wait;
  const p = info.queue.then(() => new Promise(resolve => setTimeout(resolve, wait))).then(() => fn());
  // Ensure queue keeps going even if p rejects
  info.queue = p.catch(() => {});
  return p;
}

async function performFetchWithRetries(url, opts = {}) {
  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { redirect: 'follow', signal: controller.signal, ...opts });
      clearTimeout(id);
      if (res.status === 429) {
        if (attempt >= MAX_FETCH_RETRIES) return res;
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt);
        await delay(backoff);
        attempt++;
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(id);
      // timeout or other network error
      if (err.name === 'AbortError') {
        if (attempt >= MAX_FETCH_RETRIES) throw err;
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt);
        await delay(backoff);
        attempt++;
        continue;
      }
      if (attempt >= MAX_FETCH_RETRIES) throw err;
      const backoff = RETRY_BASE_MS * Math.pow(2, attempt);
      await delay(backoff);
      attempt++;
    }
  }
}

async function domainFetch(domain, url, opts = {}) {
  return scheduleDomainTask(domain, () => performFetchWithRetries(url, opts));
}

async function tryHeadThenGet(url, domain) {
  // Try HEAD first, fallback to GET
  try {
    let res;
    try {
      res = await domainFetch(domain, url, { method: 'HEAD' });
      if (res && res.status === 200) return res;
    } catch (err) {
      // HEAD failed; continue to GET
    }

    // Try GET
    res = await domainFetch(domain, url, { method: 'GET' });
    if (res && res.status === 200) return res;
    return res;
  } catch (err) {
    throw err;
  }
}

function detectAtsPlatform(url) {
  if (!url) return null;
  const u = url.toLowerCase();
  if (u.includes('boards.greenhouse.io') || u.includes('greenhouse.io')) return 'greenhouse';
  if (u.includes('jobs.lever.co')) return 'lever';
  if (u.includes('myworkdayjobs.com')) return 'workday';
  if (u.includes('icims.com')) return 'icims';
  return 'custom';
}

async function findSitemapCandidates(domain) {
  const candidates = [];
  const sitemapPaths = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];
  for (const p of sitemapPaths) {
    const url = `https://${domain}${p}`;
    try {
      const res = await domainFetch(domain, url, { method: 'GET' });
      if (!res || res.status !== 200) continue;
      const txt = await res.text();
      const matches = [...txt.matchAll(/<loc>(.*?)<\/loc>/gmi)].map(m => m[1]);
      for (const loc of matches) {
        if (/(career|careers|job|jobs|join|openings)/i.test(loc)) candidates.push(loc);
      }
      if (candidates.length) break;
    } catch (err) {
      // ignore and try next
    }
  }
  return candidates;
}

// Derive 2-3 slug candidates from domain and company name for ATS guessing.
function deriveAtsSlugs(company) {
  const slugs = new Set();
  // From domain: www.acme-energy.com -> acme-energy
  const domain = normalizeDomain(company.domain);
  if (domain) {
    const base = domain.replace(/^www\./, '').split('.')[0];
    if (base) slugs.add(base);
  }
  // From company name: strip common suffixes, lowercase, hyphenate
  const name = (company.name || '').trim();
  if (name) {
    const full = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    if (full) slugs.add(full);
    const short = name.toLowerCase()
      .replace(/\s+(inc\.?|corp\.?|llc\.?|ltd\.?|co\.?|company|technologies|tech|solutions|group|systems|energy|power|labs?|holdings?)$/i, '')
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    if (short && short !== full) slugs.add(short);
  }
  return [...slugs].slice(0, 3);
}

// Try Greenhouse and Lever ATS URLs using derived slugs.
async function tryAtsSlugs(company, verbose) {
  const slugs = deriveAtsSlugs(company);
  for (const slug of slugs) {
    const ghUrl = `https://boards.greenhouse.io/${slug}`;
    try {
      const res = await tryHeadThenGet(ghUrl, 'boards.greenhouse.io');
      if (res && res.status === 200) {
        verboseLog(verbose, `ATS slug hit (greenhouse): ${ghUrl}`);
        return { found: true, url: res.url || ghUrl, method: 'ats_slug' };
      }
    } catch (_) { /* try next */ }

    const leverUrl = `https://jobs.lever.co/${slug}`;
    try {
      const res = await tryHeadThenGet(leverUrl, 'jobs.lever.co');
      if (res && res.status === 200) {
        verboseLog(verbose, `ATS slug hit (lever): ${leverUrl}`);
        return { found: true, url: res.url || leverUrl, method: 'ats_slug' };
      }
    } catch (_) { /* try next */ }
  }
  return null;
}

// Fetch homepage once and scan <a href> tags for career-related links.
// Returns the homepage HTML as a side-effect in homepageCache so the LLM
// fallback doesn't have to fetch it again.
const CAREER_LINK_RE = /(career|careers|job|jobs|join|openings|positions|hiring|work-with-us|work_with_us)/i;

async function scanHomepageLinks(domain, homepageCache, verbose) {
  let html = homepageCache.html;
  if (html === undefined) {
    try {
      const res = await domainFetch(domain, `https://${domain}/`, { method: 'GET' });
      html = (res && res.status === 200) ? await res.text() : null;
    } catch (_) { html = null; }
    homepageCache.html = html;
  }
  if (!html) return null;

  const hrefs = [];
  const re = /<a\s[^>]*\bhref=["']([^"'#][^"']*)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) hrefs.push(m[1]);

  const candidates = hrefs.filter(h => CAREER_LINK_RE.test(h));
  for (const href of candidates) {
    let url;
    try { url = new URL(href, `https://${domain}`).toString(); } catch (_) { continue; }
    if (!/^https?:\/\//i.test(url)) continue;
    try {
      const res = await tryHeadThenGet(url, new URL(url).hostname);
      if (res && res.status === 200) {
        verboseLog(verbose, `Homepage link scan hit: ${url}`);
        return { found: true, url: res.url || url, method: 'homepage_link_scan' };
      }
    } catch (_) { /* try next candidate */ }
  }
  return null;
}

async function callGeminiLLM(prompt) {
  const apiKey = config.discovery.apiKey;
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
  return callGeminiText({
    apiKey,
    model: config.discovery.model,
    prompt,
    maxOutputTokens: 256,
  });
}

function normalizeDomain(domainRaw) {
  if (!domainRaw) return null;
  return domainRaw.replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase();
}

async function processCompany(company, opts) {
  const { force, verbose } = opts;
  if (!company || !company.domain) return { skipped: true, reason: 'no-domain' };

  if (!force && company.careers_page_url && company.careers_page_reachable) {
    return { skipped: true, reason: 'already-reachable' };
  }

  const domain = normalizeDomain(company.domain);
  if (!domain) return { skipped: true, reason: 'no-domain' };

  // Shared cache so homepage is only fetched once across steps 3 and 4.
  const homepageCache = {};

  // 1) Standard paths
  for (const p of STANDARD_PATHS) {
    const candidate = `https://${domain}${p}`;
    try {
      const res = await tryHeadThenGet(candidate, domain);
      if (res && res.status === 200) {
        return { found: true, url: res.url || candidate, method: 'standard_pattern' };
      }
    } catch (err) {
      verboseLog(verbose, `standard check failed for ${candidate}:`, err.message);
    }
  }

  // 2) ATS slug guessing (Greenhouse + Lever)
  const atsResult = await tryAtsSlugs(company, verbose);
  if (atsResult) return atsResult;

  // 3) Homepage link scan — one fetch, regex over <a href> tags
  const linkResult = await scanHomepageLinks(domain, homepageCache, verbose);
  if (linkResult) return linkResult;

  // 4) Sitemap
  try {
    const candidates = await findSitemapCandidates(domain);
    for (const cand of candidates) {
      try {
        const res = await tryHeadThenGet(cand, domain);
        if (res && res.status === 200) {
          return { found: true, url: res.url || cand, method: 'sitemap' };
        }
      } catch (err) {
        verboseLog(verbose, 'sitemap candidate failed:', cand, err.message);
      }
    }
  } catch (err) {
    verboseLog(verbose, 'sitemap fetch failed for', domain, err.message);
  }

  // 5) LLM fallback — uses cached homepage HTML if available
  if (!config.discovery.apiKey) return { found: false, method: 'not_found' };
  try {
    // If homepage was previously fetched and found unreachable (or never fetched), skip calling LLM to avoid wasting quota.
    if (!homepageCache.html) {
      return { found: false, method: 'not_found' };
    }

    const homepageHtml = (homepageCache.html || '').slice(0, 10000);
    const prompt = `Given this homepage HTML for ${company.name || domain}, what is the careers page URL? Return just the URL or the string NOT_FOUND.\n\nHTML:\n${homepageHtml}`;

    // Call LLM and mark that it was attempted so callers can record metrics.
    const completion = await callGeminiLLM(prompt); // DailyQuotaError bubbles up

    if (!completion) return { found: false, method: 'not_found', llm_attempted: true };
    let answer = completion.trim().split('\n')[0].trim().replace(/^['"]?(.*?)['"]?$/, '$1');

    if (!answer || /^NOT[_ -]?FOUND$/i.test(answer)) {
      return { found: false, method: 'not_found', llm_attempted: true };
    }

    if (answer.startsWith('/')) answer = `https://${domain}${answer}`;
    if (!/^https?:\/\//i.test(answer)) answer = `https://${answer}`;

    try {
      const res = await tryHeadThenGet(answer, domain);
      if (res && res.status === 200) {
        return { found: true, url: res.url || answer, method: 'llm_fallback', llm_attempted: true };
      }
    } catch (err) {
      verboseLog(verbose, 'llm-proposed-url validation failed:', err.message);
    }

    return { found: false, method: 'not_found', llm_attempted: true };
  } catch (err) {
    if (err.name === 'DailyQuotaError') throw err; // let it abort the run
    warn(`LLM fallback failed for ${company.name || domain}:`, err.message);
    return { found: false, method: 'not_found', llm_attempted: true, llm_error: true };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { usage(); process.exit(0); }
  const force = argv.includes('--force');
  const verbose = argv.includes('--verbose');
  const limit = parseLimitArg(argv);

  const dataPath = path.join(process.cwd(), 'data', 'companies.json');
  if (!fs.existsSync(dataPath)) {
    console.error('No companies.json found at data/companies.json — run the OCR agent (Slice 1) first.');
    process.exit(1);
  }

  let companiesRaw;
  try {
    const raw = await fs.promises.readFile(dataPath, 'utf8');
    companiesRaw = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to read or parse data/companies.json:', err.message);
    process.exit(1);
  }

  // Validate companies list (filter out example/blank names)
  let companies;
  try {
    companies = config.validateCompanies(companiesRaw);
  } catch (err) {
    console.error('Company validation failed:', err.message);
    process.exit(1);
  }

  // operate in-place on the validated array
  const indices = [];
  companies.forEach((c, i) => {
    if (!c || !c.domain) return; // only process companies with known domain
    if (force) indices.push(i);
    else if (!c.careers_page_url || c.careers_page_reachable === false) indices.push(i);
  });

  if (indices.length === 0) {
    log('No companies need discovery (nothing to do).');
    process.exit(0);
  }

  if (limit != null && indices.length > limit) {
    indices.splice(limit);
    log(`--limit=${limit}: processing first ${indices.length} companies only`);
  }

  log(`Starting discovery: ${indices.length} companies to process (concurrency=${CONCURRENCY})`);

  let processedSinceSave = 0;
  let totalProcessed = 0;
  let foundCount = 0;
  let notFoundCount = 0;
  const methodCounts = { standard_pattern: 0, ats_slug: 0, homepage_link_scan: 0, sitemap: 0, llm_fallback: 0, llm_fallback_attempted: 0, not_found: 0 };
  const errorDomains = new Set();
  let dailyQuotaHit = false;
  let llmErrorCount = 0;

  let writeQueue = Promise.resolve();
  function scheduleSave() {
    writeQueue = writeQueue.then(() => atomicSaveJson(dataPath, companies)).catch(err => {
      warn('Failed to save companies.json:', err.message);
    });
    return writeQueue;
  }

  async function workerLoop() {
    while (true) {
      const idx = indices.shift();
      if (idx === undefined) break;
      const company = companies[idx];
      try {
        const result = await processCompany(company, { force, verbose });
        totalProcessed++;
        if (result.skipped) {
          // no change
        } else if (result.found) {
          company.careers_page_url = result.url;
          company.careers_page_reachable = true;
          company.careers_page_discovery_method = result.method;
          company.ats_platform = detectAtsPlatform(result.url);
          foundCount++;
          methodCounts[result.method] = (methodCounts[result.method] || 0) + 1;
        } else {
          company.careers_page_url = null;
          company.careers_page_reachable = false;
          company.careers_page_discovery_method = result.method || 'not_found';
          company.ats_platform = null;
          notFoundCount++;
          methodCounts[company.careers_page_discovery_method] = (methodCounts[company.careers_page_discovery_method] || 0) + 1;
        }

        // Record if the LLM fallback was attempted (separate from successes)
        if (result && result.llm_attempted) {
          methodCounts.llm_fallback_attempted = (methodCounts.llm_fallback_attempted || 0) + 1;
        }
        if (result && result.llm_error) llmErrorCount++;
      } catch (err) {
        if (err.name === 'DailyQuotaError') {
          warn('Daily quota exhausted — saving progress and stopping.');
          warn(err.message);
          dailyQuotaHit = true;
          indices.length = 0; // drain queue so all workers exit
          break;
        }
        warn('Error processing company', company.domain || company.name, err.message);
        errorDomains.add(company.domain || company.name || 'unknown');
      }

      processedSinceSave++;
      if (processedSinceSave >= BATCH_SAVE_SIZE) {
        await scheduleSave();
        processedSinceSave = 0;
      }
    }
  }

  // Start worker pool
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(workerLoop());
  await Promise.all(workers);

  // Final save if needed
  await scheduleSave();
  await writeQueue; // wait for final write to complete

  // Summary
  log('Discovery complete:');
  log('  total processed:', totalProcessed);
  log('  found:', foundCount);
  log('  not_found:', notFoundCount);
  log('  method distribution:', methodCounts);
  if (errorDomains.size) log('  domains with errors:', Array.from(errorDomains).slice(0, 50));
  if (llmErrorCount > 0) warn(`  LLM fallback errors: ${llmErrorCount} — check GEMINI_API_KEY and quota`);
  if (dailyQuotaHit) {
    log('  Stopped early: Gemini daily quota exhausted. Re-run tomorrow or enable billing.');
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error in discovery agent:', err);
  process.exit(2);
});
