/**
 * Shopify theme careers pages: job rows are often /pages/{role-slug} without /jobs in the path.
 */
const cheerio = require('cheerio');
const {
  ADAPTER_HTML_MAX,
  isXmlSitemapOrNonHtml,
  extractJobsFromJsonLd,
  resolveUrl,
  urlAppearsInHtml,
  deriveTitleFromUrl,
  isBareListingPath,
  mergeByUrl
} = require('./shared');

const SHOPIFY_FP = /cdn\.shopify\.com|shopify\.theme/i;

/** Common policy / index slugs under /pages/ — not individual postings */
const SHOPIFY_PAGE_SLUG_DENY = new Set([
  'privacy-policy',
  'privacy',
  'terms',
  'terms-of-service',
  'contact',
  'about',
  'faq',
  'shipping',
  'returns',
  'cookie-policy',
  'legal',
  'careers',
  'jobs'
]);

function isShopifyJobPagePath(pathname) {
  if (!pathname) return false;
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'pages' || parts.length < 2) return false;
  const slug = parts[parts.length - 1].toLowerCase();
  if (SHOPIFY_PAGE_SLUG_DENY.has(slug)) return false;
  return true;
}

function extractShopifyPageJobs(html, baseUrl) {
  const htmlSlice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
  const $ = cheerio.load(htmlSlice);
  const seen = new Set();
  const out = [];

  $('a[href*="/pages/"]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href || href.startsWith('#')) return;
    const resolved = resolveUrl(href, baseUrl);
    if (!resolved || !urlAppearsInHtml(resolved, htmlSlice)) return;
    try {
      const { pathname } = new URL(resolved);
      if (isBareListingPath(pathname)) return;
      if (!isShopifyJobPagePath(pathname)) return;
    } catch {
      return;
    }
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
  name: 'shopify',
  match(html) {
    if (!html || isXmlSitemapOrNonHtml(html)) return false;
    const slice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
    return SHOPIFY_FP.test(slice);
  },
  extract(html, baseUrl) {
    const base = baseUrl || '';
    return mergeByUrl(extractShopifyPageJobs(html, base), extractJobsFromJsonLd(html, base));
  }
};
