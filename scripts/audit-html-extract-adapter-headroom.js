#!/usr/bin/env node
/**
 * Reports adapter headroom on HTML-only artifacts.
 *
 * Population: validated companies with artifacts/html/{id}.html and no sibling {id}.json.
 *
 * Default output:
 *   { totalHtmlOnly, adapterHit, misses, adapterCoveragePct, byShape: [...] }
 *
 * With --pre-snapshot=path.json (from a prior run or frozen baseline):
 *   { headroom, comparison, byShapeTopMiss, shipGate }
 * Optional --fixture-fp-regression if tests show new adapter false positives on fixtures.
 *
 * --fixtures-only — skip companies/artifacts; report classifyShape + tryHtmlAdapters on
 * test/fixtures/html-adapters/top-miss (override with --fixtures-dir=).
 */

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { tryHtmlAdapters } = require('../src/agents/extraction/html-adapters');
const { classifyShape, countJobLikeHrefs } = require('../src/agents/extraction/html-adapters/shared');
const { buildTopMissFixturesReport, TOP_MISS_FIXTURES_DIR } = require('../test/helpers/html-adapter-top-miss-harness');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ARTIFACTS = path.join(REPO_ROOT, 'artifacts', 'html');
const COMPANIES_PATH = path.join(REPO_ROOT, 'data', 'companies.json');

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeHtmlBaseUrl(u) {
  if (u == null || u === '') return '';
  const s = String(u).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/**
 * @param {object} before - prior buildAdapterHeadroomReport result
 * @param {object} after - current buildAdapterHeadroomReport result
 */
function compareHeadroomReports(before, after) {
  const b = before || {};
  const a = after || {};
  return {
    totalHtmlOnlyBefore: b.totalHtmlOnly ?? 0,
    totalHtmlOnlyAfter: a.totalHtmlOnly ?? 0,
    totalHtmlOnlyDelta: (a.totalHtmlOnly ?? 0) - (b.totalHtmlOnly ?? 0),
    adapterHitBefore: b.adapterHit ?? 0,
    adapterHitAfter: a.adapterHit ?? 0,
    adapterHitDelta: (a.adapterHit ?? 0) - (b.adapterHit ?? 0),
    missesBefore: b.misses ?? 0,
    missesAfter: a.misses ?? 0,
    missesDelta: (a.misses ?? 0) - (b.misses ?? 0),
    adapterCoveragePctBefore: b.adapterCoveragePct ?? 0,
    adapterCoveragePctAfter: a.adapterCoveragePct ?? 0,
    adapterCoveragePctDelta: round1((a.adapterCoveragePct ?? 0) - (b.adapterCoveragePct ?? 0)),
  };
}

const TOP_MISS_COMPARE_SHAPES = [
  'wordpress-careers-ish',
  'webflow-dom',
  'many-career-path-hrefs',
  'other',
];

function indexByShapeCount(byShape) {
  const m = new Map();
  for (const row of byShape || []) {
    if (row && row.shape) m.set(String(row.shape), Number(row.count) || 0);
  }
  return m;
}

/**
 * Per-shape miss counts for the four top-miss expansion buckets. If the baseline
 * `before.byShape` is empty, `missesBefore` / `missesDelta` are null (deltas N/A).
 */
function compareTopMissByShape(before, after) {
  const bMap = indexByShapeCount(before && before.byShape);
  const aMap = indexByShapeCount(after && after.byShape);
  const baselineHasBreakdown = !!(before && before.byShape && before.byShape.length);
  return {
    baselineShapeBreakdownPresent: baselineHasBreakdown,
    topMissRows: TOP_MISS_COMPARE_SHAPES.map(shape => {
      const afterCount = aMap.get(shape) ?? 0;
      if (!baselineHasBreakdown) {
        return { shape, missesBefore: null, missesAfter: afterCount, missesDelta: null };
      }
      const beforeCount = bMap.get(shape) ?? 0;
      return {
        shape,
        missesBefore: beforeCount,
        missesAfter: afterCount,
        missesDelta: afterCount - beforeCount,
      };
    }),
  };
}

/**
 * Slice 4 ship gate: keep adapter work only if adapter count rises enough and fixtures did not regress.
 * `htmlAdapterCompanies` here is the same population as headroom `adapterHit` (HTML-only rows, adapter returned ≥1 job).
 *
 * @param {object} opts
 * @param {number} opts.htmlAdapterCompaniesBefore
 * @param {number} opts.htmlAdapterCompaniesAfter
 * @param {boolean} [opts.fixtureFalsePositiveRegression]
 * @param {number} [opts.minAdapterDelta]
 */
function evaluateExpansionShipGate({
  htmlAdapterCompaniesBefore,
  htmlAdapterCompaniesAfter,
  fixtureFalsePositiveRegression = false,
  minAdapterDelta = 40,
}) {
  const delta =
    Number(htmlAdapterCompaniesAfter ?? 0) - Number(htmlAdapterCompaniesBefore ?? 0);
  const adapterOk = delta >= minAdapterDelta;
  const fixturesOk = !fixtureFalsePositiveRegression;
  const pass = adapterOk && fixturesOk;
  const reasons = [];
  if (!adapterOk) {
    reasons.push(
      `htmlAdapterCompanies delta ${delta} is below required +${minAdapterDelta} (before ${htmlAdapterCompaniesBefore}, after ${htmlAdapterCompaniesAfter})`
    );
  }
  if (!fixturesOk) {
    reasons.push('known false-positive regression on test fixtures (see html-adapters / extraction tests)');
  }
  return {
    pass,
    adapterDelta: delta,
    minAdapterDelta,
    adapterOk,
    fixturesOk,
    reasons,
  };
}

function buildAdapterHeadroomReport({ companies, artifactsDir = DEFAULT_ARTIFACTS }) {
  const shapeBuckets = new Map();
  let totalHtmlOnly = 0;
  let adapterHit = 0;

  for (const company of companies) {
    const id = company && company.id;
    if (!id) continue;

    const htmlPath = path.join(artifactsDir, `${id}.html`);
    const jsonPath = path.join(artifactsDir, `${id}.json`);
    if (!fs.existsSync(htmlPath) || fs.existsSync(jsonPath)) continue;

    totalHtmlOnly += 1;
    const html = fs.readFileSync(htmlPath, 'utf8');
    const baseUrl = normalizeHtmlBaseUrl(company.careers_page_url || company.domain || '');
    const adapted = tryHtmlAdapters(html, baseUrl);
    const isAdapterHit = !!(adapted && Array.isArray(adapted.items) && adapted.items.length > 0);

    if (isAdapterHit) {
      adapterHit += 1;
      continue;
    }

    const shape = classifyShape(html);
    const highSignal = countJobLikeHrefs(html) >= 3 ? 1 : 0;
    const prev = shapeBuckets.get(shape) || { count: 0, highSignalCount: 0 };
    shapeBuckets.set(shape, {
      count: prev.count + 1,
      highSignalCount: prev.highSignalCount + highSignal,
    });
  }

  const misses = totalHtmlOnly - adapterHit;
  const byShape = [...shapeBuckets.entries()]
    .map(([shape, stats]) => ({
      shape,
      count: stats.count,
      pctOfMisses: misses ? round1((stats.count / misses) * 100) : 0,
      highSignalCount: stats.highSignalCount,
    }))
    .sort((a, b) => b.count - a.count || a.shape.localeCompare(b.shape));

  return {
    totalHtmlOnly,
    adapterHit,
    misses,
    adapterCoveragePct: totalHtmlOnly ? round1((adapterHit / totalHtmlOnly) * 100) : 0,
    byShape,
  };
}

function parseArgs(argv) {
  const out = {
    artifactsDir: DEFAULT_ARTIFACTS,
    preSnapshotPath: null,
    fixtureFpRegression: false,
    fixturesOnly: false,
    fixturesDir: TOP_MISS_FIXTURES_DIR,
  };
  for (const a of argv) {
    if (a.startsWith('--artifacts=')) {
      const value = a.split('=').slice(1).join('=');
      out.artifactsDir = value || DEFAULT_ARTIFACTS;
    } else if (a.startsWith('--pre-snapshot=')) {
      out.preSnapshotPath = a.split('=').slice(1).join('=') || null;
    } else if (a === '--fixture-fp-regression') {
      out.fixtureFpRegression = true;
    } else if (a === '--fixtures-only') {
      out.fixturesOnly = true;
    } else if (a.startsWith('--fixtures-dir=')) {
      const value = a.split('=').slice(1).join('=');
      out.fixturesDir = value ? path.resolve(REPO_ROOT, value) : TOP_MISS_FIXTURES_DIR;
    }
  }
  return out;
}

function loadPreSnapshot(filePath) {
  const raw = readJsonSafe(filePath);
  if (!raw || typeof raw !== 'object') return null;
  if (raw.headroom && typeof raw.headroom === 'object') {
    return {
      headroom: raw.headroom,
      htmlAdapterCompanies:
        raw.htmlAdapterCompanies != null ? Number(raw.htmlAdapterCompanies) : raw.headroom.adapterHit,
    };
  }
  if (raw.totalHtmlOnly != null && raw.adapterHit != null) {
    return { headroom: raw, htmlAdapterCompanies: raw.htmlAdapterCompanies ?? raw.adapterHit };
  }
  return null;
}

function main() {
  const { artifactsDir, preSnapshotPath, fixtureFpRegression, fixturesOnly, fixturesDir } = parseArgs(
    process.argv.slice(2)
  );

  if (fixturesOnly) {
    const rep = buildTopMissFixturesReport(fixturesDir);
    if (!rep.ok) {
      console.error(JSON.stringify({ mode: 'fixtures-only', ok: false, validationErrors: rep.validationErrors }, null, 2));
      process.exit(1);
    }
    const payload = {
      mode: 'fixtures-only',
      fixturesDir: rep.fixturesDir,
      total: rep.total,
      adapterHit: rep.adapterHit,
      byShape: rep.byShape,
      shapeMismatches: rep.shapeMismatches,
      highSignalFailures: rep.highSignalFailures,
      fixtures: rep.fixtures,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const raw = readJsonSafe(COMPANIES_PATH);
  if (!raw) {
    console.error('Missing or invalid', COMPANIES_PATH);
    process.exit(1);
  }

  let companies;
  try {
    companies = config.validateCompanies(raw);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (!fs.existsSync(artifactsDir)) {
    console.error('Artifacts directory not found:', artifactsDir);
    process.exit(1);
  }

  const report = buildAdapterHeadroomReport({ companies, artifactsDir });

  let payload = report;
  if (preSnapshotPath) {
    const pre = loadPreSnapshot(preSnapshotPath);
    if (!pre || !pre.headroom) {
      console.error('Invalid or missing --pre-snapshot JSON (need headroom report or { headroom, htmlAdapterCompanies? })');
      process.exit(1);
    }
    const comparison = compareHeadroomReports(pre.headroom, report);
    const byShapeTopMiss = compareTopMissByShape(pre.headroom, report);
    const shipGate = evaluateExpansionShipGate({
      htmlAdapterCompaniesBefore: pre.htmlAdapterCompanies,
      htmlAdapterCompaniesAfter: report.adapterHit,
      fixtureFalsePositiveRegression: fixtureFpRegression,
    });
    payload = {
      headroom: report,
      comparison,
      byShapeTopMiss,
      shipGate,
    };
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildAdapterHeadroomReport,
  normalizeHtmlBaseUrl,
  compareHeadroomReports,
  compareTopMissByShape,
  evaluateExpansionShipGate,
  loadPreSnapshot,
};
