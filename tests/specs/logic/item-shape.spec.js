// Item doc round-trip + Confirm change-detection comparators
const { test, expect, bootBare, closeApp } = require('../../lib/hooks');

test('_scanItemFingerprint — key-order invariant, local fields excluded', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => {
    const a = { countedQty: 5, status: 'scanning', timestamp: 't1', scans: [1, 2], retries: 3, manualEditAt: 999 };
    const b = { status: 'scanning', timestamp: 't1', countedQty: 5 }; // different order, no local fields
    const c = { countedQty: 6, status: 'scanning', timestamp: 't1' };
    const d = { countedQty: 5, status: 'scanning', timestamp: 't1', extra: undefined };
    return {
      abEqual: _scanItemFingerprint(a) === _scanItemFingerprint(b),
      acDiffer: _scanItemFingerprint(a) !== _scanItemFingerprint(c),
      adEqual: _scanItemFingerprint(a) === _scanItemFingerprint(d), // undefined skipped
      empty: _scanItemFingerprint(null),
    };
  });
  expect(out.abEqual).toBe(true);
  expect(out.acDiffer).toBe(true);
  expect(out.adEqual).toBe(true);
  expect(out.empty).toBe('');
  await closeApp(app);
});

test('_scanItemToLocal — strips doc meta, preserves this device\'s runtime fields', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => {
    const doc = { sku: 'S1', rev: 4, updatedAt: 'x', updatedBy: 'other', countResetAt: 'E1', status: 'scanning', countedQty: 7 };
    const existing = { retries: 2, scans: [1, 2, 3], manualEditAt: 12345, location: 'A1-01' };
    return { merged: _scanItemToLocal(doc, existing), fresh: _scanItemToLocal(doc, undefined) };
  });
  expect(out.merged.sku).toBeUndefined();
  expect(out.merged.rev).toBeUndefined();
  expect(out.merged.countResetAt).toBeUndefined();
  expect(out.merged.status).toBe('scanning');
  expect(out.merged.countedQty).toBe(7);
  expect(out.merged.retries).toBe(2);          // runtime fields kept — _zeroSysFirstScan reads scans
  expect(out.merged.scans).toEqual([1, 2, 3]);
  expect(out.merged.manualEditAt).toBe(12345);
  expect(out.merged.location).toBe('A1-01');
  expect(out.fresh.retries).toBe(0);
  expect(out.fresh.scans).toEqual([]);
  expect(out.fresh.manualEditAt).toBeUndefined();
  await closeApp(app);
});

test('_sameBranchCount / _sameBranchRecheck — Confirm mid-work change detection', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => {
    const count = { status: 'scanning', countedQty: 5, timestamp: 't1', scannedBy: 'A' };
    const recheck = { status: 'audit', recheckQty: 3, recheckBy: 'Ph', recheckAt: 'r1' };
    return {
      same: _sameBranchCount(count, { ...count }),
      numericCoerce: _sameBranchCount(count, { ...count, countedQty: '5' }),
      qtyChanged: _sameBranchCount(count, { ...count, countedQty: 6 }),
      byChanged: _sameBranchCount(count, { ...count, scannedBy: 'B' }),
      notScanning: _sameBranchCount({ ...count, status: 'audit' }, { ...count, status: 'audit' }),
      reSame: _sameBranchRecheck(recheck, { ...recheck }),
      reQty: _sameBranchRecheck(recheck, { ...recheck, recheckQty: 4 }),
      reBy: _sameBranchRecheck(recheck, { ...recheck, recheckBy: 'X' }),
      reAt: _sameBranchRecheck(recheck, { ...recheck, recheckAt: 'r2' }),
    };
  });
  expect(out.same).toBe(true);
  expect(out.numericCoerce).toBe(true);
  expect(out.qtyChanged).toBe(false);
  expect(out.byChanged).toBe(false);
  expect(out.notScanning).toBe(false);
  expect(out.reSame).toBe(true);
  expect(out.reQty).toBe(false);
  expect(out.reBy).toBe(false);
  expect(out.reAt).toBe(false);
  await closeApp(app);
});

test('_isPreBaselineItem — pharmacy items counted before the R01 baseline are frozen', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => {
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const oldTs = fmt(new Date(Date.now() - 6 * 3600e3));
    const futureTs = fmt(new Date(Date.now() + 6 * 3600e3));

    currentBranch = 'SRC';
    _r01BaselineAt = new Date().toISOString();
    const r = {
      oldItem: _isPreBaselineItem({ timestamp: oldTs }),
      newItem: _isPreBaselineItem({ timestamp: futureTs }),
      noTs: _isPreBaselineItem({}),
      viaFirstScanAt: _isPreBaselineItem({ firstScanAt: oldTs }),
    };
    _r01BaselineAt = '';
    r.noBaseline = _isPreBaselineItem({ timestamp: oldTs });
    currentBranch = 'WH';
    _r01BaselineAt = new Date().toISOString();
    r.whBranch = _isPreBaselineItem({ timestamp: oldTs });
    currentBranch = ''; _r01BaselineAt = '';
    return r;
  });
  expect(out.oldItem).toBe(true);
  expect(out.newItem).toBe(false);
  expect(out.noTs).toBe(false);
  expect(out.viaFirstScanAt).toBe(true);
  expect(out.noBaseline).toBe(false);
  expect(out.whBranch).toBe(false);
  await closeApp(app);
});
