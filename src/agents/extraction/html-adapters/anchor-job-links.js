const {
  extractJobsFromAnchors,
  extractJobsFromJsonLd,
  isXmlSitemapOrNonHtml,
  mergeByUrl
} = require('./shared');

/** Anchor crawl + JSON-LD JobPosting blocks (bare /careers landing links excluded). */
module.exports = {
  name: 'anchor-job-links',
  match(html, baseUrl) {
    if (!html || isXmlSitemapOrNonHtml(html)) return false;
    const base = baseUrl || '';
    return mergeByUrl(extractJobsFromAnchors(html, base), extractJobsFromJsonLd(html, base)).length >= 1;
  },
  extract(html, baseUrl) {
    const base = baseUrl || '';
    return mergeByUrl(extractJobsFromAnchors(html, base), extractJobsFromJsonLd(html, base));
  }
};
