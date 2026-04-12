#!/usr/bin/env node
/*
  Discovery Agent (Slice 2)
  Usage: node src/agents/discovery.js [--force] [--verbose]

  Reads data/companies.json and discovers careers page URLs using:
    1) Standard URL patterns
    2) Sitemap
    3) LLM fallback (Anthropic) if ANTHROPIC_API_KEY present

  Writes updates back to data/companies.json every 10 companies (atomic tmp-rename).
*/

const fs = require('fs');
const path = require('path');
const https = require('https');
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

// Load .env.local (same pattern as src/agents/ocr.js)
const envPath = path.join(__dirname, '../../.env.local');
try {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const match = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
} catch { /* no .env.local, that's fine */ }

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
  '/about/careers',
  '/join',
  '/join-us',
  '/work-with-us'
];

function usage() {
  console.log('Usage: node src/agents/discovery.js [--force] [--verbose]');
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

// Minimal Anthropic call; if API not present or call fails, fallback to NOT_FOUND
function callAnthropic(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const body = JSON.stringify({
    model,
    max_tokens: 200,
    temperature: 0.0,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
          const text = json.content?.[0]?.text || json.message?.content || json.completion || json.output || (json.choices && (json.choices[0]?.text || json.choices[0]?.message?.content));
          if (!text) throw new Error('Unexpected response shape: ' + JSON.stringify(json).slice(0, 200));
          resolve(String(text).trim());
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
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

  // 1) Standard patterns
  for (const p of STANDARD_PATHS) {
    const candidate = `https://${domain}${p}`;
    try {
      const res = await tryHeadThenGet(candidate, domain);
      if (res && res.status === 200) {
        const finalUrl = res.url || candidate;
        return {
          found: true,
          url: finalUrl,
          method: 'standard_pattern'
        };
      }
    } catch (err) {
      verboseLog(verbose, `standard check failed for ${candidate}:`, err.message);
    }
  }

  // 2) Sitemap
  try {
    const candidates = await findSitemapCandidates(domain);
    for (const cand of candidates) {
      try {
        const res = await tryHeadThenGet(cand, domain);
        if (res && res.status === 200) {
          const finalUrl = res.url || cand;
          return { found: true, url: finalUrl, method: 'sitemap' };
        }
      } catch (err) {
        verboseLog(verbose, 'sitemap candidate failed:', cand, err.message);
      }
    }
  } catch (err) {
    verboseLog(verbose, 'sitemap fetch failed for', domain, err.message);
  }

  // 3) LLM fallback
  try {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('no-key');

    let homepageHtml = '';
    try {
      const homeRes = await domainFetch(domain, `https://${domain}/`, { method: 'GET' });
      if (homeRes && homeRes.status === 200) {
        let txt = await homeRes.text();
        homepageHtml = txt.slice(0, 10000);
      }
    } catch (err) {
      verboseLog(verbose, 'homepage fetch failed for LLM fallback:', err.message);
    }

    const prompt = `Given this homepage HTML for ${company.name || domain}, what is the careers page URL? Return just the URL or the string NOT_FOUND.\n\nHTML:\n${homepageHtml}`;
    const completion = await callAnthropic(prompt);
    if (!completion) throw new Error('empty-response');
    let answer = completion.trim().split('\n')[0].trim();
    // Some LLMs return quoted strings
    answer = answer.replace(/^['"]?(.*?)['"]?$/, '$1');

    if (!answer || /^NOT[_ -]?FOUND$/i.test(answer)) {
      return { found: false, method: 'not_found' };
    }

    // Normalize relative paths
    if (answer.startsWith('/')) answer = `https://${domain}${answer}`;
    if (!/^https?:\/\//i.test(answer)) answer = `https://${answer}`;

    // Validate
    try {
      const res = await tryHeadThenGet(answer, domain);
      if (res && res.status === 200) {
        const finalUrl = res.url || answer;
        return { found: true, url: finalUrl, method: 'llm_fallback' };
      }
    } catch (err) {
      verboseLog(verbose, 'llm-proposed-url validation failed:', err.message);
    }

    return { found: false, method: 'not_found' };
  } catch (err) {
    // LLM not available or failed -> not_found (don't crash)
    verboseLog(verbose, 'LLM fallback skipped/failed:', err.message);
    return { found: false, method: 'not_found' };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { usage(); process.exit(0); }
  const force = argv.includes('--force');
  const verbose = argv.includes('--verbose');

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

  if (!Array.isArray(companiesRaw) || companiesRaw.length === 0) {
    console.warn('data/companies.json exists but contains 0 companies. Nothing to do.');
    process.exit(0);
  }

  const companies = companiesRaw; // operate in-place
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

  log(`Starting discovery: ${indices.length} companies to process (concurrency=${CONCURRENCY})`);

  let processedSinceSave = 0;
  let totalProcessed = 0;
  let foundCount = 0;
  let notFoundCount = 0;
  const methodCounts = { standard_pattern: 0, sitemap: 0, llm_fallback: 0, not_found: 0 };
  const errorDomains = new Set();

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
      } catch (err) {
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
}

main().catch(err => {
  console.error('Fatal error in discovery agent:', err);
  process.exit(2);
});
