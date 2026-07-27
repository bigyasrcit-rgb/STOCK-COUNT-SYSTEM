// _applyCloudScanData merge rules — the function CLAUDE.md forbids simplifying without these exact scenarios.
// Same-epoch merges only (epoch adoption is covered in e2e via real session sync).
const { test, expect, bootBare, closeApp } = require('../../lib/hooks');

const EPOCH = '2026-07-27T00:00:00.000Z';

async function bootMerge(browser) {
  const app = await bootBare(browser);
  await app.page.evaluate((epoch) => {
    currentBranch = 'SRC';
    currentRole = 'pharmacist';
    _countResetAt = epoch;
    _pharmacyAuditMarkerData = { branch: 'SRC', countResetAt: epoch, items: {} };
    state.scanData.clear();
    state.unknownScans = [];
  }, EPOCH);
  return app;
}

function cloudBlob(scanData, extra = {}) {
  return { countResetAt: EPOCH, scanData, unknownScans: [], ...extra };
}

test('fresh manualEditAt protects local from a stale cloud snapshot', async ({ browser }) => {
  const app = await bootMerge(browser);
  const out = await app.page.evaluate((blob) => {
    state.scanData.set('S1', { status: 'scanning', countedQty: 400, timestamp: 't2', scannedBy: 'Me', manualEditAt: Date.now(), scans: [], retries: 0 });
    _applyCloudScanData(blob);
    return state.scanData.get('S1');
  }, cloudBlob({ S1: { status: 'scanning', countedQty: 500, timestamp: 't1', scannedBy: 'Other' } }));
  expect(out.countedQty).toBe(400); // เพิ่งแก้เอง — cloud เก่าห้ามทับ
  await closeApp(app);
});

test('both scanning without fresh edit: higher countedQty wins, lower is ignored', async ({ browser }) => {
  const app = await bootMerge(browser);
  const out = await app.page.evaluate((blobs) => {
    const stale = Date.now() - 60000;
    state.scanData.set('S1', { status: 'scanning', countedQty: 400, timestamp: 't2', scannedBy: 'Me', manualEditAt: stale, scans: [], retries: 0 });
    state.scanData.set('S2', { status: 'scanning', countedQty: 400, timestamp: 't2', scannedBy: 'Me', manualEditAt: stale, scans: [], retries: 0 });
    _applyCloudScanData(blobs.higher);
    _applyCloudScanData(blobs.lower);
    return { s1: state.scanData.get('S1').countedQty, s2: state.scanData.get('S2').countedQty };
  }, {
    higher: cloudBlob({ S1: { status: 'scanning', countedQty: 500, timestamp: 't1', scannedBy: 'Other' } }),
    lower: cloudBlob({ S2: { status: 'scanning', countedQty: 300, timestamp: 't1', scannedBy: 'Other' } }),
  });
  expect(out.s1).toBe(500);
  expect(out.s2).toBe(400);
  await closeApp(app);
});

test('cloud pending never overwrites local scanning', async ({ browser }) => {
  const app = await bootMerge(browser);
  const out = await app.page.evaluate((blob) => {
    state.scanData.set('S1', { status: 'scanning', countedQty: 7, timestamp: 't2', scannedBy: 'Me', scans: [], retries: 0 });
    _applyCloudScanData(blob);
    return state.scanData.get('S1');
  }, cloudBlob({ S1: { status: 'pending', countedQty: 0, timestamp: '', scannedBy: '' } }));
  expect(out.status).toBe('scanning');
  expect(out.countedQty).toBe(7);
  await closeApp(app);
});

test('cloud audit worklist wins over local non-audit; verified local (auditor) is authoritative', async ({ browser }) => {
  const app = await bootMerge(browser);
  const out = await app.page.evaluate((blob) => {
    state.scanData.set('S1', { status: 'pass', countedQty: 5, timestamp: 't1', scannedBy: 'Me', scans: [], retries: 0 });
    state.scanData.set('S2', { status: 'pass', countedQty: 5, timestamp: 't1', scannedBy: 'Me', auditor: 'Pharm', scans: [], retries: 0 });
    _applyCloudScanData(blob);
    return { s1: state.scanData.get('S1').status, s2: state.scanData.get('S2').status };
  }, cloudBlob({
    S1: { status: 'audit', countedQty: 5, timestamp: 't2', scannedBy: 'Other' },
    S2: { status: 'audit', countedQty: 5, timestamp: 't2', scannedBy: 'Other' }, // no auditor → must NOT clobber verified pass
  }));
  expect(out.s1).toBe('audit');
  expect(out.s2).toBe('pass');
  await closeApp(app);
});

test('unknownScans merge by barcode without duplicates', async ({ browser }) => {
  const app = await bootMerge(browser);
  const out = await app.page.evaluate((epoch) => {
    state.unknownScans = [{ barcode: 'X1', qty: 1 }];
    _applyCloudScanData({ countResetAt: epoch, scanData: {}, unknownScans: [{ barcode: 'X1', qty: 9 }, { barcode: 'X2', qty: 2 }] });
    return state.unknownScans;
  }, EPOCH);
  expect(out.map((u) => u.barcode).sort()).toEqual(['X1', 'X2']);
  expect(out.find((u) => u.barcode === 'X1').qty).toBe(1); // ของเดิมเครื่องนี้คงไว้
  await closeApp(app);
});
