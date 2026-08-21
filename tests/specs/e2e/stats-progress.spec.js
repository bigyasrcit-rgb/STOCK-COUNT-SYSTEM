// การ์ดสถิติ + Progress หลังยุบเหลือ Total SKU ใบเดียว (ส.ค. 2026)
//
// invariant ที่เทสนี้ล็อก: ตัวเศษกับตัวหารของ Progress ต้องมาจาก _countableSkus ชุดเดียวกัน
// → ตัวเศษ ⊆ ตัวหารเสมอ และ % เกิน 100 ไม่ได้ (เดิมตัวเศษวนจาก scanData ส่วนตัวหารนับจาก r01Data
//   คนละแหล่ง — พอ G=0 ถูกตัดออกข้างเดียวจะทำให้ % ทะลุ)
const { test, expect, closeApp, requireEmulator } = require('../../lib/hooks');
const { bootFreshCount, PROJECT_ID } = require('../../lib/scenario');
const { adminDb } = require('../../lib/emulator');
const F = require('../../lib/fixtures');

const stats = (page) => page.evaluate(() => ({
  total: document.getElementById('statTotal').textContent,
  progress: document.getElementById('progressCount').textContent,
  pct: document.getElementById('statPct').textContent,
  countable: _countableSkus.size,
  cachedTotal: _cachedTotalSku,
  branchCardExists: !!document.getElementById('statCardBranch'),
  totalCardHidden: getComputedStyle(document.getElementById('statCardTotal')).display === 'none',
  countedLabel: document.getElementById('statCountedLabel').textContent,
}));

test.describe('stats cards + progress', () => {
  test.beforeEach(() => requireEmulator());
  test.setTimeout(90_000);

  test('Total SKU = ตัวหาร Progress = R01 ที่ G≠0 · การ์ด SKU BRANCH ถูกลบแล้ว', async ({ browser }) => {
    const app = await bootFreshCount(browser, { role: 'pharmacist', user: 'Pharm', mode: 'desktop' });
    const s = await stats(app.page);

    expect(s.branchCardExists).toBe(false);              // การ์ด SKU BRANCH หายไปจาก DOM จริง
    expect(s.countable).toBe(F.COUNTABLE_COUNT);
    expect(s.cachedTotal).toBe(F.COUNTABLE_COUNT);
    expect(s.total).toBe(String(F.COUNTABLE_COUNT));
    expect(s.progress).toBe(`0 / ${F.COUNTABLE_COUNT}`); // ไม่มี prefix 'Stock100 · ' อีกแล้ว
    expect(s.pct).toBe('0%');

    // membership ที่สำคัญ (ยืนยันซ้ำผ่าน UI path จริง ไม่ใช่แค่ logic spec)
    const has = await app.page.evaluate(() => ({
      zero: _countableSkus.has('S-ZERO'),
      neg: _countableSkus.has('S-NEG'),
      catP: _countableSkus.has('S-CATP'),
      del: _countableSkus.has('S-ONLYR01'),
      norm: _countableSkus.has('S-NORM'),
    }));
    expect(has).toEqual({ zero: false, neg: true, catP: true, del: true, norm: true });

    await closeApp(app);
  });

  test('ตัวเศษ ⊆ ตัวหาร — สินค้าที่ G=0 ถูก confirm แล้วก็ดัน % ไม่ทะลุ 100', async ({ browser }) => {
    const app = await bootFreshCount(browser, { role: 'pharmacist', user: 'Pharm', mode: 'desktop' });

    // ปั้นผลลัพธ์ตรงเข้า scanData: ทุก SKU ในแคตตาล็อกถูกยืนยันหมด รวม G=0 ที่ไม่ควรอยู่ในตัวหาร
    await app.page.evaluate(() => {
      for (const sku of state.skuMap.keys()) {
        const sd = state.scanData.get(sku);
        if (sd) { sd.status = 'pass'; sd.auditStatus = 'approved'; sd.countedQty = 1; }
      }
      updateStats();
    });

    const s = await stats(app.page);
    const [num, denom] = s.progress.split(' / ').map(Number);
    expect(denom).toBe(F.COUNTABLE_COUNT);
    expect(num).toBeLessThanOrEqual(denom);
    expect(num).toBe(F.COUNTABLE_COUNT);   // ทุกตัวที่ต้องนับถูกยืนยันแล้ว
    expect(s.pct).toBe('100%');            // ไม่ใช่ 104% แม้ G=0 จะถูก confirm ไปด้วย

    await closeApp(app);
  });

  test('WH: เห็น Total SKU บน Desktop และ label Counted เปลี่ยนเป็น Recheck ทั้งหมด', async ({ browser }) => {
    const app = await bootFreshCount(browser, { branch: 'WH', role: 'supervisor', user: 'มายด์', mode: 'desktop' });
    const s = await stats(app.page);

    expect(s.branchCardExists).toBe(false);
    expect(s.totalCardHidden).toBe(false);          // เดิม WH ซ่อนการ์ดนี้ ตอนนี้ต้องเห็นบน Desktop
    expect(s.countedLabel).toBe('Recheck ทั้งหมด');
    expect(s.total).toBe(String(F.COUNTABLE_COUNT));

    await closeApp(app);
  });

  test('สาขาที่ยังไม่อัป Product Branch Master → badge "ยังไม่โหลด" และไม่หยิบ global_pm มาใช้', async ({ browser }) => {
    const app = await bootFreshCount(browser, { role: 'pharmacist', user: 'Pharm', mode: 'desktop' });

    // วาง global_pm ปลอมไว้ (หน้าเว็บไม่เคยอ่าน doc นี้ จึงใช้ admin SDK ได้)
    await adminDb(PROJECT_ID).doc('stock_sessions/global_pm').set({
      data_json: JSON.stringify([{ sku: 'JUNK-1', productName: 'should never load', unitPrice: 1 }]),
      row_count: 1,
    });
    // ลบ PBM ผ่าน SDK ของหน้าเว็บเอง — ลบด้วย firebase-admin จะไม่เข้า cache ของ client
    // แล้ว .get() ธรรมดาจะยังตอบ doc เก่าจาก cache (กับดักเดียวกับที่ scenario.js อธิบายไว้)
    await app.page.evaluate(() => getProductMasterMetaRef().delete());

    await app.page.evaluate(() => restoreMasterFromFirestore(true));
    await app.page.waitForFunction(() => state.productMasterData.length === 0, null, { timeout: 15000, polling: 100 });

    const after = await app.page.evaluate(() => ({
      pm: state.productMasterData.length,
      badge: document.getElementById('badgeProductMaster').textContent,
      hasJunk: state.productMasterMap.has('JUNK-1'),
    }));
    expect(after.pm).toBe(0);
    expect(after.badge).toBe('ยังไม่โหลด');
    expect(after.hasJunk).toBe(false);   // ไม่มี fallback ไป global_pm

    await closeApp(app);
  });
});
