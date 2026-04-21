/**
 * Notion public sites: job rows are often *.notion.site/{Page-Slug} without /jobs in the path.
 */
const cheerio = require('cheerio');
const {
  ADAPTER_HTML_MAX,
  isXmlSitemapOrNonHtml,
  resolveUrl,
  urlAppearsInHtml,
  deriveTitleFromUrl
} = require('./shared');

function notionGeneratorMeta(html) {
  const m = html.match(/<meta[^>]*name\s*=\s*["']generator["'][^>]*content\s*=\s*["']([^"']*)["']/i);
  return m ? m[1].toLowerCase() : '';
}

function isNotionPublicHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return h === 'notion.so' || h === 'www.notion.so' || h.endsWith('.notion.site');
}

/** Single-segment paths that are usually nav / policy, not postings */
const NOTION_SINGLE_SEGMENT_DENY = new Set([
  'privacy',
  'privacy-policy',
  'terms',
  'terms-of-service',
  'legal',
  'about',
  'cookies',
  'cookie-policy',
  'careers',
  'jobs',
  'home'
]);

function isNotionJobLink(resolved) {
  if (!resolved) return false;
  try {
    const u = new URL(resolved);
    if (!isNotionPublicHost(u.hostname)) return false;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return false;
    if (parts.length === 1) {
      const s = parts[0].toLowerCase();
      if (NOTION_SINGLE_SEGMENT_DENY.has(s)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function extractNotionAnchors(html, baseUrl) {
  const htmlSlice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
  const $ = cheerio.load(htmlSlice);
  const seen = new Set();
  const out = [];

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href || href.startsWith('#') || /^mailto:|^javascript:|^tel:/i.test(href)) return;
    const resolved = resolveUrl(href, baseUrl);
    if (!resolved || !isNotionJobLink(resolved)) return;
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
  name: 'notion',
  match(html) {
    if (!html || isXmlSitemapOrNonHtml(html)) return false;
    const slice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
    if (/id\s*=\s*["']notion-app["']/i.test(slice)) return true;
    if (/notion\.site|notion\.so/i.test(slice)) return true;
    return notionGeneratorMeta(slice).includes('notion');
  },
  extract(html, baseUrl) {
    return extractNotionAnchors(html, baseUrl || '');
  }
};
