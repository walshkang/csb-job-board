function toSet(urls) {
  if (!Array.isArray(urls)) return new Set();
  return new Set(urls.filter(Boolean));
}

function diffScrapeUrls({ priorUrls = [], currentUrls = [] } = {}) {
  const prior = toSet(priorUrls);
  const current = toSet(currentUrls);
  const existing = new Set();
  const netNew = new Set();
  const removed = new Set();

  for (const url of current) {
    if (prior.has(url)) existing.add(url);
    else netNew.add(url);
  }
  for (const url of prior) {
    if (!current.has(url)) removed.add(url);
  }

  return { existing, netNew, removed };
}

module.exports = {
  diffScrapeUrls,
};
