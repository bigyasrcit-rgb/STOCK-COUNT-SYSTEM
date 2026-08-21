// Real file-upload path: setInputFiles → parseFile (PapaParse, windows-874 fallback) → loaders → rebuildMaps
// → cloud master docs. Guards the column positions documented in SKILL-data-files.
const { test, expect, closeApp, requireEmulator } = require('../../lib/hooks');
const { bootFreshCount, PROJECT_ID } = require('../../lib/scenario');
const { waitForDoc, getDoc } = require('../../lib/emulator');
const F = require('../../lib/fixtures');

const csv = (name, text) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') });

test.describe('CSV upload path', () => {
  test.beforeEach(() => requireEmulator());
  test.setTimeout(90_000);

  test('Product Branch Master / R01 / R05 upload populates state, skuMap and cloud master docs', async ({ browser }) => {
    // clear:true wipes the emulator; upload (not seed) is what fills the masters here
    const app = await bootFreshCount(browser, { role: 'pharmacist', user: 'Pharm', mode: 'desktop' });
    await app.page.evaluate(() => {
      state.productMasterData = []; state.r01Data = []; state.r05Data = [];
      state.skuMap.clear(); state.barcodeMap.clear(); state.skuDirectMap.clear();
    });

    // CSV carries every row (incl. Col D = D/P/REVIEW); state must end up with the post-filter set only
    await app.page.setInputFiles('#fileProductMaster', csv('pm.csv', F.toPmCsv()));
    await app.page.waitForFunction((n) => state.productMasterData.length === n, F.pmRows.length, { polling: 100 });
    expect(F.pmSourceRows.length).toBeGreaterThan(F.pmRows.length); // fixture really does exercise the filter

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
      catA: state.skuMap.get('S-CATA'),
      catP: state.skuMap.get('S-CATP'),
      catD: state.skuMap.get('S-CATD'),
      reviewInPm: state.productMasterMap.has('S-REVIEW'),
      countableCount: _countableSkus.size,
      countableZero: _countableSkus.has('S-ZERO'),
      countableNeg: _countableSkus.has('S-NEG'),
      countableCatP: _countableSkus.has('S-CATP'),
      countableDel: _countableSkus.has('S-ONLYR01'),
      countableOffice: _countableSkus.has('S-OFFICE'),
      countableDelCat: _countableSkus.has('S-DELCAT'),
      officeSys: state.skuMap.get('S-OFFICE')?.systemQty,
      officeInR01: state.r01Data.some((r) => r.colE === 'S-OFFICE'),
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
    expect(parsed.delItem.isDel).toBe(true);         // in R01 but not in Product Branch Master
    expect(parsed.delItem.unitPrice).toBe(40);       // DEL still gets a price from R05
    expect(parsed.catA.isDel).toBe(false);           // Col D = 'A' stays in the catalog
    expect(parsed.catP.isDel).toBe(true);            // Col D = 'P' dropped from PBM → DEL
    expect(parsed.catD.isDel).toBe(true);            // Col D = 'D' dropped from PBM → DEL
    expect(parsed.catP.isP).toBeUndefined();         // the cat/isP concept is gone
    expect(parsed.reviewInPm).toBe(false);           // Col D = 'REVIEW' still dropped
    expect(parsed.barcodeToSku).toBe('S-MULTI');     // R05 col A → col E
    expect(parsed.multiplier).toBe(24);              // R05 col H

    // Total SKU / Progress set: R01 rows with systemQty !== 0, regardless of PBM membership
    expect(parsed.countableCount).toBe(F.COUNTABLE_COUNT);
    expect(parsed.countableZero).toBe(false);        // G = 0 → ไม่ต้องนับ
    expect(parsed.countableNeg).toBe(true);          // G ติดลบ → ยังต้องนับ
    expect(parsed.countableCatP).toBe(true);         // Col D = P แต่มีสต็อกค้าง → ยังนับ
    expect(parsed.countableDel).toBe(true);          // DEL แท้ที่มีสต็อก → ยังนับ
    // R01 คอลัมน์ P: หมวด "11. …" และ DELETE ไม่นับ แม้มีสต็อก — แต่ยังอยู่ในระบบครบ
    expect(parsed.countableOffice).toBe(false);
    expect(parsed.countableDelCat).toBe(false);
    expect(parsed.officeInR01).toBe(true);           // ไม่ได้ถูกข้ามตอน parse
    expect(parsed.officeSys).toBe(7);                // systemQty จริงยังอยู่ → Confirm ได้ผลถูก

    // uploads push to the cloud master docs the other devices restore from
    await waitForDoc(PROJECT_ID, 'stock_sessions/SRC_pm', (d) => d && JSON.parse(d.data_json).length === F.pmRows.length);
    // ...and must NOT write the legacy shared doc (kept read-only on cloud purely for rollback)
    expect(await getDoc(PROJECT_ID, 'stock_sessions/global_pm')).toBeNull();
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
