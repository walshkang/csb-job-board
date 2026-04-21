/**
 * Greenhouse embedded boards: anchors to boards.greenhouse.io plus SSR JSON blobs.
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

const GH_FP = /greenhouse\.io|boards\.greenhouse/i;

function isGreenhouseHost(hostname) {
  return /greenhouse\.io|boards\.greenhouse/i.test(hostname || '');
}

/** Role detail URLs (not bare board index). */
function isGreenhouseJobDetailUrl(resolved) {
  if (!resolved) return false;
  try {
    const u = new URL(resolved);
    if (!isGreenhouseHost(u.hostname)) return false;
    if (/\/jobs\/\d+/i.test(u.pathname)) return true;
    if (/[?&]gh_jid=/i.test(u.search)) return true;
    return false;
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

function extractGreenhouseFromScripts(htmlSlice, baseUrl) {
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
      const url = obj.absolute_url;
      if (typeof url !== 'string') return;
      const resolved = resolveUrl(url, baseUrl);
      if (!resolved || seen.has(resolved)) return;
      if (!isGreenhouseJobDetailUrl(resolved)) return;
      if (!htmlSlice.includes(url) && !htmlSlice.includes(resolved)) return;
      seen.add(resolved);
      const title = obj.title || obj.name;
      const job_title =
        typeof title === 'string'
          ? title.replace(/\s+/g, ' ').trim().slice(0, 120)
          : deriveTitleFromUrl(resolved);
      out.push({
        job_title: job_title || deriveTitleFromUrl(resolved),
        url: resolved,
        location: null,
        employment_type: null,
        description: typeof obj.content === 'string' ? obj.content.slice(0, 500) : null
      });
    });
  }
  return out;
}

function extractGreenhouseAnchors(html, baseUrl) {
  const htmlSlice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
  const $ = cheerio.load(htmlSlice);
  const seen = new Set();
  const out = [];

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href || href.startsWith('#')) return;
    const resolved = resolveUrl(href, baseUrl);
    if (!resolved || !isGreenhouseJobDetailUrl(resolved)) return;
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
  name: 'greenhouse',
  match(html) {
    if (!html || isXmlSitemapOrNonHtml(html)) return false;
    const slice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
    return GH_FP.test(slice);
  },
  extract(html, baseUrl) {
    const base = baseUrl || '';
    const htmlSlice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
    return mergeByUrl(
      mergeByUrl(extractGreenhouseAnchors(html, base), extractGreenhouseFromScripts(htmlSlice, base)),
      extractJobsFromJsonLd(html, base)
    );
  }
};
