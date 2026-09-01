// ยอดระบบติดลบไม่ได้แปลว่าข้อมูลผิดเสมอไป — เคสจริงของสาขายา:
// จ่ายของให้ลูกค้าเท่าที่มี แต่ R01 ของไม่พอ ยอดเลยติดลบ (ค้างลูกค้า) พอคลังส่งของมาเติม ของบนชั้นก็ถูกต้องแล้ว
//
// เดิมสาขายา clamp ค่าติดลบเป็น 0 + ธง negSys แล้วบังคับ audit ทุกตัว → เคสนี้ pass ไม่ได้เลย ค้างให้เภสัชตรวจทุกวัน
// ส.ค. 2026 รอบ 2: เลิก clamp → sys เป็นค่าดิบ → สูตร `effectiveCnt === sys` เดิมตัดสินได้ถูกเองโดยไม่ต้องแก้สูตร
//
// เทสนี้ตรึงทั้งสองด้าน และด้านที่สองสำคัญกว่า:
//   ติดลบที่ R16 รับเข้าอธิบายได้พอดี → pass
//   ติดลบที่อธิบายไม่ได้            → ยังต้องเป็น audit (ห้ามหลุดเป็น pass เด็ดขาด)
const { test, expect, bootBare, closeApp } = require('../../lib/hooks');

// จำลองผลของ rebuildMaps หลังเลิก clamp: systemQty เป็นค่าดิบ, negSys=false
async function arrange(page, { sys, inbound, counted }) {
  return page.evaluate(({ sys, inbound, counted }) => {
    state.skuMap.set('S1', {
      sku: 'S1', productName: 'ของค้างลูกค้า', unitPrice: 20,
      systemQty: sys, negSys: false, barcodes: [], isDel: false,
    });
    // r16InboundRawMap ว่าง → getInboundQtyBefore ตกไปใช้ aggregate map (เส้นทาง fallback ที่มีอยู่เดิม)
    state.r16InboundRawMap.clear(); state.r16InboundMap.clear();
    state.r16RawMap.clear(); state.r16SalesMap.clear();
    state.r16_103Map.clear(); state.r16_103RawMap.clear();
    if (inbound) state.r16InboundMap.set('S1', inbound);

    const sd = { status: 'scanning', countedQty: counted, timestamp: '2026-08-27 10:00:00', scannedBy: 'T' };
    state.scanData.set('S1', sd);
    const out = _buildPendingScanEvaluation('S1', sd);
    return { status: out.status, auditStatus: out.auditStatus, cnt: out.cnt, inboundQty: out.inboundQty };
  }, { sys, inbound, counted });
}

test('ติดลบที่ R16 รับเข้าอธิบายได้พอดี → pass', async ({ browser }) => {
  const app = await bootBare(browser);

  // เคสที่ผู้ใช้เจอจริง: R01 = -2 · คลังส่ง 5 · ของบนชั้นเหลือ 3 (5 - 2 ที่ค้างลูกค้า)
  // effectiveCnt = 3 + 0 + 0 - 5 = -2 === sys(-2)
  expect(await arrange(app.page, { sys: -2, inbound: 5, counted: 3 }))
    .toMatchObject({ status: 'pass', auditStatus: 'approved' });

  // คลังส่ง 2 แล้วจ่ายลูกค้าหมดทันที ชั้นว่าง: 0 - 2 = -2 === -2
  expect(await arrange(app.page, { sys: -2, inbound: 2, counted: 0 }))
    .toMatchObject({ status: 'pass' });

  await closeApp(app);
});

test('ติดลบที่อธิบายไม่ได้ → ยังต้องเป็น audit', async ({ browser }) => {
  const app = await bootBare(browser);

  // ไม่มีของส่งเข้ามาเลย แต่ยอดติดลบ → ไม่มีอะไรมาอธิบาย ต้องให้เภสัชไปดูของจริง
  expect(await arrange(app.page, { sys: -2, inbound: 0, counted: 0 }))
    .toMatchObject({ status: 'audit', auditStatus: 'pending' });

  // คลังส่ง 5 แต่นับได้แค่ 1 → หายไป 2 ชิ้น: 1 - 5 = -4 ≠ -2
  expect(await arrange(app.page, { sys: -2, inbound: 5, counted: 1 }))
    .toMatchObject({ status: 'audit' });

  // นับได้เกิน: 6 - 5 = 1 ≠ -2
  expect(await arrange(app.page, { sys: -2, inbound: 5, counted: 6 }))
    .toMatchObject({ status: 'audit' });

  await closeApp(app);
});

test('ยอดระบบเป็นบวกยังทำงานเหมือนเดิมทุกประการ', async ({ browser }) => {
  const app = await bootBare(browser);

  expect(await arrange(app.page, { sys: 10, inbound: 0, counted: 10 })).toMatchObject({ status: 'pass' });
  expect(await arrange(app.page, { sys: 10, inbound: 0, counted: 9 })).toMatchObject({ status: 'audit' });
  // รับเข้าก่อนสแกนต้องถูกหักออกเหมือนเดิม: 15 - 5 = 10 === 10
  expect(await arrange(app.page, { sys: 10, inbound: 5, counted: 15 })).toMatchObject({ status: 'pass' });
  // G = 0 ชั้นว่างจริง → pass (คู่กับกฎกรอก 0 ใน zero-qty-gate.spec.js)
  expect(await arrange(app.page, { sys: 0, inbound: 0, counted: 0 })).toMatchObject({ status: 'pass' });

  await closeApp(app);
});

// ปลายทางของ "ติดลบที่ไม่มีของเข้าจริง": audit → เภสัชรีเช็คได้ 0 → stock_adjustment → เข้าใบปรับสต็อก
// กับดักที่ clamp เคยสร้างไว้: sysQty ถูกบีบเป็น 0 → diff = 0 − 0 = 0 → ถูกกรองออกจาก **ทั้งสองใบ**
// (`dir==='ords'&&diff>=0` และ `dir==='irps'&&diff<=0`) → แถวหายเงียบ ยอดติดลบไม่เคยถูกแก้ในระบบ
test('ติดลบที่ไม่มีของเข้า → ใบปรับสต็อกต้องมีแถว ไม่หายเงียบ', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => {
    state.skuMap.clear(); state.scanData.clear();
    state.skuMap.set('S1', { sku: 'S1', productName: 'ค้างลูกค้า', unitPrice: 20, systemQty: -2, negSys: false, barcodes: [], isDel: false });
    // เภสัชรีเช็คแล้วยืนยันว่าไม่มีของจริง (0) → stock_adjustment
    state.scanData.set('S1', { status: 'stock_adjustment', countedQty: 0, recheckQty: 0, auditor: 'ph' });
    return { ords: _buildAdjustDocRows('ords').map((r) => r.qty), irps: _buildAdjustDocRows('irps').map((r) => r.qty) };
  });
  expect(out.ords).toEqual([]);      // ไม่ใช่ของขาด
  expect(out.irps).toEqual([2]);     // ดันระบบจาก −2 กลับเป็น 0 · ถ้าเป็น [] แปลว่า clamp กลับมาแล้ว

  await closeApp(app);
});

test('reEvaluateAuditItems ใช้กติกาเดียวกับ Confirm — สถานะห้ามแกว่งเมื่ออัพ R16 ใหม่', async ({ browser }) => {
  const app = await bootBare(browser);
  const r = await app.page.evaluate(() => {
    state.skuMap.set('S1', { sku: 'S1', productName: 'x', unitPrice: 20, systemQty: -2, negSys: false, barcodes: [], isDel: false });
    state.r16InboundRawMap.clear(); state.r16InboundMap.clear();
    state.r16RawMap.clear(); state.r16SalesMap.clear();
    state.r16_103Map.clear(); state.r16_103RawMap.clear();
    state.r16InboundMap.set('S1', 5);
    const sd = { status: 'scanning', countedQty: 3, timestamp: '2026-08-27 10:00:00', scannedBy: 'T' };
    state.scanData.set('S1', sd);
    const confirmStatus = _buildPendingScanEvaluation('S1', sd).status;
    // สูตรที่ reEvaluateAuditItems ใช้ (index.html:3348) ต้องให้ผลเดียวกัน
    const si = state.skuMap.get('S1');
    const effectiveCnt = 3 + getSoldQtyBefore('S1', sd.timestamp) + getR16103QtyBefore('S1', sd.timestamp) - getInboundQtyBefore('S1', sd.timestamp);
    const reEvalStatus = si.negSys ? 'audit' : (effectiveCnt === si.systemQty ? 'pass' : 'audit');
    return { confirmStatus, reEvalStatus, effectiveCnt };
  });
  expect(r.effectiveCnt).toBe(-2);
  expect(r.confirmStatus).toBe('pass');
  expect(r.reEvalStatus).toBe(r.confirmStatus);   // ต้องตรงกันเสมอ ไม่งั้นสถานะแกว่ง

  await closeApp(app);
});
