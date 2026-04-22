const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  TOP_MISS_FIXTURES_DIR,
  readManifest,
  validateManifest,
  loadFixtureHtml,
  assertUrlsMustNotMatch,
  buildTopMissFixturesReport,
} = require('./helpers/html-adapter-top-miss-harness');
const { classifyShape, countJobLikeHrefs } = require('../src/agents/extraction/html-adapters/shared');
const { tryHtmlAdapters } = require('../src/agents/extraction/html-adapters');

describe('validateManifest (top-miss)', () => {
  test('rejects non-object manifest', () => {
    const r = validateManifest(null, TOP_MISS_FIXTURES_DIR);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /must be a non-null object/.test(e))).toBe(true);
  });

  test('rejects missing fixtures array', () => {
    const r = validateManifest({ foo: [] }, TOP_MISS_FIXTURES_DIR);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /fixtures must be an array/.test(e))).toBe(true);
  });

  test('rejects empty fixtures', () => {
    const r = validateManifest({ fixtures: [] }, TOP_MISS_FIXTURES_DIR);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /non-empty/.test(e))).toBe(true);
  });

  test('rejects unknown shape and duplicate ids', () => {
    const dir = TOP_MISS_FIXTURES_DIR;
    const r = validateManifest(
      {
        fixtures: [
          { id: 'dup', shape: 'wordpress-careers-ish', expected_min_jobs: 0, must_not_match: [] },
          { id: 'dup', shape: 'webflow-dom', expected_min_jobs: 0, must_not_match: [] },
          { id: 'x', shape: 'not-a-real-shape', expected_min_jobs: 0, must_not_match: [] },
        ],
      },
      dir
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /duplicate fixture id/.test(e))).toBe(true);
    expect(r.errors.some(e => /\.shape must be one of/.test(e))).toBe(true);
  });

  test('rejects missing html file for id', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'top-miss-manifest-'));
    try {
      fs.writeFileSync(
        path.join(tmp, 'manifest.json'),
        JSON.stringify({
          fixtures: [{ id: 'missing-file-xyz', shape: 'other', expected_min_jobs: 0, must_not_match: [] }],
        }),
        'utf8'
      );
      const manifest = readManifest(tmp);
      const r = validateManifest(manifest, tmp);
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => /missing fixture file/.test(e))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects bad field types', () => {
    const r = validateManifest(
      {
        fixtures: [
          {
            id: 123,
            shape: 'other',
            base_url: '',
            expected_min_jobs: 1.5,
            must_not_match: 'nope',
            require_high_signal: 'yes',
          },
        ],
      },
      TOP_MISS_FIXTURES_DIR
    );
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe('readManifest', () => {
  test('throws when manifest.json is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'top-miss-empty-'));
    try {
      expect(() => readManifest(tmp)).toThrow(/manifest missing or unreadable/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('checked-in top-miss manifest + fixtures', () => {
  const manifest = readManifest(TOP_MISS_FIXTURES_DIR);
  const validation = validateManifest(manifest, TOP_MISS_FIXTURES_DIR);

  test('manifest validates', () => {
    expect(validation).toEqual({ ok: true });
  });

  for (const entry of manifest.fixtures) {
    test(`fixture ${entry.id} shape + adapter contract`, () => {
      const html = loadFixtureHtml(TOP_MISS_FIXTURES_DIR, entry.id);
      expect(classifyShape(html)).toBe(entry.shape);

      if (entry.require_high_signal) {
        expect(countJobLikeHrefs(html)).toBeGreaterThanOrEqual(3);
      }

      const baseUrl = entry.base_url && entry.base_url.trim() ? entry.base_url : 'https://example.com';
      const adapted = tryHtmlAdapters(html, baseUrl);
      const n = adapted && Array.isArray(adapted.items) ? adapted.items.length : 0;
      expect(n).toBeGreaterThanOrEqual(entry.expected_min_jobs);

      const violations = assertUrlsMustNotMatch(adapted, entry.must_not_match || []);
      expect(violations).toEqual([]);
    });
  }
});

describe('buildTopMissFixturesReport', () => {
  test('checked-in fixtures produce a clean report', () => {
    const rep = buildTopMissFixturesReport(TOP_MISS_FIXTURES_DIR);
    expect(rep.ok).toBe(true);
    if (!rep.ok) return;
    expect(rep.total).toBeGreaterThanOrEqual(4);
    expect(rep.adapterHit).toBe(0);
    expect(rep.shapeMismatches).toEqual([]);
    expect(rep.highSignalFailures).toEqual([]);
  });
});

describe('assertUrlsMustNotMatch', () => {
  test('returns violations when a URL contains a forbidden fragment', () => {
    const adapted = {
      items: [{ url: 'https://co.example/privacy-policy', job_title: 'x' }],
    };
    expect(assertUrlsMustNotMatch(adapted, ['/privacy'])).toEqual([
      { url: 'https://co.example/privacy-policy', frag: '/privacy' },
    ]);
  });

  test('returns empty array when no items', () => {
    expect(assertUrlsMustNotMatch(null, ['/privacy'])).toEqual([]);
    expect(assertUrlsMustNotMatch({ items: [] }, ['/privacy'])).toEqual([]);
  });
});
