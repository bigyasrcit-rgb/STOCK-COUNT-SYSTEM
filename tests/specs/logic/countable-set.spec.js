// "SKU ที่ต้องนับ" (_countableSkus) = มีแถวใน R01.102 · หมวด Col P ไม่ใช่ 11./DELETE
//                                     และ ( G ≠ 0  หรือ  Col D ใน PBM ∈ {A,B,C} )
// ตัวเดียวที่อยู่เบื้องหลังทั้งการ์ด Total SKU และตัวเศษ/ตัวหารของ Progress
//
// กับดักที่เทสนี้ล็อกไว้:
//  1) A/B/C ที่ระบบขึ้นสต็อก 0 ต้อง "นับ" — คือทั้งหมดของกติกาที่เพิ่มมา ส.ค. 2026
//  2) เงื่อนไข A/B/C มีแต่เพิ่ม ไม่มีทางตัดออก → PBM ไฟล์เก่าที่ไม่มี `cat` ต้องได้ผลเท่ากติกาเดิมเป๊ะ
//     (ถ้าใครเผลอเปลี่ยน OR เป็น AND ทุกสาขาที่ยังไม่อัป PBM จะได้ Total SKU = 0 ทันที)
//  3) หมวดใน R01 (ธง nc) ชนะทั้งสองข้อเสมอ
//  4) ต้องอ่าน G จาก state.r01Data (ค่าดิบ) ไม่ใช่ skuMap.systemQty ที่ clamp negSys เป็น 0 แล้ว
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

test('_isAbcColD — เทียบเป๊ะเฉพาะ A/B/C', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => [
    _isAbcColD('A'), _isAbcColD('B'), _isAbcColD('C'),
    _isAbcColD(' a '),        // trim + uppercase
    _isAbcColD('D'), _isAbcColD('P'), _isAbcColD('REVIEW'),
    _isAbcColD('N'), _isAbcColD('E'),   // ค่าอื่นที่รอด filter → ไม่นับ
    _isAbcColD('AB'), _isAbcColD('A1'),
    _isAbcColD(''), _isAbcColD(null), _isAbcColD(undefined),
  ]);
  expect(out).toEqual([
    true, true, true, true,
    false, false, false,
    false, false,
    false, false,
    false, false, false,
  ]);
  await closeApp(app);
});

test('_countableSkus — ตาราง P1–P8: นับเมื่อ G ≠ 0 หรือ Col D เป็น A/B/C', async ({ browser }) => {
  const app = await bootBare(browser);
  await app.page.evaluate(() => { currentBranch = 'SRC'; });   // สาขายา → negSys clamp ทำงาน

  const r01 = [
    { colE: 'P1-ABC-STOCK', productName: 'A + มีของ', systemQty: 5 },
    { colE: 'P2-ABC-ZERO', productName: 'A + ระบบขึ้น 0', systemQty: 0 },
    { colE: 'P3-NOCAT-STOCK', productName: 'Col D ว่าง + มีของ', systemQty: 5 },
    { colE: 'P4-NOCAT-ZERO', productName: 'Col D ว่าง + 0', systemQty: 0 },
    { colE: 'P5-DROPPED', productName: 'Col D = D (ถูกกรองออกจาก PBM)', systemQty: 5 },
    { colE: 'P6-NOTINPM', productName: 'ไม่มีใน PBM', systemQty: 5 },
    { colE: 'P8-NONCOUNT', productName: 'A แต่หมวด 11.', systemQty: 5, nc: 1 },
    { colE: 'P9-ABC-NEG', productName: 'B + ระบบติดลบ', systemQty: -3 },
  ];
  const pm = [
    { sku: 'P1-ABC-STOCK', productName: 'A + มีของ', unitPrice: 10, cat: 'A' },
    { sku: 'P2-ABC-ZERO', productName: 'A + ระบบขึ้น 0', unitPrice: 10, cat: 'A' },
    { sku: 'P3-NOCAT-STOCK', productName: 'Col D ว่าง + มีของ', unitPrice: 10 },
    { sku: 'P4-NOCAT-ZERO', productName: 'Col D ว่าง + 0', unitPrice: 10 },
    // P5 / P6 ไม่อยู่ใน PBM (P5 ถูก parser กรองทิ้งตั้งแต่ตอนอ่านไฟล์)
    { sku: 'P7-PMONLY', productName: 'A แต่ไม่มีแถวใน R01', unitPrice: 10, cat: 'A' },
    { sku: 'P8-NONCOUNT', productName: 'A แต่หมวด 11.', unitPrice: 10, cat: 'A' },
    { sku: 'P9-ABC-NEG', productName: 'B + ระบบติดลบ', unitPrice: 10, cat: 'B' },
  ];

  const out = await countableFrom(app.page, { r01, pm });

  expect(out.countable).toEqual([
    'P1-ABC-STOCK', 'P2-ABC-ZERO', 'P3-NOCAT-STOCK', 'P5-DROPPED', 'P6-NOTINPM', 'P9-ABC-NEG',
  ]);
  expect(out.total).toBe(6);
  expect(out.countable).toContain('P2-ABC-ZERO');           // P2 — เคสหลักที่กติกานี้เพิ่มเข้ามา
  expect(out.countable).toContain('P3-NOCAT-STOCK');        // P3 — มีของ → ยังต้องนับแม้ไม่จัดชั้น
  expect(out.countable).toContain('P5-DROPPED');            // P5 — Col D = D แต่มีของ → ยังต้องนับ
  expect(out.countable).toContain('P6-NOTINPM');            // P6 — ไม่มีใน PBM แต่มีของ → ยังต้องนับ
  expect(out.countable).not.toContain('P4-NOCAT-ZERO');     // P4 — ไม่จัดชั้น + ไม่มีของ = ไม่ต้องนับ
  expect(out.countable).not.toContain('P7-PMONLY');         // P7 — ไม่มีแถวใน R01
  expect(out.countable).not.toContain('P8-NONCOUNT');       // P8 — หมวด R01 ชนะ Col D

  // ของที่หลุดจาก Progress ต้องยังอยู่ในแคตตาล็อกครบ — สแกนได้ Confirm ได้ผลถูกต้อง
  const kept = await app.page.evaluate(() => ({
    nocatZero: state.skuMap.get('P4-NOCAT-ZERO')?.systemQty,
    nonCount: state.skuMap.get('P8-NONCOUNT')?.systemQty,
  }));
  expect(kept).toEqual({ nocatZero: 0, nonCount: 5 });

  // กับดัก negSys clamp: countable ต้องไม่ได้ตัดสินจาก skuMap.systemQty
  const neg = await app.page.evaluate(() => state.skuMap.get('P9-ABC-NEG'));
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

// นี่คือทางเดินจริงของทุกสาขาจนกว่าจะอัป PBM ใหม่ — ถ้าพัง Total SKU กลายเป็น 0 ทั้งระบบทันทีที่ deploy
test('_countableSkus — PBM ไม่มี Col D → ได้ผลเท่ากติกาเดิม G ≠ 0 เป๊ะ', async ({ browser }) => {
  const app = await bootBare(browser);
  await app.page.evaluate(() => { currentBranch = 'SRC'; });

  const r01 = [
    { colE: 'A-POS', productName: 'มีของ', systemQty: 5 },
    { colE: 'B-ZERO', productName: 'สต็อก 0', systemQty: 0 },
    { colE: 'C-NEG', productName: 'ติดลบ', systemQty: -3 },
    { colE: 'D-NEGZERO', productName: 'minus zero', systemQty: -0 },
    { colE: 'E-NONCOUNT', productName: 'หมวด 11.', systemQty: 4, nc: 1 },
  ];
  const pmNoCat = r01.map((r) => ({ sku: r.colE, productName: r.productName, unitPrice: 10 }));

  const legacy = await countableFrom(app.page, { r01, pm: pmNoCat });
  expect(legacy.countable).toEqual(['A-POS', 'C-NEG']);
  expect(legacy.total).toBe(2);
  expect(legacy.countable).not.toContain('D-NEGZERO');   // -0 === 0
  expect(legacy.countable).not.toContain('E-NONCOUNT');  // หมวด R01 ยังชนะ

  // ไม่มี PBM เลยก็ต้องได้ชุดเดียวกัน (สาขาที่ badge ขึ้น "ยังไม่โหลด")
  const noPm = await countableFrom(app.page, { r01, pm: [] });
  expect(noPm.countable).toEqual(['A-POS', 'C-NEG']);
  expect(noPm.total).toBe(2);

  await closeApp(app);
});

// ปุ่ม 🗑️ DEL ในรายการสต็อกสินค้าเป็น "งานที่ต้องเดินไปหา" ไม่ใช่รายงานสินค้านอกแคตตาล็อกทั้งหมด
// จึงต้องกรองด้วย _countableSkus ด้วย · แท็ก DEL แดงในตารางยังขึ้นครบทุกตัวเหมือนเดิม
test('filter DEL — โชว์เฉพาะ DEL ที่อยู่ในชุดที่ต้องนับ', async ({ browser }) => {
  const app = await bootBare(browser);
  await app.page.evaluate(() => { currentBranch = 'SRC'; });

  const r01 = [
    { colE: 'D-STOCK', productName: 'DEL ที่ยังมีของ', systemQty: 4 },
    { colE: 'D-EMPTY', productName: 'DEL ที่ของหมดแล้ว', systemQty: 0 },
    { colE: 'D-NONCOUNT', productName: 'DEL หมวด 11.', systemQty: 4, nc: 1 },
    { colE: 'IN-PM', productName: 'อยู่ใน PBM ปกติ', systemQty: 4 },
  ];
  // มีแค่ IN-PM ใน PBM → อีก 3 ตัวเป็น DEL
  const pm = [{ sku: 'IN-PM', productName: 'อยู่ใน PBM ปกติ', unitPrice: 10, cat: 'A' }];

  await countableFrom(app.page, { r01, pm });

  const out = await app.page.evaluate(() => {
    invalidatePopupRowsCache();
    popupFilterState = 'del';
    const del = getFilteredPopupRows().map((r) => r.sku).sort();
    popupFilterState = 'all';
    invalidatePopupRowsCache();
    const allDelTags = buildPopupBaseRows().filter((r) => r.isDel).map((r) => r.sku).sort();
    return { del, allDelTags };
  });

  expect(out.del).toEqual(['D-STOCK']);                              // เหลือตัวที่ต้องไปนับจริง
  expect(out.allDelTags).toEqual(['D-EMPTY', 'D-NONCOUNT', 'D-STOCK']); // แท็กแดงยังครบทั้ง 3

  await closeApp(app);
});

// ปุ่ม ⏳ ยังไม่ได้นับ ต้องเป็น "ส่วนที่ยังไม่เข้าตัวเศษ Progress" เป๊ะ — จำนวนแถว = ตัวหาร − ตัวเศษ
// ถ้าสองอันนี้หลุดจากกัน จะเกิดอาการ "สแกนจนรายการหมดแล้วแต่ Progress ไม่ถึง 100%"
test('filter ยังไม่ได้นับ — จำนวนแถว = ตัวหาร − ตัวเศษ ของ Progress เสมอ', async ({ browser }) => {
  const app = await bootBare(browser);
  await app.page.evaluate(() => { currentBranch = 'SRC'; });

  const r01 = [
    { colE: 'A-TODO', productName: 'ยังไม่สแกน', systemQty: 4 },
    { colE: 'B-SCANNING', productName: 'สแกนแล้วรอ Confirm', systemQty: 4 },
    { colE: 'C-DONE', productName: 'Confirm แล้ว', systemQty: 4 },
    { colE: 'D-AUDIT', productName: 'Confirm แล้วเข้า audit', systemQty: 4 },
    { colE: 'E-NOTCOUNT', productName: 'ไม่ต้องนับ (ว่าง + G=0)', systemQty: 0 },
    { colE: 'F-NONCOUNT', productName: 'ไม่ต้องนับ (หมวด 11.)', systemQty: 4, nc: 1 },
  ];
  const pm = r01.map((r) => ({ sku: r.colE, productName: r.productName, unitPrice: 10 }));

  await countableFrom(app.page, { r01, pm });

  const out = await app.page.evaluate(() => {
    const set = (sku, status) => Object.assign(state.scanData.get(sku), { status, countedQty: 4 });
    set('B-SCANNING', 'scanning');
    set('C-DONE', 'pass');
    set('D-AUDIT', 'audit');
    updateStats();
    invalidatePopupRowsCache();
    popupFilterState = 'pending';
    const rows = getFilteredPopupRows().map((r) => r.sku).sort();
    const [num, denom] = document.getElementById('progressCount').textContent.split(' / ').map(Number);
    return { rows, num, denom };
  });

  // countable = A/B/C/D (E ไม่มีของ+ไม่จัดชั้น · F หมวดไม่ใช่สินค้าคงคลัง)
  expect(out.denom).toBe(4);
  expect(out.num).toBe(2);                                   // C-DONE + D-AUDIT
  expect(out.rows).toEqual(['A-TODO', 'B-SCANNING']);         // ยังไม่สแกน + สแกนแล้วรอ Confirm
  expect(out.rows.length).toBe(out.denom - out.num);          // invariant ที่เทสนี้มีไว้ล็อก

  await closeApp(app);
});

// การ์ด Counted/Pass = "ความคืบหน้าของงานนับ" ต้องมาจาก _countableSkus ชุดเดียวกับ Progress
// ส่วน Audit = "งานค้างที่ต้องเคลียร์" ต้องนับทุกตัวและตรงกับ badge ปุ่ม Audit Verify (ห้ามกรอง)
test('การ์ดสถิติ — Counted/Pass กรองตาม Progress · Audit นับครบไม่กรอง', async ({ browser }) => {
  const app = await bootBare(browser);
  await app.page.evaluate(() => { currentBranch = 'SRC'; });

  const r01 = [
    { colE: 'IN-PASS', productName: 'ในชุดนับ + pass', systemQty: 4 },
    { colE: 'IN-AUDIT', productName: 'ในชุดนับ + audit', systemQty: 4 },
    { colE: 'IN-TODO', productName: 'ในชุดนับ + ยังไม่สแกน', systemQty: 4 },
    { colE: 'OUT-PASS', productName: 'นอกชุดนับ + pass (หมวด 11.)', systemQty: 4, nc: 1 },
    { colE: 'OUT-AUDIT', productName: 'นอกชุดนับ + audit (หมวด 11.)', systemQty: 4, nc: 1 },
  ];
  const pm = r01.map((r) => ({ sku: r.colE, productName: r.productName, unitPrice: 10 }));

  await countableFrom(app.page, { r01, pm });

  const out = await app.page.evaluate(() => {
    const set = (sku, status) => Object.assign(state.scanData.get(sku), { status, countedQty: 4 });
    set('IN-PASS', 'pass');
    set('IN-AUDIT', 'audit');
    set('OUT-PASS', 'pass');
    set('OUT-AUDIT', 'audit');
    updateStats();
    const txt = (id) => document.getElementById(id).textContent;
    const [num, denom] = txt('progressCount').split(' / ').map(Number);
    return {
      counted: Number(txt('statCounted')),
      pass: Number(txt('statPass')),
      audit: Number(txt('statFail')),
      auditBtn: Number(txt('auditVerifyCount')),
      num, denom,
    };
  });

  expect(out.denom).toBe(3);                 // IN-* สามตัว (OUT-* หมวด 11. ไม่เข้าชุดนับ)
  expect(out.counted).toBe(out.num);         // ← invariant หลักที่เทสนี้มีไว้ล็อก
  expect(out.counted).toBe(2);               // IN-PASS + IN-AUDIT (IN-TODO ยังไม่สแกน)
  expect(out.pass).toBe(1);                  // เฉพาะ IN-PASS — OUT-PASS หลุดไปตามที่ตกลง
  expect(out.audit).toBe(2);                 // IN-AUDIT + OUT-AUDIT — ไม่กรอง
  expect(out.audit).toBe(out.auditBtn);      // การ์ดต้องตรงกับ badge ปุ่ม Audit Verify เสมอ
  expect(out.counted).toBeLessThanOrEqual(out.denom);
  expect(out.pass).toBeLessThanOrEqual(out.counted);

  await closeApp(app);
});

test('_countableSkus — ไม่มี R01 = 0 (ไม่ fallback ไปขนาด catalog)', async ({ browser }) => {
  const app = await bootBare(browser);
  await app.page.evaluate(() => { currentBranch = 'SRC'; });

  const out = await countableFrom(app.page, {
    r01: [],
    pm: [{ sku: 'X-1', productName: 'in PBM only', unitPrice: 10, cat: 'A' }],
  });

  expect(out.countable).toEqual([]);
  expect(out.total).toBe(0);   // Product Master มีของ แต่ Total SKU ต้องเป็น 0 จริงๆ
  await closeApp(app);
});
