// ★ Pending field test #1 (CLAUDE.md): two PDAs scanning the SAME SKU concurrently —
// the item doc must hold the SUM, never one device's value overwriting the other's.
// Scans are driven through the real queue (scanQueue → drainQueue → handleBarcode); only the
// UI input layer / pharmacy night-hours gate is skipped.
const { test, expect, closeApp, requireEmulator } = require('../../lib/hooks');
const { bootFreshCount, bootJoinCount, PROJECT_ID } = require('../../lib/scenario');
const { waitForDoc } = require('../../lib/emulator');

async function scanTimes(page, barcode, times) {
  await page.evaluate(({ barcode, times }) => {
    for (let i = 0; i < times; i++) scanQueue.push(parseScanLine(barcode));
    drainQueue();
  }, { barcode, times });
}
const localQty = (page, sku) => page.evaluate((s) => (state.scanData.get(s) || {}).countedQty, sku);

test.describe('concurrent same-SKU scanning', () => {
  test.beforeEach(() => requireEmulator());
  test.setTimeout(60_000);

  test('two PDAs scan S-NORM: doc holds the sum and both devices converge', async ({ browser }) => {
    const a = await bootFreshCount(browser, { role: 'assistant', user: 'PDA-A', mode: 'pda' });
    const b = await bootJoinCount(browser, { role: 'assistant', user: 'PDA-B', mode: 'pda', expectEpoch: a.epoch });

    await scanTimes(a.page, 'B-NORM', 3);
    await scanTimes(b.page, 'B-NORM', 4);
    await a.page.waitForFunction(() => (state.scanData.get('S-NORM') || {}).countedQty === 3, null, { polling: 100 });
    await b.page.waitForFunction(() => (state.scanData.get('S-NORM') || {}).countedQty === 4, null, { polling: 100 });

    // force both contended flushes deterministically (skip the 800ms debounce)
    await Promise.all([
      a.page.evaluate(() => _flushDirtySkus()),
      b.page.evaluate(() => _flushDirtySkus()),
    ]);

    const doc = await waitForDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-NORM',
      (d) => d && d.countedQty === 7 && d.status === 'scanning');
    expect(Number(doc.rev)).toBeGreaterThanOrEqual(2);
    expect(doc.countResetAt).toBe(a.epoch);

    // both devices converge to the sum via the items listener
    await a.page.waitForFunction(() => (state.scanData.get('S-NORM') || {}).countedQty === 7, null, { timeout: 15000, polling: 100 });
    await b.page.waitForFunction(() => (state.scanData.get('S-NORM') || {}).countedQty === 7, null, { timeout: 15000, polling: 100 });

    await closeApp(b);
    await closeApp(a);
  });

  test('scans inside the same debounce window still sum (true transaction contention)', async ({ browser }) => {
    const a = await bootFreshCount(browser, { role: 'assistant', user: 'PDA-A', mode: 'pda' });
    const b = await bootJoinCount(browser, { role: 'assistant', user: 'PDA-B', mode: 'pda', expectEpoch: a.epoch });

    // fire near-simultaneously, then flush both without waiting for the timer
    await Promise.all([scanTimes(a.page, 'B-M6', 2), scanTimes(b.page, 'B-M6', 3)]); // x6 multiplier → 12 + 18
    await a.page.waitForFunction(() => (state.scanData.get('S-MULTI') || {}).countedQty === 12, null, { polling: 100 });
    await b.page.waitForFunction(() => (state.scanData.get('S-MULTI') || {}).countedQty === 18, null, { polling: 100 });
    await Promise.all([
      a.page.evaluate(() => _flushDirtySkus()),
      b.page.evaluate(() => _flushDirtySkus()),
    ]);

    await waitForDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-MULTI', (d) => d && d.countedQty === 30);
    expect(await localQty(a.page, 'S-MULTI')).toBeDefined();

    await closeApp(b);
    await closeApp(a);
  });
});
