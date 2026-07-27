// กฎราคา ProductMaster: unitPrice < 1000 เท่านั้นที่กรอกจำนวนได้ (CLAUDE.md §ProductMaster price)
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

test('_canEnterCountQty — boundary at 1000, isDel and missing price always gated', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => [
    _canEnterCountQty({ unitPrice: 999.99 }),
    _canEnterCountQty({ unitPrice: 1000 }),
    _canEnterCountQty({ unitPrice: 1500 }),
    _canEnterCountQty({ unitPrice: 0 }),
    _canEnterCountQty({ unitPrice: null }),
    _canEnterCountQty({ unitPrice: '50' }),      // string is not Number.isFinite → gated
    _canEnterCountQty({ unitPrice: 50, isDel: true }),
    _canEnterCountQty(null),
    _canEnterCountQty(undefined),
  ]);
  expect(out).toEqual([true, false, false, true, false, false, false, false, false]);
  await closeApp(app);
});
