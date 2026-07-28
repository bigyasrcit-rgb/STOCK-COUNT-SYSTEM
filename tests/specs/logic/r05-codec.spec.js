// R05 ขึ้น cloud เป็น array-of-arrays เพราะ object form ทำให้ 10,600 บาร์โค้ดชนเพดาน 1 MiB
// (ของจริงเคยขึ้น 1,069 KB แล้ว Firestore ปฏิเสธเงียบๆ — listener ดึงของเก่ากลับมาทับ)
const { test, expect, bootBare, closeApp } = require('../../lib/hooks');

test('_serializeR05 / _parseR05Json — round-trip keeps every field', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => {
    const rows = [
      { barcode: 'B1', colE: 'S1', unitName: 'กล่อง', unitMultiplier: 12, unitPrice: 1500 },
      { barcode: 'B2', colE: 'S1', unitName: 'TAB', unitMultiplier: 1, unitPrice: 0 },
      { barcode: 'B3', colE: 'S2', unitName: '', unitMultiplier: 1, unitPrice: null },
    ];
    return { json: _serializeR05(rows), parsed: _parseR05Json(_serializeR05(rows)) };
  });
  expect(out.json.startsWith('[[')).toBe(true);          // compact form, not objects
  expect(out.json).not.toContain('unitMultiplier');      // field names must not be repeated per row
  expect(out.parsed).toEqual([
    { barcode: 'B1', colE: 'S1', unitName: 'กล่อง', unitMultiplier: 12, unitPrice: 1500 },
    { barcode: 'B2', colE: 'S1', unitName: 'TAB', unitMultiplier: 1, unitPrice: 0 },
    { barcode: 'B3', colE: 'S2', unitName: '', unitMultiplier: 1, unitPrice: null },
  ]);
  await closeApp(app);
});

test('_parseR05Json — still reads the legacy object form written before the compact cutover', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => _parseR05Json(JSON.stringify([
    { barcode: 'B1', colE: 'S1', unitName: 'TAB', unitMultiplier: 1 },            // pre-price doc
    { barcode: 'B2', colE: 'S2', unitName: 'BOX', unitMultiplier: 6, unitPrice: 900 },
    { barcode: '', colE: 'S3', unitName: 'X', unitMultiplier: 1 },                 // junk row dropped
  ])));
  expect(out).toEqual([
    { barcode: 'B1', colE: 'S1', unitName: 'TAB', unitMultiplier: 1, unitPrice: null }, // no price → gated
    { barcode: 'B2', colE: 'S2', unitName: 'BOX', unitMultiplier: 6, unitPrice: 900 },
  ]);
  await closeApp(app);
});

test('compact form is small enough for a real 10,600-barcode catalog', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => {
    const rows = [];
    for (let i = 0; i < 10619; i++) {
      rows.push({ barcode: '88500000' + String(i).padStart(5, '0'), colE: String(100000 + i), unitName: 'กล่อง', unitMultiplier: 1, unitPrice: 72 });
    }
    const compact = _sessionBlobBytes(_serializeR05(rows));
    const legacy = _sessionBlobBytes(JSON.stringify(rows));
    return { compact, legacy, limit: SESSION_BLOB_LIMIT_BYTES };
  });
  expect(out.legacy).toBeGreaterThan(out.limit);   // ยืนยันว่ารูปแบบเดิมชนเพดานจริง
  expect(out.compact).toBeLessThan(out.limit * 0.7);
  await closeApp(app);
});
