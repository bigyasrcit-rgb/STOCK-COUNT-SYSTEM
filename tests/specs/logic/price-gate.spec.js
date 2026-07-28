// กฎราคา: อ่านจาก R05.106 Col B (ราคาต่อบาร์โค้ด) — ต่ำกว่า 1,000 เท่านั้นที่กรอกจำนวนได้
// ระดับรายการ (ช่อง QTY) ยึดราคาบาร์โค้ดหน่วยเล็กสุด · ระดับสแกนยึดราคาบาร์โค้ดที่ยิงจริง
const { test, expect, bootBare, closeApp } = require('../../lib/hooks');

test('_parseProductMasterPrice — comma/space strip, blanks and garbage → null', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => [
    _parseProductMasterPrice('1,234'),
    _parseProductMasterPrice(' 55 '),
    _parseProductMasterPrice('999.99'),
    _parseProductMasterPrice('0'),
    _parseProductMasterPrice(''),
    _parseProductMasterPrice(null),
    _parseProductMasterPrice(undefined),
    _parseProductMasterPrice('abc'),
    _parseProductMasterPrice('-5'),
  ]);
  expect(out).toEqual([1234, 55, 999.99, 0, null, null, null, null, null]);
  await closeApp(app);
});

test('_canEnterCountQtyPrice — boundary at 1000, missing price always gated', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => [
    _canEnterCountQtyPrice(999.99),
    _canEnterCountQtyPrice(1000),
    _canEnterCountQtyPrice(1500),
    _canEnterCountQtyPrice(0),
    _canEnterCountQtyPrice(null),
    _canEnterCountQtyPrice(undefined),
    _canEnterCountQtyPrice('50'),   // string is not Number.isFinite → gated
    _canEnterCountQtyPrice(-1),
  ]);
  expect(out).toEqual([true, false, false, true, false, false, false, false]);
  await closeApp(app);
});

test('_baseUnitPrice — smallest multiplier wins; ties take the higher price; a missing price gates', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => ({
    tabletOverBox: _baseUnitPrice([{ unitMultiplier: 12, unitPrice: 1500 }, { unitMultiplier: 1, unitPrice: 50 }]),
    onlyBox: _baseUnitPrice([{ unitMultiplier: 12, unitPrice: 1500 }]),
    tieTakesHigher: _baseUnitPrice([{ unitMultiplier: 1, unitPrice: 40 }, { unitMultiplier: 1, unitPrice: 90 }]),
    tieWithMissing: _baseUnitPrice([{ unitMultiplier: 1, unitPrice: 40 }, { unitMultiplier: 1, unitPrice: null }]),
    smallestMissing: _baseUnitPrice([{ unitMultiplier: 12, unitPrice: 20 }, { unitMultiplier: 1, unitPrice: null }]),
    zeroMultiplierTreatedAsOne: _baseUnitPrice([{ unitMultiplier: 0, unitPrice: 70 }]),
    empty: _baseUnitPrice([]),
    nothing: _baseUnitPrice(null),
  }));
  expect(out.tabletOverBox).toBe(50);
  expect(out.onlyBox).toBe(1500);        // ไม่มีหน่วยย่อย → ใช้ราคากล่องตรงๆ (จะถูกบล็อก)
  expect(out.tieTakesHigher).toBe(90);
  expect(out.tieWithMissing).toBeNull();
  expect(out.smallestMissing).toBeNull();
  expect(out.zeroMultiplierTreatedAsOne).toBe(70);
  expect(out.empty).toBeNull();
  expect(out.nothing).toBeNull();
  await closeApp(app);
});

test('_canEnterCountQty — item-level gate follows the derived base-unit price, DEL no longer blocked outright', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => [
    _canEnterCountQty({ unitPrice: 50 }),
    _canEnterCountQty({ unitPrice: 1200 }),
    _canEnterCountQty({ unitPrice: null }),
    _canEnterCountQty({ unitPrice: 50, isDel: true }),   // DEL + ราคาถูก → กรอกได้ (เปลี่ยน ก.ค. 2026)
    _canEnterCountQty({ unitPrice: 1200, isDel: true }),
    _canEnterCountQty(null),
    _canEnterCountQty(undefined),
  ]);
  expect(out).toEqual([true, false, false, true, false, false, false]);
  await closeApp(app);
});
