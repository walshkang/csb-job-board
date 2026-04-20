/**
 * Shared heuristics for DOM-based HTML job extraction (before LLM fallback).
 */
const cheerio = require('cheerio');
const { URL } = require('url');

/** LLM extraction truncates HTML; adapters parse the full artifact (bounded) because listings often appear far below the fold. */
const ADAPTER_HTML_MAX = Math.min(parseInt(process.env.EXTRACTION_ADAPTER_HTML_MAX || '2000000', 10) || 2000000, 4_000_000);

/** Non-HTML artifacts sometimes saved as .html (Yoast XML sitemap, etc.) */
function isXmlSitemapOrNonHtml(html) {
  const head = (html || '').slice(0, 800).trim();
  return /^<\?xml\s/i.test(head) || /<urlset[\s\n]/i.test(html || '');
}

/**
 * Same intent as careers URL patterns used in audits — job posting links only.
 */
/** Listing index pages (/careers, /jobs), not individual postings */
function isBareListingPath(pathname) {
  if (!pathname) return false;
  const p = pathname.replace(/\/+$/, '').toLowerCase();
  return /^\/(jobs?|careers|career|opportunities|openings|positions|vacancies)\/?$/.test(p);
}

function looksLikeJobHref(href) {
  if (!href || typeof href !== 'string') return false;
  const t = href.trim();
  if (!t || t.startsWith('#') || /^mailto:|^javascript:|^tel:/i.test(t)) return false;
  const u = t.toLowerCase();
  if (u.includes('linkedin.com') || u.includes('facebook.com') || u.includes('instagram.com')) return false;
  if (/greenhouse\.io|boards\.greenhouse/i.test(u)) return true;
  if (/jobs\.lever\.|\.lever\.co\/jobs/i.test(u)) return true;
  if (/myworkdayjobs\.com/i.test(u)) return true;
  if (/ashbyhq\.com/i.test(u)) return true;
  if (/[a-z0-9.-]+\.careers\//i.test(u)) return true;
  // Hosted ATS under careers subdomain (e.g. careers.acme.com/p/...)
  if (/careers?\./.test(u) && /\/p\/|\/jobs?\/|\/job\//i.test(u)) return true;
  if (/\/careers[-_][a-z0-9]/i.test(u)) return true;
  if (/\/jobs?[-_][a-z0-9]/i.test(u)) return true;
  if (/\/(jobs?|careers|career|opportunities|openings|positions|vacancies)(\/|$|\?)/i.test(u)) return true;
  if (/job-position\/|\/job-opening|\/jobposting/i.test(u)) return true;
  return false;
}

function resolveUrl(urlStr, base) {
  if (!urlStr) return null;
  try {
    return new URL(urlStr, base || undefined).toString();
  } catch {
    return null;
  }
}

/** Strip HTML noise from anchor text */
function anchorText($el) {
  return $el.text().replace(/\s+/g, ' ').trim() || null;
}

/**
 * Count raw href matches (fast path for adapter match()).
 */
function countJobLikeHrefs(html) {
  const slice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let n = 0;
  let m;
  while ((m = re.exec(slice))) {
    if (looksLikeJobHref(m[1])) n++;
  }
  return n;
}

/**
 * Validate resolved URL appears in HTML prompt window (parity with LLM extraction path).
 */
function urlAppearsInHtml(resolved, htmlSlice) {
  if (!resolved) return false;
  try {
    const { pathname } = new URL(resolved);
    return htmlSlice.includes(pathname) || htmlSlice.includes(resolved);
  } catch {
    return false;
  }
}

/**
 * Parse anchors with cheerio; dedupe by resolved URL; attach titles.
 */
function extractJobsFromAnchors(html, baseUrl) {
  const htmlSlice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
  const $ = cheerio.load(htmlSlice);
  const seen = new Set();
  const out = [];

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!looksLikeJobHref(href)) return;
    const resolved = resolveUrl(href, baseUrl);
    if (!resolved || !urlAppearsInHtml(resolved, htmlSlice)) return;
    try {
      const { pathname } = new URL(resolved);
      if (isBareListingPath(pathname)) return;
    } catch {
      /* skip */
    }
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const title = anchorText($(el));
    const job_title = title && title.length > 120 ? title.slice(0, 117) + '...' : title;
    out.push({
      job_title: job_title || deriveTitleFromUrl(resolved),
      url: resolved,
      location: null,
      employment_type: null,
      description: null
    });
  });

  return out;
}

/**
 * Aggregate JobPosting entries from JSON-LD blocks (common on WordPress / ATS embeds).
 */
function extractJobsFromJsonLd(html, baseUrl) {
  const htmlSlice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
  const scriptRe = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = scriptRe.exec(htmlSlice))) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const candidates = [];
    if (Array.isArray(data)) candidates.push(...data);
    else candidates.push(data);
    if (data && data['@graph'] && Array.isArray(data['@graph'])) candidates.push(...data['@graph']);
    for (const node of candidates) {
      if (!node || typeof node !== 'object') continue;
      const types = node['@type'];
      const tArr = Array.isArray(types) ? types : types ? [types] : [];
      const isJob = tArr.some(t => String(t).toLowerCase().includes('jobposting'));
      if (!isJob) continue;
      let url = node.url || node.hiringOrganization?.sameAs || null;
      if (typeof url === 'object' && url !== null) url = url['@id'] || null;
      const title = node.title || node.name || null;
      if (!url || typeof url !== 'string') continue;
      const resolved = resolveUrl(url, baseUrl);
      if (!resolved || seen.has(resolved)) continue;
      if (!htmlSlice.includes(url) && !htmlSlice.includes(resolved)) continue;
      seen.add(resolved);
      out.push({
        job_title: title ? String(title).replace(/\s+/g, ' ').trim() : deriveTitleFromUrl(resolved),
        url: resolved,
        location: null,
        employment_type: null,
        description: typeof node.description === 'string' ? node.description.slice(0, 500) : null
      });
    }
  }
  return out;
}

function deriveTitleFromUrl(resolved) {
  try {
    const { pathname } = new URL(resolved);
    const seg = pathname.split('/').filter(Boolean).pop() || '';
    const words = seg.replace(/[-_]+/g, ' ').replace(/\.[a-z]+$/i, '').trim();
    return words ? words.replace(/\b\w/g, c => c.toUpperCase()) : null;
  } catch {
    return null;
  }
}

module.exports = {
  ADAPTER_HTML_MAX,
  isXmlSitemapOrNonHtml,
  looksLikeJobHref,
  countJobLikeHrefs,
  extractJobsFromAnchors,
  extractJobsFromJsonLd,
  resolveUrl,
  urlAppearsInHtml
};
