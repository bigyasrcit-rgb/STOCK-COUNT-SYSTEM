// Scan-engine behaviors on a pharmacy PDA: zero-sys first scan, negSys, price gate, unknown barcode, multipliers.
const { test, expect, closeApp, requireEmulator } = require('../../lib/hooks');
const { bootFreshCount, PROJECT_ID } = require('../../lib/scenario');
const { waitForDoc, getDoc } = require('../../lib/emulator');

async function scanOnce(page, line) {
  await page.evaluate((l) => { scanQueue.push(parseScanLine(l)); drainQueue(); }, line);
}
const sd = (page, sku) => page.evaluate((s) => {
  const d = state.scanData.get(s);
  return d ? { countedQty: d.countedQty, status: d.status, scans: (d.scans || []).length } : null;
}, sku);

test.describe('pharmacy scan behaviors', () => {
  test.beforeEach(() => requireEmulator());
  test.setTimeout(60_000);

  test('systemQty=0: first scan records 0 (เช็คแล้วไม่มีของ), further scans add normally', async ({ browser }) => {
    const a = await bootFreshCount(browser, { role: 'assistant', user: 'PDA-A', mode: 'pda' });

    await scanOnce(a.page, 'B-ZERO');
    await a.page.waitForFunction(() => state.scanData.get('S-ZERO')?.status === 'scanning', null, { polling: 100 });
    expect(await sd(a.page, 'S-ZERO')).toEqual({ countedQty: 0, status: 'scanning', scans: 1 });

    await scanOnce(a.page, 'B-ZERO');
    await a.page.waitForFunction(() => state.scanData.get('S-ZERO')?.countedQty === 1, null, { polling: 100 });
    await scanOnce(a.page, 'B-ZERO');
    await a.page.waitForFunction(() => state.scanData.get('S-ZERO')?.countedQty === 2, null, { polling: 100 });

    await a.page.evaluate(() => _flushDirtySkus());
    await waitForDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-ZERO', (d) => d && d.countedQty === 2 && d.status === 'scanning');
    await closeApp(a);
  });

  test('negSys (systemQty<0): clamped to 0 in skuMap, first scan records 0', async ({ browser }) => {
    const a = await bootFreshCount(browser, { role: 'assistant', user: 'PDA-A', mode: 'pda' });

    const info = await a.page.evaluate(() => state.skuMap.get('S-NEG'));
    expect(info.systemQty).toBe(0);
    expect(info.negSys).toBeTruthy();

    await scanOnce(a.page, 'B-NEG');
    await a.page.waitForFunction(() => state.scanData.get('S-NEG')?.status === 'scanning', null, { polling: 100 });
    expect((await sd(a.page, 'S-NEG')).countedQty).toBe(0);
    await scanOnce(a.page, 'B-NEG');
    await a.page.waitForFunction(() => state.scanData.get('S-NEG')?.countedQty === 1, null, { polling: 100 });
    await closeApp(a);
  });

  test('price gate: barcode,qty rejected for ≥1000฿ and missing-price barcodes; allowed under 1000฿', async ({ browser }) => {
    const a = await bootFreshCount(browser, { role: 'assistant', user: 'PDA-A', mode: 'pda' });

    // expensive barcode: plain scan works, typed qty is rejected
    await scanOnce(a.page, 'B-PRICEY');
    await a.page.waitForFunction(() => state.scanData.get('S-PRICEY')?.countedQty === 1, null, { polling: 100 });
    await scanOnce(a.page, 'B-PRICEY,50');
    await a.page.waitForTimeout(300); // reject path leaves state untouched
    expect((await sd(a.page, 'S-PRICEY')).countedQty).toBe(1);

    // barcode with no price in R05: same gating
    await scanOnce(a.page, 'B-NOPRICE,50');
    await a.page.waitForTimeout(300);
    const noPrice = await sd(a.page, 'S-NOPRICE');
    expect(noPrice === null || noPrice.countedQty === 0).toBeTruthy();

    // cheap barcode: typed qty accepted
    await scanOnce(a.page, 'B-NORM,5');
    await a.page.waitForFunction(() => state.scanData.get('S-NORM')?.countedQty === 5, null, { polling: 100 });

    await closeApp(a);
  });

  test('price is per barcode: cheap tablet takes a qty, expensive box of the SAME item does not', async ({ browser }) => {
    const a = await bootFreshCount(browser, { role: 'assistant', user: 'PDA-A', mode: 'pda' });

    // S-NORM: B-NORM (เม็ด 50฿) กรอกได้ · B-NORM-BOX (กล่อง 1,500฿) ต้องยิงทีละกล่อง
    await scanOnce(a.page, 'B-NORM,4');
    await a.page.waitForFunction(() => state.scanData.get('S-NORM')?.countedQty === 4, null, { polling: 100 });

    await scanOnce(a.page, 'B-NORM-BOX,2');
    await a.page.waitForTimeout(300);
    expect((await sd(a.page, 'S-NORM')).countedQty).toBe(4); // ปฏิเสธ — ยอดไม่ขยับ

    await scanOnce(a.page, 'B-NORM-BOX');   // ยิงเปล่ายังได้ +12 ตามตัวคูณ
    await a.page.waitForFunction(() => state.scanData.get('S-NORM')?.countedQty === 16, null, { polling: 100 });

    // ช่อง QTY ระดับรายการยึดราคาหน่วยเล็กสุด (เม็ด 50฿) → ยังกรอกได้แม้จะมีบาร์โค้ดกล่องแพง
    const canEdit = await a.page.evaluate(() => _canEnterCountQty(state.skuMap.get('S-NORM')));
    expect(canEdit).toBe(true);
    expect(await a.page.evaluate(() => state.skuMap.get('S-NORM').unitPrice)).toBe(50);

    await closeApp(a);
  });

  test('DEL item with a cheap barcode may take a qty (rule now follows R05 price, not ProductMaster)', async ({ browser }) => {
    const a = await bootFreshCount(browser, { role: 'assistant', user: 'PDA-A', mode: 'pda' });

    const info = await a.page.evaluate(() => state.skuMap.get('S-ONLYR01'));
    expect(info.isDel).toBe(true);
    expect(info.unitPrice).toBe(40);

    await scanOnce(a.page, 'B-ONLYR01,3');
    await a.page.waitForFunction(() => state.scanData.get('S-ONLYR01')?.countedQty === 3, null, { polling: 100 });

    await closeApp(a);
  });

  test('multiplier barcodes add unit-multiplied quantities', async ({ browser }) => {
    const a = await bootFreshCount(browser, { role: 'assistant', user: 'PDA-A', mode: 'pda' });
    await scanOnce(a.page, 'B-M24');
    await a.page.waitForFunction(() => state.scanData.get('S-MULTI')?.countedQty === 24, null, { polling: 100 });
    await scanOnce(a.page, 'B-M1');
    await a.page.waitForFunction(() => state.scanData.get('S-MULTI')?.countedQty === 25, null, { polling: 100 });
    await closeApp(a);
  });

  test('unknown barcode goes to unknownScans, never creates an item doc', async ({ browser }) => {
    const a = await bootFreshCount(browser, { role: 'assistant', user: 'PDA-A', mode: 'pda' });
    await scanOnce(a.page, 'ZZZ-NOPE');
    await a.page.waitForFunction(() => state.unknownScans.length > 0, null, { polling: 100 });
    const unknown = await a.page.evaluate(() => state.unknownScans[0]);
    expect(unknown.barcode).toBe('ZZZ-NOPE');
    await a.page.evaluate(() => _flushDirtySkus());
    expect(await getDoc(PROJECT_ID, 'stock_sessions/SRC/items/ZZZ-NOPE')).toBeNull();
    await closeApp(a);
  });
});
