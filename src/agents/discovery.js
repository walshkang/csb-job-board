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
const { startRun, endRun } = require('../utils/run-log');
const { fetchRenderedHtml, closeBrowser } = require('../utils/browser');
const { streamLLM, DailyQuotaError } = require('../llm-client');
const Progress = require('../utils/progress');

const CONCURRENCY = 15;
const BATCH_SAVE_SIZE = 10;
const REQUEST_TIMEOUT_MS = 5000; // 5s
const DOMAIN_MIN_INTERVAL_MS = 200; // 5 requests / second per domain
const MAX_FETCH_RETRIES = 2;
const RETRY_BASE_MS = 500;
const LLM_CONCURRENCY = 3; // cap simultaneous LLM fallback calls

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
];

function chooseUserAgent(i) {
  return USER_AGENTS[i % USER_AGENTS.length];
}

let fetchCounter = 0;

const STANDARD_PATHS = [
  // Core
  '/careers',
  '/jobs',
  '/about/careers',
  '/company/careers',
  '/join',
  '/openings',
  '/hiring',
  '/opportunities',

  // Singular forms
  '/career',
  '/job',

  // Action-oriented & team
  '/join-us',
  '/work-with-us',
  '/work-here',
  '/join-our-team',
  '/join-the-team',
  '/our-team',

  // Regional & search variants
  '/vacancies',
  '/job-openings',
  '/current-openings',
  '/search-jobs',
  '/job-search',
  '/roles',

  // Nested corporate variants
  '/about/jobs',
  '/about-us/careers',
  '/about-us/jobs',
  '/company/jobs',
  '/corporate/careers',

  // Culture / employer branding
  '/life',
  '/culture',
  '/people',
];

function usage() {
  console.log('Usage: node src/agents/discovery.js [--force] [--verbose] [--debug] [--limit=N]');
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

// LLM concurrency semaphore — prevents quota bursts when many companies hit fallback simultaneously
let _llmRunning = 0;
const _llmWaiters = [];
function acquireLlmSlot() {
  if (_llmRunning < LLM_CONCURRENCY) { _llmRunning++; return Promise.resolve(); }
  return new Promise(resolve => _llmWaiters.push(resolve));
}
function releaseLlmSlot() {
  if (_llmWaiters.length > 0) { _llmWaiters.shift()(); } else { _llmRunning--; }
}

// Per-domain queue to enforce rate limit per domain
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
      // Merge default browser-like headers, allowing caller to override
      const defaultHeaders = {
        'User-Agent': chooseUserAgent(fetchCounter++),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      };
      const mergedHeaders = Object.assign({}, defaultHeaders, opts.headers || {});
      const fetchOpts = { redirect: 'follow', signal: controller.signal, ...opts, headers: mergedHeaders };
      const res = await fetch(url, fetchOpts);
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
  // Use GET only; many servers 403 on HEAD
  try {
    const res = await domainFetch(domain, url, { method: 'GET' });
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
  if (u.includes('jobs.ashby.com') || u.includes('ashby.com')) return 'ashby';
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

    const ashbyUrl = `https://jobs.ashby.com/${slug}`;
    try {
      const res = await tryHeadThenGet(ashbyUrl, 'jobs.ashby.com');
      if (res && res.status === 200) {
        verboseLog(verbose, `ATS slug hit (ashby): ${ashbyUrl}`);
        return { found: true, url: res.url || ashbyUrl, method: 'ats_slug' };
      }
    } catch (_) { /* try next */ }
  }
  return null;
}

// Fetch homepage once and scan <a href> tags for career-related links.
// Returns the homepage HTML as a side-effect in homepageCache so the LLM
// fallback doesn't have to fetch it again.
const CAREER_LINK_RE = /\b(career|careers|job|jobs|join|join-?us|openings|positions|hiring|work-with-us|work_with_us)\b/i;

async function scanHomepageLinks(domain, homepageCache, verbose, usePlaywright = false) {
  let html = homepageCache.html;
  if (html === undefined) {
    try {
      const res = await domainFetch(domain, `https://${domain}/`, { method: 'GET' });
      html = (res && res.status === 200) ? await res.text() : null;
    } catch (_) { html = null; }
    homepageCache.html = html;
  }
  if (!html) return null;

  const re = /<a\s[^>]*\bhref=["']([^"'#][^"']*)["']/gi;
  let m;

  function extractCandidates(src) {
    re.lastIndex = 0;
    const hrefs = [];
    while ((m = re.exec(src)) !== null) hrefs.push(m[1]);
    return hrefs.filter(h => CAREER_LINK_RE.test(h));
  }

  async function tryCandidates(candidates, method) {
    for (const href of candidates) {
      let url;
      try { url = new URL(href, `https://${domain}`).toString(); } catch (_) { continue; }
      if (!/^https?:\/\//i.test(url)) continue;
      try {
        const res = await tryHeadThenGet(url, new URL(url).hostname);
        if (res && res.status === 200) {
          verboseLog(verbose, `${method} hit: ${url}`);
          return { found: true, url: res.url || url, method };
        }
      } catch (_) { /* try next */ }
    }
    return null;
  }

  // Static scan
  const staticResult = await tryCandidates(extractCandidates(html), 'homepage_link_scan');
  if (staticResult) return staticResult;

  // Playwright fallback — only if opted in and static scan found nothing
  if (usePlaywright) {
    verboseLog(verbose, `Static scan empty for ${domain}, trying Playwright...`);
    const rendered = await fetchRenderedHtml(`https://${domain}/`);
    if (rendered) {
      homepageCache.html = rendered; // update so LLM fallback gets rendered HTML too
      const result = await tryCandidates(extractCandidates(rendered), 'playwright_scan');
      if (result) return result;
    }
  }

  return null;
}

async function callGeminiLLM(prompt, domain, silent = false) {
  if (!config.discovery.geminiKey && !config.discovery.anthropicKey) throw new Error('No LLM API key configured');
  if (!silent) process.stderr.write('\n[discovery: ' + (domain || 'unknown') + ']\n');
  const opts = config.resolveAgent('discovery');
  return streamLLM({ ...opts, prompt, maxOutputTokens: 256, _agent: 'discovery', onToken: silent ? null : chunk => process.stderr.write(chunk) });
}

function normalizeDomain(domainRaw) {
  if (!domainRaw) return null;
  return domainRaw.replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase();
}

function classifyFailureReason(steps) {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s === 'llm:no_key') return 'no_careers_page';
    if (s.startsWith('llm:truncated')) return 'llm_truncated';
    if (s.startsWith('llm:homepage')) return 'llm_homepage';
    if (s.startsWith('llm:validation_failed')) return 'llm_validation_failed';
    if (s === 'llm:not_found') return 'llm_not_found';
    if (s === 'llm:empty') return 'llm_not_found';
    if (s.startsWith('llm:error')) return 'llm_error';
  }
  // Check if early steps suggest network-level failures
  const hasTimeout = steps.some(s => s.includes('timeout'));
  if (hasTimeout) return 'timeout';
  const hasDns = steps.some(s => s.includes('dns'));
  if (hasDns) return 'dns_error';
  return 'all_miss';
}

async function processCompany(company, opts) {
  const { force, verbose, usePlaywright } = opts;
  const steps = [];
  const t0 = Date.now();

  if (!company || !company.domain) return { skipped: true, reason: 'no-domain', steps, duration_ms: 0 };

  if (!force && company.careers_page_url && company.careers_page_reachable) {
    return { skipped: true, reason: 'already-reachable', steps, duration_ms: 0 };
  }

  const domain = normalizeDomain(company.domain);
  if (!domain) return { skipped: true, reason: 'no-domain', steps, duration_ms: 0 };

  const done = (result) => {
    if (!result.skipped) {
      if (result.found) {
        company.careers_page_url = result.url;
        company.careers_page_reachable = true;
        company.careers_page_discovery_method = result.method;
        company.ats_platform = detectAtsPlatform(result.url);
        delete company.careers_page_failure_reason;
      } else {
        company.careers_page_url = null;
        company.careers_page_reachable = false;
        company.careers_page_discovery_method = result.method || 'not_found';
        company.ats_platform = null;
        company.careers_page_failure_reason = classifyFailureReason(steps);
      }
      if (result.llm_attempted) company.llm_attempted = true;
      if (result.llm_error) company.llm_error = true;
    }
    return { ...result, steps, duration_ms: Date.now() - t0 };
  };

  // Shared cache so homepage is only fetched once across steps 3 and 4.
  const homepageCache = {};

  // 1) Standard paths — probe all in parallel, take first 200 OK
  try {
    const standardResult = await Promise.any(
      STANDARD_PATHS.map(p => {
        const candidate = `https://${domain}${p}`;
        return tryHeadThenGet(candidate, domain).then(res => {
          if (res && res.status === 200) return { found: true, url: res.url || candidate, method: 'standard_pattern' };
          throw new Error(`non-200: ${res ? res.status : 'no-res'}`);
        });
      })
    );
    if (standardResult) {
      steps.push(`standard_paths:hit:${new URL(standardResult.url).pathname}`);
      return done(standardResult);
    }
  } catch (aggErr) {
    // Classify the aggregate error — check if any sub-error was a timeout or DNS failure
    const errs = aggErr.errors || [];
    const hasTimeout = errs.some(e => e && e.name === 'AbortError');
    const hasDns = errs.some(e => e && e.message && /ENOTFOUND|getaddrinfo/i.test(e.message));
    if (hasDns) steps.push('standard_paths:dns_error');
    else if (hasTimeout) steps.push('standard_paths:timeout');
    else steps.push('standard_paths:all_miss');
  }

  // 2) ATS slug guessing (Greenhouse + Lever)
  const atsResult = await tryAtsSlugs(company, false);
  if (atsResult) {
    steps.push(`ats_slug:hit`);
    return done(atsResult);
  }
  steps.push('ats_slug:miss');

  // 3) Homepage link scan — one fetch, regex over <a href> tags
  const linkResult = await scanHomepageLinks(domain, homepageCache, false, usePlaywright);
  if (linkResult) {
    steps.push(`homepage_link_scan:hit`);
    return done(linkResult);
  }
  steps.push(homepageCache.html ? 'homepage_link_scan:miss' : 'homepage_fetch:null');

  // 4) Sitemap
  try {
    const candidates = await findSitemapCandidates(domain);
    let sitemapHit = false;
    for (const cand of candidates) {
      try {
        const res = await tryHeadThenGet(cand, domain);
        if (res && res.status === 200) {
          steps.push('sitemap:hit');
          sitemapHit = true;
          return done({ found: true, url: res.url || cand, method: 'sitemap' });
        }
      } catch (_) { /* step already recorded */ }
    }
    if (!sitemapHit) steps.push(candidates.length ? 'sitemap:miss' : 'sitemap:none');
  } catch (_) {
    steps.push('sitemap:error');
  }

  // 5) LLM fallback — attempt even if homepage HTML is not available (use company name/domain)
  if (!config.discovery.apiKey) {
    steps.push('llm:no_key');
    return done({ found: false, method: 'not_found' });
  }
  try {
    const homepageHtmlAvailable = !!homepageCache.html;

    // Build prompt: prefer homepage HTML when available, otherwise use company name/domain and derived slugs
    let prompt;
    if (homepageHtmlAvailable) {
      const homepageHtml = (homepageCache.html || '').slice(0, 10000);
      const tmpl = fs.readFileSync(path.join(__dirname, '../prompts/discovery-html.txt'), 'utf8');
      prompt = tmpl
        .replace('{company_name}', company.name || domain)
        .replace('{homepage_html}', homepageHtml);
    } else {
      const slugs = deriveAtsSlugs(company).join(', ');
      const triedPaths = STANDARD_PATHS.join(', ');
      const tmpl = fs.readFileSync(path.join(__dirname, '../prompts/discovery-nohtml.txt'), 'utf8');
      prompt = tmpl
        .replace('{company_name}', company.name || '')
        .replace('{domain}', domain)
        .replace('{slugs}', slugs)
        .replace('{tried_paths}', triedPaths);
    }

    // Call LLM and mark that it was attempted so callers can record metrics.
    await acquireLlmSlot();
    let completion;
    try {
      completion = await callGeminiLLM(prompt, domain, verbose); // silent when verbose — output shown in summary
    } finally {
      releaseLlmSlot();
    }

    if (!completion) {
      steps.push('llm:empty');
      return done({ found: false, method: 'not_found', llm_attempted: true });
    }

    // Log raw completion for debug tracing
    opts._llmRaw = completion.trim().slice(0, 200);

    let answer = completion.trim().split('\n')[0].trim().replace(/^['"]?(.*?)['"]?$/, '$1');

    if (!answer || /^NOT[_ -]?FOUND$/i.test(answer)) {
      steps.push('llm:not_found');
      return done({ found: false, method: 'not_found', llm_attempted: true });
    }

    if (answer.startsWith('/')) answer = `https://${domain}${answer}`;
    if (!/^https?:\/\//i.test(answer)) answer = `https://${answer}`;

    // Reject truncated URLs
    let parsedAnswer;
    try {
      parsedAnswer = new URL(answer);
    } catch (_) {
      steps.push(`llm:truncated:${answer.slice(0, 60)}`);
      return done({ found: false, method: 'not_found', llm_attempted: true });
    }

    // Reject if LLM returned just the homepage (path is / or empty)
    const answerPath = parsedAnswer.pathname.replace(/\/+$/, '');
    if (!answerPath) {
      steps.push(`llm:homepage:${answer.slice(0, 60)}`);
      return done({ found: false, method: 'not_found', llm_attempted: true });
    }

    // Reject if hostname looks truncated (e.g. "www.alchemyco2.")
    if (/\.$/.test(parsedAnswer.hostname)) {
      steps.push(`llm:truncated:${answer.slice(0, 60)}`);
      return done({ found: false, method: 'not_found', llm_attempted: true });
    }

    try {
      const res = await tryHeadThenGet(answer, parsedAnswer.hostname);
      if (res && res.status === 200) {
        steps.push(`llm:hit:${answerPath}`);
        return done({ found: true, url: res.url || answer, method: 'llm_fallback', llm_attempted: true });
      }
      steps.push(`llm:validation_failed:${res ? res.status : 'no-res'}:${answer.slice(0, 60)}`);
    } catch (err) {
      steps.push(`llm:validation_failed:fetch_error:${answer.slice(0, 60)}`);
    }

    return done({ found: false, method: 'not_found', llm_attempted: true });
  } catch (err) {
    if (err.name === 'DailyQuotaError') throw err; // let it abort the run
    steps.push(`llm:error:${err.message.slice(0, 60)}`);
    warn(`LLM fallback failed for ${company.name || domain}:`, err.message);
    return done({ found: false, method: 'not_found', llm_attempted: true, llm_error: true });
  }
}

async function main() {
  const run = startRun('discovery');
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { usage(); process.exit(0); }
  const force = argv.includes('--force');
  const verbose = argv.includes('--verbose');
  const debug = argv.includes('--debug');
  const usePlaywright = argv.includes('--playwright');
  const limit = parseLimitArg(argv);

  // Debug log setup — written as JSONL so it can be tailed while running
  let debugLogPath = null;
  let debugWriteQueue = Promise.resolve();
  if (debug) {
    const dateStr = new Date().toISOString().slice(0, 10);
    const runsDir = path.join(process.cwd(), 'data', 'runs');
    await fs.promises.mkdir(runsDir, { recursive: true });
    debugLogPath = path.join(runsDir, `discovery-debug-${dateStr}.jsonl`);
    log(`Debug log: ${debugLogPath}`);
  }

  function appendDebugEntry(entry) {
    if (!debugLogPath) return;
    const line = JSON.stringify(entry) + '\n';
    debugWriteQueue = debugWriteQueue
      .then(() => fs.promises.appendFile(debugLogPath, line, 'utf8'))
      .catch(() => {});
  }

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
    // Include any company that does NOT have careers_page_reachable === true
    // This covers undefined, null, and false values so stale entries aren't skipped.
    else if (!c.careers_page_url || c.careers_page_reachable !== true) indices.push(i);
  });

  if (indices.length === 0) {
    log('No companies need discovery (nothing to do).');
    process.exit(0);
  }

  if (limit != null && indices.length > limit) {
    indices.splice(limit);
    log(`--limit=${limit}: processing first ${indices.length} companies only`);
  }

  const indices_total = indices.length;
  const progress = new Progress(indices_total, 'discovery');
  log(`Starting discovery: ${indices_total} companies to process (concurrency=${CONCURRENCY})`);

  let processedSinceSave = 0;
  let totalProcessed = 0;
  let foundCount = 0;
  let notFoundCount = 0;
  const methodCounts = { standard_pattern: 0, ats_slug: 0, homepage_link_scan: 0, sitemap: 0, playwright_scan: 0, llm_fallback: 0, llm_fallback_attempted: 0, not_found: 0 };
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
      const companyOpts = { force, verbose, usePlaywright };
      try {
        const result = await processCompany(company, companyOpts);
        totalProcessed++;
        if (result.skipped) {
          // no change
        } else if (result.found) {
          foundCount++;
          methodCounts[result.method] = (methodCounts[result.method] || 0) + 1;
        } else {
          notFoundCount++;
          methodCounts[company.careers_page_discovery_method] = (methodCounts[company.careers_page_discovery_method] || 0) + 1;
        }

        if (result && result.llm_attempted) {
          methodCounts.llm_fallback_attempted = (methodCounts.llm_fallback_attempted || 0) + 1;
        }
        if (result && result.llm_error) {
          llmErrorCount++;
        }

        // Write debug entry
        if (debug && !result.skipped) {
          appendDebugEntry({
            ts: new Date().toISOString(),
            company: company.name || '',
            domain: company.domain || '',
            found: !!result.found,
            method: result.method || null,
            url: result.url || null,
            failure_reason: company.careers_page_failure_reason || null,
            steps: result.steps || [],
            duration_ms: result.duration_ms || 0,
            llm_raw: companyOpts._llmRaw || null,
          });
        }

        // Output: verbose = one clean line per company; default = \r progress bar
        if (verbose && !result.skipped) {
          const icon = result.found ? '✓' : '✗';
          const pct = Math.round(totalProcessed / indices_total * 100);
          const name = (company.name || company.domain || '').slice(0, 30).padEnd(30);
          const outcome = result.found
            ? result.url || ''
            : `not_found [${company.careers_page_failure_reason || 'all_miss'}]`;
          const secs = ((result.duration_ms || 0) / 1000).toFixed(1);
          process.stdout.write(`[discovery] ${icon} ${totalProcessed}/${indices_total} (${pct}%) ${name}  ${outcome}  (${secs}s)\n`);
          if (result.steps && result.steps.length) {
            process.stdout.write(`             steps: ${result.steps.join(' → ')}\n`);
          }
          if (companyOpts._llmRaw) {
            process.stdout.write(`             llm: ${companyOpts._llmRaw.slice(0, 80)}\n`);
          }
        } else if (!verbose) {
          try { progress.tick(totalProcessed, company.name || company.domain || ''); } catch(_) {}
        }
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
        // count this as processed and update progress
        totalProcessed++;
        try { progress.tick(totalProcessed, company.name || company.domain || ''); } catch(_) {}
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
  progress.done();

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
  await closeBrowser();
  process.exit(0);
}

module.exports = {
  processCompany
};

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error in discovery agent:', err);
    process.exit(2);
  });
}
