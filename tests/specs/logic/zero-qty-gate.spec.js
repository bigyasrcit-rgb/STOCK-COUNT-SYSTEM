// กฎราคา (< 1,000฿) กันการพิมพ์เลขผิดใส่ของแพงแล้วยอดพอง — แต่มันบล็อกเคสตรงข้ามด้วย:
// สินค้าที่ระบบว่าง (G ≤ 0) ซึ่งกติกา A/B/C (PBM Col D) ดึงเข้าตัวหาร Progress แล้ว
// ของพวกนี้ "ชั้นว่างจริง" เป็นเคสปกติ → สแกนไม่ได้ (ไม่มีของให้ยิง) และปุ่ม 🚫 ติดเงื่อนไข systemQty>0
// → ค้าง pending ถาวร Progress ไม่มีวันถึง 100%
//
// ทางออก (ส.ค. 2026): G ≤ 0 กรอกได้ แต่ **รับเฉพาะค่า 0** — การกรอก 0 ทำให้ยอดพองไม่ได้ จึงไม่ขัดเจตนากฎเดิม
// เทสนี้ตรึงทั้งสองด้าน: ต้องเปิดให้ 0 ผ่าน และต้องไม่เผลอเปิดให้ค่าอื่นผ่าน
const { test, expect, bootBare, closeApp } = require('../../lib/hooks');

// unitPrice = null (ไม่มีราคาใน R05) และ 1500 (เกินเพดาน) คือสองเหตุผลที่กฎราคาบล็อก
const CASES = [
  { sku: 'CHEAP-POS',    price: 50,   g: 7 },
  { sku: 'EXP-POS',      price: 1500, g: 7 },
  { sku: 'EXP-ZERO',     price: 1500, g: 0 },
  { sku: 'NOPRICE-ZERO', price: null, g: 0 },
  { sku: 'EXP-NEG',      price: 1500, g: -5 },
];

async function seed(app) {
  await app.page.evaluate((cases) => {
    state.r01Data = cases.map((c) => ({ colE: c.sku, productName: c.sku, systemQty: c.g }));
    state.skuMap.clear();
    cases.forEach((c) => state.skuMap.set(c.sku, {
      sku: c.sku, productName: c.sku, unitPrice: c.price,
      systemQty: c.g, negSys: false, barcodes: [], isDel: false,
    }));
    _rebuildCountableSkus();   // สร้าง _r01RawQty จาก r01Data
  }, CASES);
}

test('_canEnterZeroOnly เปิดเฉพาะ G ≤ 0 · _canEnterCountQtyValue รับเฉพาะค่า 0', async ({ browser }) => {
  const app = await bootBare(browser);
  await seed(app);
  const r = await app.page.evaluate(() => {
    const g = (sku) => state.skuMap.get(sku);
    return {
      zeroOnly: {
        cheapPos:    _canEnterZeroOnly(g('CHEAP-POS')),
        expPos:      _canEnterZeroOnly(g('EXP-POS')),
        expZero:     _canEnterZeroOnly(g('EXP-ZERO')),
        nopriceZero: _canEnterZeroOnly(g('NOPRICE-ZERO')),
        expNeg:      _canEnterZeroOnly(g('EXP-NEG')),
      },
      // ของแพง G=0: 0 ผ่าน · ค่าอื่นไม่ผ่าน (หัวใจของกฎ)
      expZeroAccepts0: _canEnterCountQtyValue(g('EXP-ZERO'), '0'),
      expZeroRejects5: _canEnterCountQtyValue(g('EXP-ZERO'), '5'),
      expZeroRejects1: _canEnterCountQtyValue(g('EXP-ZERO'), '1'),
      // ของแพงที่ระบบมีของ: ห้ามผ่านแม้กรอก 0 — ยังต้องสแกนทีละชิ้นเหมือนเดิม
      expPosRejects0:  _canEnterCountQtyValue(g('EXP-POS'), '0'),
      // ของถูกยังทำงานตามกฎเดิมทุกค่า
      cheapAccepts5:   _canEnterCountQtyValue(g('CHEAP-POS'), '5'),
    };
  });

  expect(r.zeroOnly).toEqual({
    cheapPos: false, expPos: false,      // G > 0 → ไม่เข้าข่ายยกเว้น
    expZero: true, nopriceZero: true,    // G = 0 → เข้าข่าย ทั้งกรณีแพงและไม่มีราคา
    expNeg: true,                        // G < 0 (negSys) → เข้าข่ายด้วย
  });
  expect(r.expZeroAccepts0).toBe(true);
  expect(r.expZeroRejects5).toBe(false);
  expect(r.expZeroRejects1).toBe(false);
  expect(r.expPosRejects0).toBe(false);
  expect(r.cheapAccepts5).toBe(true);

  await closeApp(app);
});

test('อ่าน G ดิบจาก r01Data ไม่ใช่ skuMap ที่สาขายา clamp ไว้', async ({ browser }) => {
  const app = await bootBare(browser);
  await seed(app);
  // จำลองสาขายา: G ติดลบถูก clamp เป็น 0 + ธง negSys ใน skuMap แต่ r01Data ยังเก็บ -5
  // ถ้าโค้ดอ่าน skuMap.systemQty จะแยก "G=0 จริง" กับ "G ติดลบที่ถูก clamp" ไม่ออก
  const r = await app.page.evaluate(() => {
    state.skuMap.set('EXP-NEG', { ...state.skuMap.get('EXP-NEG'), systemQty: 0, negSys: true });
    return {
      rawStillNegative: _rawSystemQty('EXP-NEG'),
      clampedInSkuMap:  state.skuMap.get('EXP-NEG').systemQty,
      stillZeroOnly:    _canEnterZeroOnly(state.skuMap.get('EXP-NEG')),
      unknownSku:       _rawSystemQty('NOT-IN-R01'),
    };
  });
  expect(r.rawStillNegative).toBe(-5);   // แหล่งความจริงคือ r01Data
  expect(r.clampedInSkuMap).toBe(0);
  expect(r.stillZeroOnly).toBe(true);
  expect(r.unknownSku).toBeNull();       // ไม่มีใน R01 → ไม่เข้าข่ายยกเว้น

  await closeApp(app);
});

test('กรอก 0 บนของแพง G=0 เปลี่ยน pending → scanning · 5 ถูกปฏิเสธ · ของแพงที่ระบบมีของยังล็อก', async ({ browser }) => {
  const app = await bootBare(browser);
  await seed(app);
  await app.page.evaluate(() => {
    ['EXP-ZERO', 'EXP-POS'].forEach((sku) => state.scanData.set(sku, { status: 'pending', countedQty: 0 }));
  });

  const r = await app.page.evaluate(() => {
    updatePopupQty('EXP-ZERO', '0');
    const afterZero = { ...state.scanData.get('EXP-ZERO') };
    updatePopupQty('EXP-ZERO', '5');            // ต้องถูกปฏิเสธ ค่าคงเดิม
    const afterFive = { ...state.scanData.get('EXP-ZERO') };
    updatePopupQty('EXP-POS', '0');             // ของแพงที่ระบบมีของ ต้องถูกปฏิเสธ
    const posItem = { ...state.scanData.get('EXP-POS') };
    return {
      zeroStatus: afterZero.status, zeroQty: afterZero.countedQty,
      fiveQty: afterFive.countedQty, fiveStatus: afterFive.status,
      posStatus: posItem.status, posQty: posItem.countedQty,
    };
  });

  expect(r.zeroStatus).toBe('scanning');   // ปิดงานได้ → เข้า Progress
  expect(r.zeroQty).toBe(0);
  expect(r.fiveQty).toBe(0);               // 5 ไม่ถูกเขียนทับ
  expect(r.fiveStatus).toBe('scanning');
  expect(r.posStatus).toBe('pending');     // ของแพงที่มีของจริง ยังต้องสแกน
  expect(r.posQty).toBe(0);

  await closeApp(app);
});
