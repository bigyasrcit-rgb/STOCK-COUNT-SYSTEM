const { test, expect, bootBare, closeApp } = require('../../lib/hooks');

test('parseScanLine — every input shape', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => {
    const cases = [
      'A1-01,8850001,5',      // 3-part: location,barcode,qty
      'A1,B2,abc',            // 3-part with non-numeric qty → 0
      '8850001,5',            // 2-part numeric → barcode,qty
      '8850001,2.5',          // decimal qty
      'A1-01,B-NORM',         // 2-part with non-numeric 2nd part → location,barcode
      '8850001',              // bare barcode
      ' 8850001 , 5 ',        // trims
    ];
    return cases.map((c) => parseScanLine(c));
  });
  expect(out[0]).toEqual({ location: 'A1-01', barcode: '8850001', qty: 5 });
  expect(out[1]).toEqual({ location: 'A1', barcode: 'B2', qty: 0 });
  expect(out[2]).toEqual({ location: '', barcode: '8850001', qty: 5 });
  expect(out[3]).toEqual({ location: '', barcode: '8850001', qty: 2.5 });
  expect(out[4]).toEqual({ location: 'A1-01', barcode: 'B-NORM', qty: null });
  expect(out[5]).toEqual({ location: '', barcode: '8850001', qty: null });
  expect(out[6]).toEqual({ location: '', barcode: '8850001', qty: 5 });
  await closeApp(app);
});
