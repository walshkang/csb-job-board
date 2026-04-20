/**
 * Single adapter tier: deterministic anchor extraction beats LLM when it yields postings.
 */
const anchorJobLinks = require('./anchor-job-links');

const adapters = [anchorJobLinks];

/**
 * @returns {{ adapterName: string, items: object[] } | null}
 */
function tryHtmlAdapters(html, baseUrl) {
  const base = baseUrl || '';
  for (const a of adapters) {
    if (!a.match(html, base)) continue;
    const items = a.extract(html, base);
    if (Array.isArray(items) && items.length >= 1) {
      return { adapterName: a.name, items };
    }
  }
  return null;
}

module.exports = {
  adapters,
  tryHtmlAdapters
};
