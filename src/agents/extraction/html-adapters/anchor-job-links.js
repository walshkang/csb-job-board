const {
  extractJobsFromAnchors,
  extractJobsFromJsonLd,
  isXmlSitemapOrNonHtml
} = require('./shared');

function mergeByUrl(a, b) {
  const seen = new Set();
  const out = [];
  for (const arr of [a, b]) {
    for (const it of arr) {
      if (!it || !it.url || seen.has(it.url)) continue;
      seen.add(it.url);
      out.push(it);
    }
  }
  return out;
}

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
