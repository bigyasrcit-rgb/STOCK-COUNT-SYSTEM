// ปุ่ม "ค้างส่งลูกค้า" — เภสัชปิดงานสินค้าที่ระบบไม่มีของ (G ≤ 0) โดยไม่ออกใบปรับสต็อก
//
// ทำไมต้องมี: ยอดติดลบเกิดเพราะการขายถูกบันทึกแล้วแต่ของยังไม่เข้า = เป็นหนี้ลูกค้าอยู่จริง
// ถ้าดันยอดกลับเป็น 0 ด้วยใบปรับสต็อก = ลบร่องรอยหนี้ทิ้ง แล้วส่วนต่างไปโผล่ใหม่ตอนของเข้า
//
// เทสนี้ตรึง 3 ด้าน และด้านที่ 2 กับ 3 สำคัญที่สุด:
//   1. มาร์คแล้วต้อง pass และไม่เข้าใบปรับสต็อก
//   2. ของติดลบที่ "ไม่ได้มาร์ค" ต้องยังเป็น stock_adjustment เหมือนเดิม (ห้ามเหมารวม)
//   3. ปุ่มต้องกดไม่ได้เมื่อระบบยังมีของ (G > 0) — ไม่งั้นกลายเป็นปุ่มปิดงานอะไรก็ได้
const { test, expect, bootBare, closeApp } = require('../../lib/hooks');

async function seed(page) {
  await page.evaluate(() => {
    currentBranch = 'SRC'; currentRole = 'pharmacist'; currentUser = 'Pharm';
    state.r01Data = [
      { colE: 'NEG', productName: 'ค้างส่งลูกค้า', systemQty: -2 },
      { colE: 'ZERO', productName: 'ระบบว่าง', systemQty: 0 },
      { colE: 'POS', productName: 'ระบบมีของ', systemQty: 5 },
    ];
    state.skuMap.clear(); state.scanData.clear(); scanListMap.clear();
    state.r01Data.forEach((r) => state.skuMap.set(r.colE, {
      sku: r.colE, productName: r.productName, unitPrice: 20,
      systemQty: r.systemQty, negSys: false, barcodes: [], isDel: false,
    }));
    state.r16InboundRawMap.clear(); state.r16InboundMap.clear();
    state.r16RawMap.clear(); state.r16SalesMap.clear();
    state.r16_103Map.clear(); state.r16_103RawMap.clear();
    _rebuildCountableSkus();
    ['NEG', 'ZERO', 'POS'].forEach((sku) => state.scanData.set(sku, {
      status: 'audit', auditStatus: 'pending', countedQty: 0,
      timestamp: '2026-08-28 10:00:00', scannedBy: 'Asst',
    }));
  });
}

test('_canMarkBackorder เปิดเฉพาะ G ≤ 0 ที่ยังไม่ยืนยัน', async ({ browser }) => {
  const app = await bootBare(browser);
  await seed(app.page);
  const r = await app.page.evaluate(() => {
    const can = (sku) => _canMarkBackorder(sku, state.scanData.get(sku));
    const base = { neg: can('NEG'), zero: can('ZERO'), pos: can('POS') };

    state.scanData.get('NEG').auditor = 'someone';          // ยืนยันไปแล้ว
    const afterAuditor = can('NEG');
    delete state.scanData.get('NEG').auditor;

    state.scanData.get('NEG').status = 'pass';              // ไม่ได้อยู่ใน audit
    const afterPass = can('NEG');
    state.scanData.get('NEG').status = 'audit';

    currentRole = 'assistant';                              // ผู้ช่วยกดไม่ได้
    const asAssistant = can('NEG');
    currentRole = 'pharmacist';

    currentBranch = 'WH';                                   // คลังไม่มีกลไกนี้
    const asWh = can('NEG');
    currentBranch = 'SRC';

    return { ...base, afterAuditor, afterPass, asAssistant, asWh, unknownSku: _canMarkBackorder('NOPE', { status: 'audit' }) };
  });
  expect(r).toEqual({
    neg: true, zero: true, pos: false,     // G ≤ 0 เท่านั้น
    afterAuditor: false, afterPass: false,
    asAssistant: false, asWh: false,
    unknownSku: false,                     // ไม่มีใน R01 → ไม่รู้ค่า G → ไม่ให้กด
  });
  await closeApp(app);
});

test('มาร์คแล้ว → pass · ไม่บันทึกจำนวนปลอม · ไม่เข้าใบปรับสต็อก', async ({ browser }) => {
  const app = await bootBare(browser);
  await seed(app.page);
  const r = await app.page.evaluate(() => {
    window.confirm = () => true;                 // ข้าม dialog ยืนยัน
    markBackorderItem('NEG');
    const marked = { ...state.scanData.get('NEG') };
    confirmAuditVerifyItem('NEG', true, true);   // deferSync — ไม่แตะ Firestore
    const done = { ...state.scanData.get('NEG') };
    return {
      backorder: marked.backorder, recheckQty: marked.recheckQty, recheckBy: marked.recheckBy,
      frozenSys: marked.recheckSystemQty,
      status: done.status, auditStatus: done.auditStatus, auditor: done.auditor,
      ords: _buildAdjustDocRows('ords').map((x) => x.sku),
      irps: _buildAdjustDocRows('irps').map((x) => x.sku),
    };
  });
  expect(r.backorder).toBe(true);
  expect(r.recheckQty).toBe(0);        // ของจริงบนชั้น = ว่าง · ไม่ใช่จำนวนปลอมจากการสแกนป้าย
  expect(r.recheckBy).toBe('Pharm');
  expect(r.frozenSys).toBe(-2);        // freeze ยอดระบบไว้ตามกฎเดิม
  expect(r.status).toBe('pass');
  expect(r.auditStatus).toBe('approved');
  expect(r.auditor).toBe('Pharm');     // ร่องรอยว่าใครตัดสิน
  expect(r.ords).toEqual([]);
  expect(r.irps).toEqual([]);          // ← หัวใจ: ไม่ออกใบปรับสต็อก ยอด −2 คงไว้
  await closeApp(app);
});

test('ติดลบที่ไม่ได้มาร์ค ยังเป็น stock_adjustment และยังเข้าใบปรับสต็อกเหมือนเดิม', async ({ browser }) => {
  const app = await bootBare(browser);
  await seed(app.page);
  const r = await app.page.evaluate(() => {
    const sd = state.scanData.get('NEG');
    sd.recheckQty = 0; sd.recheckBy = 'Pharm'; sd.recheckAt = new Date().toISOString();
    _freezeRecheckBaseline('NEG', sd);          // รีเช็คได้ 0 ตามปกติ ไม่มีธง
    confirmAuditVerifyItem('NEG', true, true);
    return {
      status: state.scanData.get('NEG').status,
      irps: _buildAdjustDocRows('irps').map((x) => ({ sku: x.sku, qty: x.qty })),
    };
  });
  expect(r.status).toBe('stock_adjustment');
  expect(r.irps).toEqual([{ sku: 'NEG', qty: 2 }]);   // ยังต้องออกเอกสารดันยอดกลับเป็น 0
  await closeApp(app);
});

test('ถอนการมาร์คด้วย ✕ และการสแกนทับ ต้องล้างธงทั้งคู่', async ({ browser }) => {
  const app = await bootBare(browser);
  await seed(app.page);
  const r = await app.page.evaluate(() => {
    window.confirm = () => true;
    markBackorderItem('NEG');
    const afterMark = !!state.scanData.get('NEG').backorder;

    resetRecheckItem('NEG');                    // ปุ่ม ✕ ถอน
    const afterReset = { flag: !!state.scanData.get('NEG').backorder, qty: state.scanData.get('NEG').recheckQty };

    markBackorderItem('NEG');
    _addRecheckScanQty('NEG', state.scanData.get('NEG'), 1);   // เภสัชเจอของจริงแล้วสแกนทับ
    const afterScan = { flag: !!state.scanData.get('NEG').backorder, qty: state.scanData.get('NEG').recheckQty };
    return { afterMark, afterReset, afterScan };
  });
  expect(r.afterMark).toBe(true);
  expect(r.afterReset).toEqual({ flag: false, qty: undefined });   // กลับเป็น "ยังไม่รีเช็ค"
  expect(r.afterScan).toEqual({ flag: false, qty: 1 });            // สแกนทับ = เจอของจริง → ตัดสินด้วยสูตรปกติ
  await closeApp(app);
});

test('_sameBranchRecheck จับได้เมื่อมีคนกดปุ่มกลางงาน Confirm', async ({ browser }) => {
  const app = await bootBare(browser);
  const r = await app.page.evaluate(() => {
    const base = { status: 'audit', recheckQty: 0, recheckBy: 'P', recheckAt: 'T' };
    return {
      same: _sameBranchRecheck({ ...base }, { ...base }),
      flagAdded: _sameBranchRecheck({ ...base }, { ...base, backorder: true }),
      bothFlagged: _sameBranchRecheck({ ...base, backorder: true }, { ...base, backorder: true }),
    };
  });
  expect(r.same).toBe(true);
  expect(r.flagAdded).toBe(false);    // ต้อง abort ทั้งชุด ไม่งั้นผลเพี้ยน
  expect(r.bothFlagged).toBe(true);
  await closeApp(app);
});
