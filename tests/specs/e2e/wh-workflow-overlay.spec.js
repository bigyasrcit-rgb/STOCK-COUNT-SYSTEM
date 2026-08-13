// Reader-side atomicity for staged WH operations: result documents are invisible while an op is
// preparing; changing one parent document to committed publishes the complete verified set.
const { test, expect, closeApp, requireEmulator } = require('../../lib/hooks');
const { bootFreshCount, PROJECT_ID } = require('../../lib/scenario');
const { adminDb } = require('../../lib/emulator');
const {
  makeWhCountItem,
  makeLegacyCountMarker,
  seedWhWorkflow,
  whConfirmOpPath,
  whConfirmResultPath,
} = require('../../lib/wh-workflow');

test.describe('WH committed-op overlay', () => {
  test.beforeEach(() => requireEmulator());
  test.setTimeout(90_000);

  test('preparing is invisible; committed overlays every result in one render with hash verification', async ({ browser }) => {
    const desk = await bootFreshCount(browser, { branch: 'WH', role: 'supervisor', user: 'มายด์', mode: 'desktop' });
    const one = makeWhCountItem({ sku: 'S-NORM', epoch: desk.epoch, qty: 10, staff: 'มุก' });
    const two = makeWhCountItem({ sku: 'S-F05', epoch: desk.epoch, qty: 3, staff: 'ตั๋ง' });
    await seedWhWorkflow(PROJECT_ID, { items: [one, two] });
    await desk.page.waitForFunction(() => state.scanData.get('S-NORM')?.status === 'scanning' &&
      state.scanData.get('S-F05')?.status === 'scanning', null, { timeout: 20_000, polling: 100 });

    const opId = 'overlay-op-1';
    const confirmedAt = new Date().toISOString();
    const results = {
      'S-NORM': {
        ...makeLegacyCountMarker(one, { status: 'pass', systemQty: 10, confirmedAt }),
        opId, kind: 'count', sku: 'S-NORM', sourceRev: one.rev, sourceAt: one.countAt,
      },
      'S-F05': {
        ...makeLegacyCountMarker(two, { status: 'audit', systemQty: 5, confirmedAt }),
        opId, kind: 'count', sku: 'S-F05', sourceRev: two.rev, sourceAt: two.countAt,
      },
    };
    const candidateHash = await desk.page.evaluate((r) => _whWorkflowHashResults(r), results);

    // Count listener applications and record the only user-observable render state. This avoids a
    // timing sleep and proves the preparing snapshot was actually consumed before the assertion.
    await desk.page.evaluate(() => {
      window.__whOpsApplyCount = 0;
      window.__whRenderedPairs = [];
      // Keep the physical item documents deliberately unmaterialized for this reader test. The
      // dedicated recovery test covers roll-forward; here we prove UI + Dashboard authority comes
      // from the verified committed operation rather than a partially written item cache.
      window.__originalScheduleWhRecovery = window._scheduleWhCommittedOpsRecovery;
      window._scheduleWhCommittedOpsRecovery = () => {};
      const apply = window._applyWhCommittedOpsSnapshot;
      window._applyWhCommittedOpsSnapshot = async function (...args) {
        window.__whOpsApplyCount += 1;
        return apply.apply(this, args);
      };
      const render = window._renderWhWorkflowStateChanges;
      window._renderWhWorkflowStateChanges = function (...args) {
        window.__whRenderedPairs.push([
          state.scanData.get('S-NORM')?.status,
          state.scanData.get('S-F05')?.status,
        ]);
        return render.apply(this, args);
      };
    });

    const db = adminDb(PROJECT_ID);
    const batch = db.batch();
    batch.set(db.doc(whConfirmOpPath(opId)), {
      kind: 'count', state: 'preparing', countResetAt: desk.epoch, staffName: null,
      candidateCount: 2, candidateHash, r01Version: 'R01-TEST-1',
      r16Version: 'R16-WH-TEST-1', r16_103Version: '', owner: 'มายด์',
      createdAt: confirmedAt, committedAt: null,
    });
    for (const [sku, marker] of Object.entries(results)) batch.set(db.doc(whConfirmResultPath(opId, sku)), marker);
    await batch.commit();

    await desk.page.waitForFunction(() => window.__whOpsApplyCount >= 1, null, { timeout: 20_000, polling: 100 });
    expect(await desk.page.evaluate(() => [
      state.scanData.get('S-NORM')?.status,
      state.scanData.get('S-F05')?.status,
      _whCommittedOps.has('overlay-op-1'),
    ])).toEqual(['scanning', 'scanning', false]);

    await db.doc(whConfirmOpPath(opId)).update({ state: 'committed', committedAt: new Date().toISOString() });
    await desk.page.waitForFunction(() => _whCommittedOps.has('overlay-op-1') &&
      state.scanData.get('S-NORM')?.status === 'pass' && state.scanData.get('S-F05')?.status === 'audit',
    null, { timeout: 30_000, polling: 100 });

    const observed = await desk.page.evaluate(() => window.__whRenderedPairs);
    // No render may expose only half the operation. Empty/old pairs are fine; final must be complete.
    expect(observed.some(([a, b]) => (a === 'pass') !== (b === 'audit'))).toBe(false);
    expect(observed.some(([a, b]) => a === 'pass' && b === 'audit')).toBe(true);

    const dashboard = await desk.page.evaluate(async () => {
      const sessionDoc = await _db.collection('stock_sessions').doc('WH').get({ source: 'server' });
      const items = await _loadDashboardItemsForBranch('WH', sessionDoc);
      return {
        one: { status: items['S-NORM']?.status, opId: items['S-NORM']?.whCountOpId },
        two: { status: items['S-F05']?.status, opId: items['S-F05']?.whCountOpId },
      };
    });
    expect(dashboard).toEqual({
      one: { status: 'pass', opId },
      two: { status: 'audit', opId },
    });
    const physicalOne = (await db.doc('stock_sessions/WH/items/S-NORM').get()).data();
    const physicalTwo = (await db.doc('stock_sessions/WH/items/S-F05').get()).data();
    expect([physicalOne.status, physicalTwo.status]).toEqual(['scanning', 'scanning']);

    await closeApp(desk);
  });
});
