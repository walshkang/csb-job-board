/**
 * Lever embedded boards: anchors to jobs.lever.co plus SSR JSON (hostedUrl, text).
 */
const cheerio = require('cheerio');
const {
  ADAPTER_HTML_MAX,
  isXmlSitemapOrNonHtml,
  extractJobsFromJsonLd,
  resolveUrl,
  urlAppearsInHtml,
  deriveTitleFromUrl,
  mergeByUrl
} = require('./shared');

const LEVER_FP = /lever\.co|jobs\.lever/i;

function isLeverHost(hostname) {
  return typeof hostname === 'string' && hostname.toLowerCase().endsWith('lever.co');
}

/** Posting URLs: https://jobs.lever.co/{company}/{postingId} (at least two path segments). */
function isLeverJobDetailUrl(resolved) {
  if (!resolved) return false;
  try {
    const u = new URL(resolved);
    if (!isLeverHost(u.hostname)) return false;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length >= 2;
  } catch {
    return false;
  }
}

function walkJson(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  if (Array.isArray(node)) {
    for (const x of node) walkJson(x, visit);
    return;
  }
  for (const k of Object.keys(node)) walkJson(node[k], visit);
}

function extractLeverFromScripts(htmlSlice, baseUrl) {
  const scriptTagRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = scriptTagRe.exec(htmlSlice))) {
    const raw = m[1].trim();
    if (!raw || raw.length > 2_000_000) continue;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    walkJson(data, obj => {
      if (!obj || typeof obj !== 'object') return;
      const rawUrl = obj.hostedUrl || obj.hosted_url || obj.applyUrl;
      if (typeof rawUrl !== 'string') return;
      const resolved = resolveUrl(rawUrl, baseUrl);
      if (!resolved || seen.has(resolved)) return;
      if (!isLeverJobDetailUrl(resolved)) return;
      if (!htmlSlice.includes(rawUrl) && !htmlSlice.includes(resolved)) return;
      seen.add(resolved);
      const title = obj.text || obj.title || obj.name;
      const job_title =
        typeof title === 'string'
          ? title.replace(/\s+/g, ' ').trim().slice(0, 120)
          : deriveTitleFromUrl(resolved);
      out.push({
        job_title: job_title || deriveTitleFromUrl(resolved),
        url: resolved,
        location: null,
        employment_type: null,
        description:
          typeof obj.descriptionPlain === 'string' ? obj.descriptionPlain.slice(0, 500) : null
      });
    });
  }
  return out;
}

function extractLeverAnchors(html, baseUrl) {
  const htmlSlice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
  const $ = cheerio.load(htmlSlice);
  const seen = new Set();
  const out = [];

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href || href.startsWith('#')) return;
    const resolved = resolveUrl(href, baseUrl);
    if (!resolved || !isLeverJobDetailUrl(resolved)) return;
    if (!urlAppearsInHtml(resolved, htmlSlice)) return;
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const title = $(el).text().replace(/\s+/g, ' ').trim() || null;
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

module.exports = {
  name: 'lever',
  match(html) {
    if (!html || isXmlSitemapOrNonHtml(html)) return false;
    const slice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
    return LEVER_FP.test(slice);
  },
  extract(html, baseUrl) {
    const base = baseUrl || '';
    const htmlSlice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
    return mergeByUrl(
      mergeByUrl(extractLeverAnchors(html, base), extractLeverFromScripts(htmlSlice, base)),
      extractJobsFromJsonLd(html, base)
    );
  }
};
