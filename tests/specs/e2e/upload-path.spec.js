// Real file-upload path: setInputFiles → parseFile (PapaParse, windows-874 fallback) → loaders → rebuildMaps
// → cloud master docs. Guards the column positions documented in SKILL-data-files.
const { test, expect, closeApp, requireEmulator } = require('../../lib/hooks');
const { bootFreshCount, PROJECT_ID } = require('../../lib/scenario');
const { waitForDoc } = require('../../lib/emulator');
const F = require('../../lib/fixtures');

const csv = (name, text) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') });

test.describe('CSV upload path', () => {
  test.beforeEach(() => requireEmulator());
  test.setTimeout(90_000);

  test('ProductMaster / R01 / R05 upload populates state, skuMap and cloud master docs', async ({ browser }) => {
    // clear:true wipes the emulator; upload (not seed) is what fills the masters here
    const app = await bootFreshCount(browser, { role: 'pharmacist', user: 'Pharm', mode: 'desktop' });
    await app.page.evaluate(() => {
      state.productMasterData = []; state.r01Data = []; state.r05Data = [];
      state.skuMap.clear(); state.barcodeMap.clear(); state.skuDirectMap.clear();
    });

    await app.page.setInputFiles('#fileProductMaster', csv('pm.csv', F.toPmCsv()));
    await app.page.waitForFunction((n) => state.productMasterData.length === n, F.pmRows.length, { polling: 100 });

    await app.page.setInputFiles('#fileR01', csv('r01.csv', F.toR01Csv()));
    await app.page.waitForFunction((n) => state.r01Data.length === n, F.r01Rows.length, { polling: 100 });

    await app.page.setInputFiles('#fileR05', csv('r05.csv', F.toR05Csv()));
    await app.page.waitForFunction((n) => state.r05Data.length === n, F.r05Rows.length, { polling: 100 });

    const parsed = await app.page.evaluate(() => ({
      norm: state.skuMap.get('S-NORM'),
      normBox: state.skuMap.get('S-NORM').barcodes.find((b) => b.barcode === 'B-NORM-BOX'),
      pricey: state.skuMap.get('S-PRICEY'),
      noPrice: state.skuMap.get('S-NOPRICE'),
      neg: state.skuMap.get('S-NEG'),
      delItem: state.skuMap.get('S-ONLYR01'),
      catP: state.skuMap.get('S-CATP'),
      barcodeToSku: state.barcodeMap.get('B-M24'),
      multiplier: (state.skuMap.get('S-MULTI').barcodes.find((b) => b.barcode === 'B-M24') || {}).unitMultiplier,
    }));

    expect(parsed.norm.unitPrice).toBe(50);          // R05 col B of the smallest-unit barcode
    expect(parsed.normBox.unitPrice).toBe(1500);     // per-barcode price kept alongside the multiplier
    expect(parsed.norm.systemQty).toBe(10);          // R01 col G
    expect(parsed.pricey.unitPrice).toBe(1500);
    expect(parsed.noPrice.unitPrice).toBeNull();     // blank price → null → must scan one by one
    expect(parsed.neg.systemQty).toBe(0);            // pharmacy clamps negative to 0
    expect(parsed.neg.negSys).toBeTruthy();
    expect(parsed.delItem.isDel).toBe(true);         // in R01 but not in ProductMaster
    expect(parsed.delItem.unitPrice).toBe(40);       // DEL still gets a price from R05
    expect(parsed.catP.isP).toBe(true);              // PM col D = 'P'
    expect(parsed.barcodeToSku).toBe('S-MULTI');     // R05 col A → col E
    expect(parsed.multiplier).toBe(24);              // R05 col H

    // uploads push to the cloud master docs the other devices restore from
    await waitForDoc(PROJECT_ID, 'stock_sessions/global_pm', (d) => d && JSON.parse(d.data_json).length === F.pmRows.length);
    await waitForDoc(PROJECT_ID, 'stock_sessions/SRC_r01', (d) => d && d.data_json && JSON.parse(d.data_json).length === F.r01Rows.length);
    await waitForDoc(PROJECT_ID, 'stock_sessions/global_r05', (d) => d && JSON.parse(d.data_json).length === F.r05Rows.length);

    await closeApp(app);
  });

  test('R01 upload on a pharmacy branch clears R16 and sets a new baseline', async ({ browser }) => {
    const app = await bootFreshCount(browser, { role: 'pharmacist', user: 'Pharm', mode: 'desktop' });
    await app.page.evaluate(() => {
      state.r16Loaded = true;
      state.r16DetailVersion = 'R16-OLD';
      state.r16SalesMap.set('S-NORM', 5);
    });

    await app.page.setInputFiles('#fileR01', csv('r01.csv', F.toR01Csv()));
    await app.page.waitForFunction(() => state.r16Loaded === false, null, { timeout: 15000, polling: 100 });

    const after = await app.page.evaluate(() => ({
      baseline: _r01BaselineAt,
      sales: state.r16SalesMap.size,
      version: state.r01Version,
    }));
    expect(after.baseline).toBeTruthy();   // pharmacy baseline stamped
    expect(after.sales).toBe(0);           // yesterday's R16 cleared — must re-upload before Confirm
    expect(after.version).toBeTruthy();

    await closeApp(app);
  });
});
