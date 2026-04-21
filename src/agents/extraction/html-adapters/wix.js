/**
 * Wix-rendered careers pages: extract explicit posting URLs from anchors and JSON blobs.
 */
const cheerio = require('cheerio');
const {
  ADAPTER_HTML_MAX,
  isXmlSitemapOrNonHtml,
  resolveUrl,
  urlAppearsInHtml,
  deriveTitleFromUrl,
  isBareListingPath,
  mergeByUrl
} = require('./shared');

const WIX_FP = /static\.wixstatic\.com|parastorage\.com|data-wix-|wix-warmup-data|wix-code/i;
const WIX_GENERATOR = /<meta[^>]*name\s*=\s*["']generator["'][^>]*content\s*=\s*["'][^"']*wix[^"']*["']/i;
const POSTING_SEGMENT_RE = /\/(job|jobs|position|positions|opening|openings|vacancy|vacancies|career-opportunities)\b/i;
const SCRIPT_URL_KEY_RE = /(url|joburl|job_url|link|applicationurl|application_url|postingurl|posting_url)$/i;
const SCRIPT_MAX_CHARS = 2_000_000;

function isWixPage(html) {
  return WIX_FP.test(html) || WIX_GENERATOR.test(html);
}

function isLikelyPostingPath(pathname) {
  if (!pathname) return false;
  if (isBareListingPath(pathname)) return false;
  if (POSTING_SEGMENT_RE.test(pathname)) return true;
  // Keep this strict: require two+ path segments for careers-ish pages.
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return false;
  return /(careers|career|opportunities|openings|vacancies)/i.test(pathname);
}

function isWixJobPostingUrl(resolved, baseUrl) {
  if (!resolved) return false;
  try {
    const u = new URL(resolved);
    if (!isLikelyPostingPath(u.pathname)) return false;
    if (/[?&](gh_jid|lever-via|workday|jobid|job_id|jobId)=/i.test(u.search)) return true;
    if (POSTING_SEGMENT_RE.test(u.pathname)) return true;
    const baseHost = baseUrl ? new URL(baseUrl).hostname : '';
    if (baseHost && u.hostname === baseHost) return true;
    return false;
  } catch {
    return false;
  }
}

function extractWixAnchors(html, baseUrl) {
  const htmlSlice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
  const $ = cheerio.load(htmlSlice);
  const out = [];
  const seen = new Set();

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href || href.startsWith('#') || /^mailto:|^javascript:|^tel:/i.test(href)) return;
    const resolved = resolveUrl(href, baseUrl);
    if (!resolved || !isWixJobPostingUrl(resolved, baseUrl)) return;
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

function walkJson(node, visit, keyName = '') {
  if (!node || typeof node !== 'object') return;
  visit(node, keyName);
  if (Array.isArray(node)) {
    for (const item of node) walkJson(item, visit);
    return;
  }
  for (const [k, v] of Object.entries(node)) walkJson(v, visit, k);
}

function extractWixScriptJobs(html, baseUrl) {
  const htmlSlice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
  const out = [];
  const seen = new Set();
  const scriptTagRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptTagRe.exec(htmlSlice))) {
    const raw = m[1].trim();
    if (!raw || raw.length > SCRIPT_MAX_CHARS) continue;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    walkJson(data, (obj) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value !== 'string') continue;
        if (!SCRIPT_URL_KEY_RE.test(key)) continue;
        const resolved = resolveUrl(value, baseUrl);
        if (!resolved || seen.has(resolved)) continue;
        if (!isWixJobPostingUrl(resolved, baseUrl)) continue;
        if (!htmlSlice.includes(value) && !htmlSlice.includes(resolved)) continue;
        seen.add(resolved);
        const titleRaw = obj.title || obj.name || obj.role || null;
        const title = typeof titleRaw === 'string' ? titleRaw.replace(/\s+/g, ' ').trim() : null;
        out.push({
          job_title: title || deriveTitleFromUrl(resolved),
          url: resolved,
          location: null,
          employment_type: null,
          description: typeof obj.description === 'string' ? obj.description.slice(0, 500) : null
        });
      }
    });
  }
  return out;
}

module.exports = {
  name: 'wix',
  match(html) {
    if (!html || isXmlSitemapOrNonHtml(html)) return false;
    const slice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
    return isWixPage(slice);
  },
  extract(html, baseUrl) {
    const base = baseUrl || '';
    return mergeByUrl(extractWixAnchors(html, base), extractWixScriptJobs(html, base));
  }
};
