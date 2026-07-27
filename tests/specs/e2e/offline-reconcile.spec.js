// ★ Pending field test #3 (CLAUDE.md): PDA scans offline, comes back online →
// dirty queue + _reconcileScanItems push everything without clobbering other devices.
const { test, expect, closeApp, requireEmulator } = require('../../lib/hooks');
const { bootFreshCount, bootJoinCount, PROJECT_ID } = require('../../lib/scenario');
const { waitForDoc, getDoc } = require('../../lib/emulator');

async function scanTimes(page, barcode, times) {
  await page.evaluate(({ barcode, times }) => {
    for (let i = 0; i < times; i++) scanQueue.push(parseScanLine(barcode));
    drainQueue();
  }, { barcode, times });
}

test.describe('offline → reconcile', () => {
  test.beforeEach(() => requireEmulator());
  test.setTimeout(90_000);

  test('offline scans sync after reconnect; other device\'s items untouched', async ({ browser }) => {
    const a = await bootFreshCount(browser, { role: 'assistant', user: 'PDA-A', mode: 'pda' });
    const b = await bootJoinCount(browser, { role: 'assistant', user: 'PDA-B', mode: 'pda', expectEpoch: a.epoch });

    // baseline: A syncs S-F01 x2 online; B syncs S-F02 x1
    await scanTimes(a.page, 'B-F01', 2);
    await a.page.evaluate(() => _flushDirtySkus());
    await waitForDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-F01', (d) => d && d.countedQty === 2);
    await scanTimes(b.page, 'B-F02', 1);
    await b.page.evaluate(() => _flushDirtySkus());
    const f02Before = await waitForDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-F02', (d) => d && d.countedQty === 1);

    // A goes offline and keeps scanning
    await a.context.setOffline(true);
    await scanTimes(a.page, 'B-F01', 3); // 2 + 3 = 5
    await scanTimes(a.page, 'B-F03', 1); // new SKU while offline
    await a.page.waitForFunction(() => (state.scanData.get('S-F01') || {}).countedQty === 5, null, { polling: 100 });
    await a.page.evaluate(() => _flushDirtySkus().catch(() => {})); // fails → backoff + requeue

    // back online: defeat the backoff window deterministically, then flush
    await a.context.setOffline(false);
    await a.page.evaluate(() => { _scanItemBackoffUntil = 0; _scanItemFailStreak = 0; return _flushDirtySkus(); });

    await waitForDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-F01', (d) => d && d.countedQty === 5, { timeout: 20000 });
    await waitForDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-F03', (d) => d && d.countedQty === 1, { timeout: 20000 });

    // B's item must be exactly as B left it
    const f02After = await getDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-F02');
    expect(f02After.countedQty).toBe(1);
    expect(f02After.rev).toBe(f02Before.rev);
    expect(f02After.updatedBy).toBe(f02Before.updatedBy);

    await closeApp(b);
    await closeApp(a);
  });

  test('safety net: silent mutation missed by _markSkuDirty is re-detected by _reconcileScanItems', async ({ browser }) => {
    const a = await bootFreshCount(browser, { role: 'assistant', user: 'PDA-A', mode: 'pda' });

    await scanTimes(a.page, 'B-F04', 1);
    await a.page.evaluate(() => _flushDirtySkus());
    await waitForDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-F04', (d) => d && d.countedQty === 1);

    // mutate state WITHOUT marking dirty (simulates a mutation site that forgot)
    await a.page.evaluate(() => {
      const sd = state.scanData.get('S-F04');
      sd.countedQty = 9;
      sd.timestamp = '2026-07-27 12:00:00';
    });
    await a.page.evaluate(() => { _reconcileScanItems(); return _flushDirtySkus(); });

    await waitForDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-F04', (d) => d && d.countedQty === 9, { timeout: 20000 });

    await closeApp(a);
  });
});
