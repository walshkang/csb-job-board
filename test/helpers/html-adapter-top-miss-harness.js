/**
 * Load + validate top-miss HTML adapter fixtures (manifest + sibling .html files).
 * Used by Jest harness and scripts/audit-html-extract-adapter-headroom.js --fixtures-only.
 */
const fs = require('fs');
const path = require('path');
const { classifyShape, countJobLikeHrefs } = require('../../src/agents/extraction/html-adapters/shared');
const { tryHtmlAdapters } = require('../../src/agents/extraction/html-adapters');

const TOP_MISS_SHAPE_WHITELIST = new Set([
  'wordpress-careers-ish',
  'webflow-dom',
  'many-career-path-hrefs',
  'other',
]);

/** Directory containing manifest.json and {id}.html fixtures */
const TOP_MISS_FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'html-adapters', 'top-miss');

const MANIFEST_PATH = path.join(TOP_MISS_FIXTURES_DIR, 'manifest.json');

function readManifest(fixturesDir = TOP_MISS_FIXTURES_DIR) {
  const manifestPath = path.join(fixturesDir, 'manifest.json');
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (e) {
    throw new Error(`Top-miss manifest missing or unreadable: ${manifestPath} (${e.message})`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Top-miss manifest JSON invalid: ${manifestPath} (${e.message})`);
  }
  return data;
}

function fixtureHtmlPath(fixturesDir, id) {
  return path.join(fixturesDir, `${id}.html`);
}

function loadFixtureHtml(fixturesDir, id) {
  const fp = fixtureHtmlPath(fixturesDir, id);
  return fs.readFileSync(fp, 'utf8');
}

/**
 * @param {unknown} manifest
 * @param {string} fixturesDir
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
function validateManifest(manifest, fixturesDir = TOP_MISS_FIXTURES_DIR) {
  const errors = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push('manifest must be a non-null object');
    return { ok: false, errors };
  }

  const { fixtures } = manifest;
  if (!Array.isArray(fixtures)) {
    errors.push('manifest.fixtures must be an array');
    return { ok: false, errors };
  }
  if (fixtures.length === 0) {
    errors.push('manifest.fixtures must be non-empty');
  }

  const seenIds = new Set();

  for (let i = 0; i < fixtures.length; i++) {
    const prefix = `fixtures[${i}]`;
    const row = fixtures[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`${prefix}: must be an object`);
      continue;
    }

    const { id, shape, base_url: baseUrl, expected_min_jobs: minJobs, must_not_match: mustNot, require_high_signal: highSig } =
      row;

    if (typeof id !== 'string' || !id.trim()) {
      errors.push(`${prefix}.id must be a non-empty string`);
    } else if (seenIds.has(id)) {
      errors.push(`duplicate fixture id: ${id}`);
    } else {
      seenIds.add(id);
      const htmlPath = fixtureHtmlPath(fixturesDir, id);
      if (!fs.existsSync(htmlPath)) {
        errors.push(`missing fixture file for id "${id}": ${htmlPath}`);
      }
    }

    if (typeof shape !== 'string' || !TOP_MISS_SHAPE_WHITELIST.has(shape)) {
      errors.push(
        `${prefix}.shape must be one of: ${[...TOP_MISS_SHAPE_WHITELIST].sort().join(', ')}`
      );
    }

    if (baseUrl !== undefined && (typeof baseUrl !== 'string' || !baseUrl.trim())) {
      errors.push(`${prefix}.base_url must be a non-empty string when set`);
    }

    if (typeof minJobs !== 'number' || !Number.isFinite(minJobs) || minJobs < 0 || !Number.isInteger(minJobs)) {
      errors.push(`${prefix}.expected_min_jobs must be a non-negative integer`);
    }

    if (!Array.isArray(mustNot)) {
      errors.push(`${prefix}.must_not_match must be an array of strings`);
    } else {
      for (let j = 0; j < mustNot.length; j++) {
        if (typeof mustNot[j] !== 'string') {
          errors.push(`${prefix}.must_not_match[${j}] must be a string`);
        }
      }
    }

    if (highSig !== undefined && typeof highSig !== 'boolean') {
      errors.push(`${prefix}.require_high_signal must be a boolean when set`);
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * @param {{ items?: { url?: string }[] }} | null adapted
 * @param {string[]} fragments
 * @returns {{ url: string, frag: string }[]} violations (empty when no items or all pass)
 */
function assertUrlsMustNotMatch(adapted, fragments) {
  if (!adapted || !Array.isArray(adapted.items) || adapted.items.length === 0) return [];
  const bad = [];
  for (const item of adapted.items) {
    const url = item && typeof item.url === 'string' ? item.url : '';
    for (const frag of fragments) {
      if (frag && url.includes(frag)) bad.push({ url, frag });
    }
  }
  return bad;
}

/**
 * @param {string} [fixturesDir]
 * @returns
 *   | { ok: true, fixturesDir: string, total: number, adapterHit: number, byShape: { shape: string, count: number }[], shapeMismatches: { id: string, expected: string, actual: string }[], highSignalFailures: { id: string, countJobLikeHrefs: number }[], fixtures: object[] }
 *   | { ok: false, validationErrors: string[] }
 */
function buildTopMissFixturesReport(fixturesDir = TOP_MISS_FIXTURES_DIR) {
  let manifest;
  try {
    manifest = readManifest(fixturesDir);
  } catch (e) {
    return { ok: false, validationErrors: [e.message] };
  }

  const v = validateManifest(manifest, fixturesDir);
  if (!v.ok) return { ok: false, validationErrors: v.errors };

  const byShape = new Map();
  let adapterHit = 0;
  const shapeMismatches = [];
  const highSignalFailures = [];
  const fixturesOut = [];

  for (const entry of manifest.fixtures) {
    const html = loadFixtureHtml(fixturesDir, entry.id);
    const classified = classifyShape(html);
    if (classified !== entry.shape) {
      shapeMismatches.push({ id: entry.id, expected: entry.shape, actual: classified });
    }
    byShape.set(classified, (byShape.get(classified) || 0) + 1);

    const baseUrl =
      entry.base_url && typeof entry.base_url === 'string' && entry.base_url.trim()
        ? entry.base_url
        : 'https://example.com';
    const adapted = tryHtmlAdapters(html, baseUrl);
    const itemCount = adapted && Array.isArray(adapted.items) ? adapted.items.length : 0;
    if (itemCount >= 1) adapterHit += 1;

    if (entry.require_high_signal) {
      const jlh = countJobLikeHrefs(html);
      if (jlh < 3) highSignalFailures.push({ id: entry.id, countJobLikeHrefs: jlh });
    }

    fixturesOut.push({
      id: entry.id,
      shape: entry.shape,
      classifiedShape: classified,
      adapterName: adapted && adapted.adapterName ? adapted.adapterName : null,
      itemCount,
      jobLikeHrefs: countJobLikeHrefs(html),
    });
  }

  const byShapeArr = [...byShape.entries()]
    .map(([shape, count]) => ({ shape, count }))
    .sort((a, b) => b.count - a.count || a.shape.localeCompare(b.shape));

  return {
    ok: true,
    fixturesDir,
    total: manifest.fixtures.length,
    adapterHit,
    byShape: byShapeArr,
    shapeMismatches,
    highSignalFailures,
    fixtures: fixturesOut,
  };
}

module.exports = {
  TOP_MISS_FIXTURES_DIR,
  MANIFEST_PATH,
  TOP_MISS_SHAPE_WHITELIST,
  readManifest,
  validateManifest,
  loadFixtureHtml,
  fixtureHtmlPath,
  assertUrlsMustNotMatch,
  buildTopMissFixturesReport,
};
