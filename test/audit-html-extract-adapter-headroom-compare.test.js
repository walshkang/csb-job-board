const {
  compareHeadroomReports,
  compareTopMissByShape,
  evaluateExpansionShipGate,
} = require('../scripts/audit-html-extract-adapter-headroom');

describe('compareHeadroomReports', () => {
  test('deltas and coverage delta', () => {
    const c = compareHeadroomReports(
      { totalHtmlOnly: 100, adapterHit: 30, misses: 70, adapterCoveragePct: 30 },
      { totalHtmlOnly: 100, adapterHit: 50, misses: 50, adapterCoveragePct: 50 }
    );
    expect(c.adapterHitDelta).toBe(20);
    expect(c.missesDelta).toBe(-20);
    expect(c.adapterCoveragePctDelta).toBe(20);
  });
});

describe('compareTopMissByShape', () => {
  test('null missesBefore when baseline byShape is empty', () => {
    const r = compareTopMissByShape({ byShape: [] }, { byShape: [{ shape: 'other', count: 5 }] });
    expect(r.baselineShapeBreakdownPresent).toBe(false);
    const o = r.topMissRows.find(x => x.shape === 'other');
    expect(o.missesAfter).toBe(5);
    expect(o.missesBefore).toBeNull();
    expect(o.missesDelta).toBeNull();
  });

  test('deltas when baseline has byShape', () => {
    const b = { byShape: [{ shape: 'other', count: 10 }, { shape: 'webflow-dom', count: 3 }] };
    const a = { byShape: [{ shape: 'other', count: 7 }, { shape: 'webflow-dom', count: 3 }] };
    const r = compareTopMissByShape(b, a);
    expect(r.baselineShapeBreakdownPresent).toBe(true);
    const o = r.topMissRows.find(x => x.shape === 'other');
    expect(o.missesBefore).toBe(10);
    expect(o.missesAfter).toBe(7);
    expect(o.missesDelta).toBe(-3);
  });
});

describe('evaluateExpansionShipGate', () => {
  test('pass when delta and fixtures ok', () => {
    const g = evaluateExpansionShipGate({
      htmlAdapterCompaniesBefore: 100,
      htmlAdapterCompaniesAfter: 150,
      fixtureFalsePositiveRegression: false,
    });
    expect(g.pass).toBe(true);
    expect(g.adapterOk).toBe(true);
    expect(g.fixturesOk).toBe(true);
  });

  test('fail on low delta', () => {
    const g = evaluateExpansionShipGate({
      htmlAdapterCompaniesBefore: 147,
      htmlAdapterCompaniesAfter: 151,
    });
    expect(g.pass).toBe(false);
    expect(g.adapterOk).toBe(false);
  });

  test('fail on fixture regression', () => {
    const g = evaluateExpansionShipGate({
      htmlAdapterCompaniesBefore: 0,
      htmlAdapterCompaniesAfter: 100,
      fixtureFalsePositiveRegression: true,
    });
    expect(g.pass).toBe(false);
    expect(g.fixturesOk).toBe(false);
  });
});
