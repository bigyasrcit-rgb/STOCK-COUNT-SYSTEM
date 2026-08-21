// "SKU ที่ต้องนับ" (_countableSkus) = SKU ใน R01.102 ที่ systemQty ≠ 0 — ตัวเดียวที่อยู่เบื้องหลัง
// ทั้งการ์ด Total SKU และตัวเศษ/ตัวหารของ Progress
//
// สองกับดักที่เทสนี้ล็อกไว้:
//  1) ต้องอ่านจาก state.r01Data (ค่าดิบ) ไม่ใช่ skuMap.systemQty — สาขายา clamp negSys เป็น 0 ไปแล้ว
//     ถ้าใช้ skuMap จะแยก "G=0 จริง (ไม่ต้องนับ)" กับ "G ติดลบ (ต้องนับ)" ไม่ออก
//  2) PBM ไม่มีผลกับชุดนี้ — SKU ที่ Col D=D/P ถูกกรองออกจาก PBM แต่ยังมีสต็อกใน R01 ต้องนับตามปกติ
const { test, expect, bootBare, closeApp } = require('../../lib/hooks');

// สร้างชุดข้อมูลสังเคราะห์ตรงเข้า state แล้วเรียก rebuildMaps() ของจริง (ไม่แตะไฟล์ production)
async function countableFrom(page, { r01, pm }) {
  return page.evaluate(({ r01, pm }) => {
    state.r01Data = r01;
    state.productMasterData = pm;
    state.productMasterMap.clear();
    pm.forEach((r) => state.productMasterMap.set(r.sku, r.productName));
    // R05 ขั้นต่ำให้ rebuildMaps เดินผ่าน early-return ได้ (ต้องมีอย่างน้อย 1 แถว)
    state.r05Data = r01.map((r) => ({ barcode: 'BC-' + r.colE, colE: r.colE, unitName: 'EA', unitMultiplier: 1, unitPrice: 10 }));
    rebuildMaps();
    return { countable: [..._countableSkus].sort(), total: _cachedTotalSku };
  }, { r01, pm });
}

test('_countableSkus — G≠0 เท่านั้นที่นับ, ติดลบยังนับ, PBM ไม่มีผล', async ({ browser }) => {
  const app = await bootBare(browser);
  await app.page.evaluate(() => { currentBranch = 'SRC'; });   // สาขายา → negSys clamp ทำงาน

  const r01 = [
    { colE: 'A-POS', productName: 'positive', systemQty: 5 },
    { colE: 'B-ZERO', productName: 'zero', systemQty: 0 },
    { colE: 'C-NEG', productName: 'negative', systemQty: -3 },
    { colE: 'D-NEGZERO', productName: 'minus zero', systemQty: -0 },
    { colE: 'E-DROPPED', productName: 'col D = P (ไม่อยู่ใน PBM)', systemQty: 2 },
    { colE: 'F-DROPZERO', productName: 'col D = D + สต็อก 0', systemQty: 0 },
  ];
  // PBM มีเฉพาะ 4 ตัวแรก — E/F ถูกกรองออกเพราะ Col D = D/P
  const pm = r01.slice(0, 4).map((r) => ({ sku: r.colE, productName: r.productName, unitPrice: 10 }));

  const out = await countableFrom(app.page, { r01, pm });

  expect(out.countable).toEqual(['A-POS', 'C-NEG', 'E-DROPPED']);
  expect(out.total).toBe(3);
  expect(out.countable).not.toContain('B-ZERO');      // G = 0 → ไม่ต้องนับ
  expect(out.countable).not.toContain('D-NEGZERO');   // -0 === 0 → ไม่ต้องนับ
  expect(out.countable).not.toContain('F-DROPZERO');  // นอก PBM แต่ G = 0 ก็ยังไม่นับ
  expect(out.countable).toContain('E-DROPPED');       // นอก PBM แต่มีสต็อก → ต้องนับ

  // กับดักที่ 1: negSys ถูก clamp เป็น 0 ใน skuMap แล้ว — ยืนยันว่าชุด countable ไม่ได้อ่านจากตรงนั้น
  const neg = await app.page.evaluate(() => state.skuMap.get('C-NEG'));
  expect(neg.systemQty).toBe(0);
  expect(neg.negSys).toBeTruthy();

  await closeApp(app);
});

test('_isNonCountR01Category — เทียบเลขหมวดนำหน้า "11." และคำว่า DELETE', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => [
    _isNonCountR01Category('11. อุปกรณ์สำนักงาน / ค่าใช้จ่าย / ขนส่ง'),
    _isNonCountR01Category('  11.อุปกรณ์สำนักงาน  '),   // ช่องว่าง/วรรคตอนต่างกันก็ยังตัด
    _isNonCountR01Category('12. DELETE'),
    _isNonCountR01Category('delete'),                   // case-insensitive
    _isNonCountR01Category('1. ยา'),                    // หมวดปกติ
    _isNonCountR01Category('110. อะไรสักอย่าง'),         // ขึ้นต้น '11' แต่ไม่ใช่ '11.' → ต้องไม่ตัด
    _isNonCountR01Category(''),
    _isNonCountR01Category(null),
    _isNonCountR01Category(undefined),
  ]);
  expect(out).toEqual([true, true, true, true, false, false, false, false, false]);
  await closeApp(app);
});

test('_countableSkus — หมวดที่ไม่ใช่สินค้า (flag nc) ไม่นับ แม้ G ≠ 0', async ({ browser }) => {
  const app = await bootBare(browser);
  await app.page.evaluate(() => { currentBranch = 'SRC'; });

  const r01 = [
    { colE: 'A-NORMAL', productName: 'ยาปกติ', systemQty: 5 },
    { colE: 'B-OFFICE', productName: 'ปากกา', systemQty: 7, nc: 1 },   // หมวด 11 — ติดธงตอน loadR01
    { colE: 'C-DELETED', productName: 'ของเลิกขาย', systemQty: 9, nc: 1 },
  ];
  const pm = r01.map((r) => ({ sku: r.colE, productName: r.productName, unitPrice: 10 }));
  const out = await countableFrom(app.page, { r01, pm });

  expect(out.countable).toEqual(['A-NORMAL']);
  expect(out.total).toBe(1);

  // แต่ต้องยังอยู่ใน catalog ครบ — สแกนได้ Confirm ได้ผลถูกต้อง
  const office = await app.page.evaluate(() => state.skuMap.get('B-OFFICE'));
  expect(office.systemQty).toBe(7);
  await closeApp(app);
});

test('_countableSkus — ไม่มี R01 = 0 (ไม่ fallback ไปขนาด catalog)', async ({ browser }) => {
  const app = await bootBare(browser);
  await app.page.evaluate(() => { currentBranch = 'SRC'; });

  const out = await countableFrom(app.page, {
    r01: [],
    pm: [{ sku: 'X-1', productName: 'in PBM only', unitPrice: 10 }],
  });

  expect(out.countable).toEqual([]);
  expect(out.total).toBe(0);   // Product Master มีของ แต่ Total SKU ต้องเป็น 0 จริงๆ
  await closeApp(app);
});
