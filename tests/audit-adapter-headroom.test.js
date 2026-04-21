const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildAdapterHeadroomReport,
  compareHeadroomReports,
  evaluateExpansionShipGate,
  loadPreSnapshot,
} = require('../scripts/audit-html-extract-adapter-headroom');

function writeFile(p, content) {
  fs.writeFileSync(p, content, 'utf8');
}

describe('audit-html-extract-adapter-headroom', () => {
  test('computes totals, miss shapes, and high-signal threshold (>=3)', () => {
    const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-headroom-'));
    try {
      const companies = [
        { id: 'hit', name: 'Hit Co', domain: 'hit.example' },
        { id: 'miss-low', name: 'Miss Low' },
        { id: 'miss-high', name: 'Miss High' },
        { id: 'miss-other', name: 'Miss Other', domain: 'other.example' },
        { id: 'json-only', name: 'JSON Co', domain: 'json.example' },
      ];

      // Adapter hit via greenhouse URL.
      writeFile(
        path.join(artifactsDir, 'hit.html'),
        '<html><body><a href="https://boards.greenhouse.io/acme/jobs/123">Engineer</a></body></html>'
      );

      // Miss, shape=wordpress-careers-ish, highSignalCount should stay 0 (only 2 job-like hrefs).
      writeFile(
        path.join(artifactsDir, 'miss-low.html'),
        '<html><body>wordpress <a href="/jobs/a">A</a><a href="/careers/b">B</a></body></html>'
      );

      // Miss, same shape, highSignalCount should increment (3 job-like hrefs).
      // No base URL on company keeps relative links unresolved for adapters, so these remain misses.
      writeFile(
        path.join(artifactsDir, 'miss-high.html'),
        '<html><body>wordpress <a href="/jobs/a">A</a><a href="/jobs/b">B</a><a href="/careers/c">C</a></body></html>'
      );

      // Miss in a different shape.
      writeFile(path.join(artifactsDir, 'miss-other.html'), '<html><body><p>plain page</p></body></html>');

      // Excluded due to sibling json.
      writeFile(path.join(artifactsDir, 'json-only.html'), '<html><body>ignored</body></html>');
      writeFile(path.join(artifactsDir, 'json-only.json'), '{"jobs":[]}');

      const report = buildAdapterHeadroomReport({ companies, artifactsDir });

      expect(report.totalHtmlOnly).toBe(4);
      expect(report.adapterHit).toBe(1);
      expect(report.misses).toBe(3);
      expect(report.adapterCoveragePct).toBe(25);

      expect(report.byShape).toEqual([
        { shape: 'wordpress-careers-ish', count: 2, pctOfMisses: 66.7, highSignalCount: 1 },
        { shape: 'other', count: 1, pctOfMisses: 33.3, highSignalCount: 0 },
      ]);
    } finally {
      fs.rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  test('compareHeadroomReports computes signed deltas', () => {
    const before = {
      totalHtmlOnly: 457,
      adapterHit: 147,
      misses: 310,
      adapterCoveragePct: 32.2,
      byShape: [],
    };
    const after = {
      totalHtmlOnly: 457,
      adapterHit: 161,
      misses: 296,
      adapterCoveragePct: 35.2,
      byShape: [],
    };
    expect(compareHeadroomReports(before, after)).toEqual({
      totalHtmlOnlyBefore: 457,
      totalHtmlOnlyAfter: 457,
      totalHtmlOnlyDelta: 0,
      adapterHitBefore: 147,
      adapterHitAfter: 161,
      adapterHitDelta: 14,
      missesBefore: 310,
      missesAfter: 296,
      missesDelta: -14,
      adapterCoveragePctBefore: 32.2,
      adapterCoveragePctAfter: 35.2,
      adapterCoveragePctDelta: 3,
    });
  });

  test('evaluateExpansionShipGate requires +40 adapter companies and clean fixtures', () => {
    expect(
      evaluateExpansionShipGate({
        htmlAdapterCompaniesBefore: 147,
        htmlAdapterCompaniesAfter: 190,
        fixtureFalsePositiveRegression: false,
      }).pass
    ).toBe(true);

    const failAdapter = evaluateExpansionShipGate({
      htmlAdapterCompaniesBefore: 147,
      htmlAdapterCompaniesAfter: 161,
      fixtureFalsePositiveRegression: false,
    });
    expect(failAdapter.pass).toBe(false);
    expect(failAdapter.adapterOk).toBe(false);
    expect(failAdapter.fixturesOk).toBe(true);
    expect(failAdapter.reasons.some((r) => r.includes('below required'))).toBe(true);

    const failFx = evaluateExpansionShipGate({
      htmlAdapterCompaniesBefore: 100,
      htmlAdapterCompaniesAfter: 200,
      fixtureFalsePositiveRegression: true,
    });
    expect(failFx.pass).toBe(false);
    expect(failFx.fixturesOk).toBe(false);
  });

  test('loadPreSnapshot accepts wrapped or flat headroom JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-snap-'));
    try {
      const flat = path.join(dir, 'flat.json');
      fs.writeFileSync(
        flat,
        JSON.stringify({ totalHtmlOnly: 10, adapterHit: 3, misses: 7, adapterCoveragePct: 30, byShape: [] }),
        'utf8'
      );
      const a = loadPreSnapshot(flat);
      expect(a.htmlAdapterCompanies).toBe(3);
      expect(a.headroom.adapterHit).toBe(3);

      const wrapped = path.join(dir, 'wrapped.json');
      fs.writeFileSync(
        wrapped,
        JSON.stringify({
          htmlAdapterCompanies: 99,
          headroom: { totalHtmlOnly: 5, adapterHit: 2, misses: 3, adapterCoveragePct: 40, byShape: [] },
        }),
        'utf8'
      );
      const b = loadPreSnapshot(wrapped);
      expect(b.htmlAdapterCompanies).toBe(99);
      expect(b.headroom.adapterHit).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns zeros when there are no HTML-only artifacts', () => {
    const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-headroom-empty-'));
    try {
      const companies = [{ id: 'none', name: 'No Artifacts', domain: 'none.example' }];
      const report = buildAdapterHeadroomReport({ companies, artifactsDir });

      expect(report).toEqual({
        totalHtmlOnly: 0,
        adapterHit: 0,
        misses: 0,
        adapterCoveragePct: 0,
        byShape: [],
      });
    } finally {
      fs.rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});
