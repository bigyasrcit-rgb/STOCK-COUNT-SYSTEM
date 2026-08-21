// การ์ดสถิติ + Progress หลังยุบเหลือ Total SKU ใบเดียว (ส.ค. 2026)
//
// invariant ที่เทสนี้ล็อก: ตัวเศษกับตัวหารของ Progress ต้องมาจาก _countableSkus ชุดเดียวกัน
// → ตัวเศษ ⊆ ตัวหารเสมอ และ % เกิน 100 ไม่ได้ (เดิมตัวเศษวนจาก scanData ส่วนตัวหารนับจาก r01Data
//   คนละแหล่ง — พอตัดของบางส่วนออกข้างเดียวจะทำให้ % ทะลุ)
// ชุด countable (ส.ค. 2026) = R01 ที่หมวดนับได้ และ ( G ≠ 0 หรือ PBM Col D ∈ A/B/C )
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

  test('Total SKU = ตัวหาร Progress = R01 ที่ G≠0 ∪ A/B/C · การ์ด SKU BRANCH ถูกลบแล้ว', async ({ browser }) => {
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
      abcZero: _countableSkus.has('S-ABC0'),      // จัดชั้น B แต่ระบบขึ้น 0 → ยังต้องนับ
      noCat: _countableSkus.has('S-NOCAT'),       // ไม่จัดชั้นแต่มีสต็อก → ยังต้องนับ
      noCatZero: _countableSkus.has('S-NOCAT0'),  // ไม่จัดชั้น + ไม่มีสต็อก → เคสเดียวที่หลุด
      zero: _countableSkus.has('S-ZERO'),
      neg: _countableSkus.has('S-NEG'),
      catP: _countableSkus.has('S-CATP'),         // Col D = P แต่มีสต็อกค้าง → ยังนับ
      del: _countableSkus.has('S-ONLYR01'),
      pmOnly: _countableSkus.has('S-PMONLY'),     // จัดชั้น A แต่ไม่มีแถวใน R01 → ไม่นับ
      norm: _countableSkus.has('S-NORM'),
    }));
    expect(has).toEqual({
      abcZero: true, noCat: true, noCatZero: false, zero: true, neg: true,
      catP: true, del: true, pmOnly: false, norm: true,
    });

    await closeApp(app);
  });

  // ทุกสาขาเดินทางนี้จนกว่า admin จะอัป PBM ใหม่ — ถ้าพัง Total SKU = 0 ทั้งระบบทันทีที่ deploy
  test('PBM ที่ไม่มี Col D (ไฟล์ก่อน ส.ค. 2026) → Total SKU เท่ากติกาเดิม G≠0 เป๊ะ', async ({ browser }) => {
    const app = await bootFreshCount(browser, { role: 'pharmacist', user: 'Pharm', mode: 'desktop', pmCatCoded: false });
    const s = await stats(app.page);

    expect(s.cachedTotal).toBe(F.LEGACY_COUNTABLE_COUNT);
    expect(s.total).toBe(String(F.LEGACY_COUNTABLE_COUNT));
    expect(s.progress).toBe(`0 / ${F.LEGACY_COUNTABLE_COUNT}`);
    expect(F.LEGACY_COUNTABLE_COUNT).toBeLessThan(F.COUNTABLE_COUNT);   // ไฟล์ใหม่มีแต่เพิ่ม ไม่มีตัด

    const has = await app.page.evaluate(() => ({
      abcZero: _countableSkus.has('S-ABC0'),    // กติกาเดิม: G=0 → ไม่นับ
      noCat: _countableSkus.has('S-NOCAT'),     // กติกาเดิม: มีสต็อก → นับ
      del: _countableSkus.has('S-ONLYR01'),
    }));
    expect(has).toEqual({ abcZero: false, noCat: true, del: true });

    await closeApp(app);
  });

  test('ตัวเศษ ⊆ ตัวหาร — สินค้านอกชุด countable ถูก confirm แล้วก็ดัน % ไม่ทะลุ 100', async ({ browser }) => {
    const app = await bootFreshCount(browser, { role: 'pharmacist', user: 'Pharm', mode: 'desktop' });

    // ปั้นผลลัพธ์ตรงเข้า scanData: ทุก SKU ในแคตตาล็อกถูกยืนยันหมด รวมตัวที่ไม่ควรอยู่ในตัวหาร
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

  // PBM เป็นตัวตัดสินตัวหารแล้ว → guard เดิมที่เรียก rebuildMaps() เฉพาะตอนมี R05 จะทำให้ตัวเลขค้าง
  test('PBM อัปเดตตอน R05 ยังไม่มา → ตัวหารต้องรีคำนวณ ไม่ค้างเลขเดิม', async ({ browser }) => {
    const app = await bootFreshCount(browser, { role: 'pharmacist', user: 'Pharm', mode: 'desktop' });
    const before = await app.page.evaluate(() => _cachedTotalSku);
    expect(before).toBe(F.COUNTABLE_COUNT);

    // ถอด S-ABC0 (Col D = B, สต็อก 0) ออกจาก PBM — ตัวนี้เข้า Progress ได้ด้วย Col D อย่างเดียว
    // จึงเป็นตัวเดียวที่พิสูจน์ว่าตัวหารตอบสนองต่อ PBM จริง ไม่ใช่แค่ R01
    const after = await app.page.evaluate(() => {
      state.r05Data = [];   // จำลองเครื่องที่ยังโหลด R05 ไม่เสร็จ (rebuildMaps เดินไม่ครบ)
      applyProductMasterMeta({
        data_json: JSON.stringify(state.productMasterData.filter((r) => r.sku !== 'S-ABC0')),
        cat_coded: true,
      });
      return {
        total: _cachedTotalSku,
        hasAbcZero: _countableSkus.has('S-ABC0'),
        domTotal: document.getElementById('statTotal').textContent,
      };
    });

    expect(after.total).toBe(F.COUNTABLE_COUNT - 1);
    expect(after.hasAbcZero).toBe(false);
    expect(after.domTotal).toBe(String(F.COUNTABLE_COUNT - 1));

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
