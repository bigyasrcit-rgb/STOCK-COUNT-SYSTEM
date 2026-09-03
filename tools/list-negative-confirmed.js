/*
 * Read-only survey — หา "สินค้าที่ยอดระบบติดลบและ Confirm ไปแล้ว" เพื่อเตรียมกด ↺ เปิดรีเช็คใหม่
 *
 * ทำไมต้องมี: กลุ่ม `pass` ที่เภสัชยืนยันแล้ว **ไม่โผล่ในแท็บไหนของ Audit Verify เลย**
 * (`_avFilter` มีแค่ 'audit' กับ 'stock_adj') และป็อปอัพ 📋 รายการสินค้า ซ่อนคอลัมน์ Sys Qty
 * บนสาขายา (แสดงเฉพาะ WH supervisor) — จึงไม่มีทางดูจาก UI ว่ามีกี่ตัวและตัวไหนบ้าง
 *
 * วิธีใช้ (Desktop · login สาขายาที่ต้องการ · โหลด R01 + R05 ครบแล้ว):
 *   1. เปิดแอป → login → F12 → Console
 *   2. วางไฟล์นี้ทั้งไฟล์ แล้ว Enter
 *   3. listNegativeConfirmed()                    // ยอดระบบ < 0 (ค่าเริ่มต้น)
 *      listNegativeConfirmed({includeZero:true})  // รวม G = 0 ด้วย (กลุ่มที่กด 📦 ค้างส่ง ได้เหมือนกัน)
 *
 * Safety properties:
 * - อ่านอย่างเดียว 100% และ **ไม่แตะ Firestore เลย** — อ่านจาก state ในหน่วยความจำล้วน
 *   (0 reads · ไม่กินโควต้า · รันระหว่างพนักงานสแกนอยู่ได้ ไม่กระทบใคร)
 * - ไม่แก้ state ไม่หยุด listener ไม่ยกเลิก timer ไม่ render อะไรใหม่
 * - ไม่เรียก reopenPharmacyAudit ให้เอง — แค่พิมพ์คำสั่งที่พร้อมคัดลอกไปวาง
 */
(() => {
'use strict';

// ยอดระบบดิบจาก R01 — ต้องผ่าน _rawSystemQty เพราะผูกกับ state.r01Data โดยตรง
// (ถูกต้องแม้ skuMap ยังไม่ถูกสร้างตอน R05 มาไม่ถึง) · fallback ไว้เผื่อรุ่นเก่า
function rawSys(sku) {
  if (typeof _rawSystemQty === 'function') {
    const v = _rawSystemQty(sku);
    if (v !== null && v !== undefined) return v;
  }
  const si = state.skuMap.get(sku);
  return si && Number.isFinite(Number(si.systemQty)) ? Number(si.systemQty) : null;
}

// ยอดระบบที่ระบบ "ใช้ตัดสินจริง" ตอนเภสัชยืนยัน (freeze ไว้ตอนสแกนรีเช็ค)
function frozenSys(sku, sd) {
  if (typeof _recheckBaselineSystemQty === 'function') return _recheckBaselineSystemQty(sku, sd);
  const v = Number(sd && sd.recheckSystemQty);
  return Number.isFinite(v) ? v : null;
}

function preBaseline(sd) {
  return typeof _isPreBaselineItem === 'function' ? !!_isPreBaselineItem(sd) : null;
}

// guard เดียวกับ reopenPharmacyAudit() — ถ้าไม่ผ่าน ปุ่ม/คำสั่งจะเด้ง "รายการนี้เปิดรีเช็คใหม่ไม่ได้"
function canReopen(sd) {
  return sd.initialStatus === 'audit' && ['pass', 'stock_adjustment'].includes(sd.status);
}

function listNegativeConfirmed(opts = {}) {
  const includeZero = opts.includeZero === true;

  if (typeof state === 'undefined' || !state || !state.scanData) throw new Error('ยังไม่ได้เปิดแอป/login');
  if (typeof _isPharmacyBranch === 'function' && !_isPharmacyBranch()) {
    throw new Error(`สคริปต์นี้ใช้กับสาขายา (SRC/KKL/SSS) เท่านั้น — ตอนนี้อยู่สาขา ${typeof currentBranch !== 'undefined' ? currentBranch : '?'}`);
  }
  if (!state.r01Data || !state.r01Data.length) throw new Error('ยังไม่ได้โหลด R01.102 — ยอดระบบยังอ่านไม่ได้');
  if (!state.skuMap.size) console.warn('[neg] skuMap ว่าง (R05 ยังมาไม่ถึง?) — ชื่อสินค้าอาจไม่ขึ้น แต่ยอดระบบยังถูกต้อง');

  const groups = { stockAdj: [], passVerified: [], auditPending: [], cannotReopen: [] };
  let scanned = 0;

  for (const [sku, sd] of state.scanData.entries()) {
    const g = rawSys(sku);
    if (g === null) continue;
    if (includeZero ? g > 0 : g >= 0) continue;
    scanned++;

    const si = state.skuMap.get(sku);
    const base = frozenSys(sku, sd);
    const row = {
      sku,
      name: (si && si.productName ? si.productName : '').slice(0, 32),
      ระบบ: g,
      นับได้: sd.countedQty,
      รีเช็ค: sd.recheckQty === undefined ? '—' : sd.recheckQty,
      // ฐานที่ใช้ตัดสินจริง — ถ้าเป็น 0 ทั้งที่ระบบติดลบ = ตัดสินด้วยค่าที่ถูก clamp (กติกาเก่า)
      ฐานที่ตัดสิน: base === null || base === undefined ? '—' : base,
      status: sd.status,
      auditor: sd.auditor || '',
      ค้างส่ง: sd.backorder ? '📦' : '',
      นับก่อน_baseline: preBaseline(sd) === null ? '?' : (preBaseline(sd) ? 'ใช่' : 'ไม่'),
      เวลานับ: sd.firstScanAt || sd.timestamp || '',
    };
    // ตัวชี้ว่า "ตัดสินด้วยกติกาเก่า" — ฐานเป็น 0 ทั้งที่ยอดดิบติดลบ (clamp บีบไว้)
    // ต้องเช็ค null/undefined แยกก่อน: Number(null)===0 ใน JS ⇒ รายการที่ยังไม่เคย freeze
    // (ยัง audit / ไม่เคยรีเช็ค) จะติดธงผิดทั้งที่ยังไม่มีการตัดสินเกิดขึ้นเลย
    const hasBase = base !== null && base !== undefined && Number.isFinite(Number(base));
    row.ฐานถูก_clamp = (g < 0 && hasBase && Number(base) === 0) ? '⚠️ ใช่' : '';

    if (sd.status === 'audit' && !sd.auditor) groups.auditPending.push(row);
    else if (!canReopen(sd)) { if (['pass', 'stock_adjustment', 'audit'].includes(sd.status)) groups.cannotReopen.push(row); }
    else if (sd.status === 'stock_adjustment') groups.stockAdj.push(row);
    else groups.passVerified.push(row);
  }

  const byQty = (a, b) => a.ระบบ - b.ระบบ;
  Object.values(groups).forEach((g) => g.sort(byQty));

  const label = includeZero ? 'ยอดระบบ ≤ 0' : 'ยอดระบบ < 0';
  console.log(`\n[neg] สาขา ${typeof currentBranch !== 'undefined' ? currentBranch : '?'} · ${label} · พบ ${scanned} SKU ที่มีการนับแล้ว`);
  console.log(`[neg] R01 baseline ปัจจุบัน: ${typeof _r01BaselineAt !== 'undefined' && _r01BaselineAt ? _r01BaselineAt : '(ไม่มี)'}`);

  if (groups.auditPending.length) {
    console.log(`\n── ⏳ ยัง Audit ยังไม่มีเภสัชยืนยัน (${groups.auditPending.length}) — ไม่ต้อง reopen รีเช็คได้เลยจากแท็บ Audit ──`);
    console.table(groups.auditPending);
  }
  if (groups.stockAdj.length) {
    console.log(`\n── ⚠️ Stock Adjustment (${groups.stockAdj.length}) — มีปุ่ม ↺ ในแท็บ Stock Adj อยู่แล้ว ──`);
    console.table(groups.stockAdj);
  }
  if (groups.passVerified.length) {
    console.log(`\n── ✅ Pass ที่เภสัชยืนยันแล้ว (${groups.passVerified.length}) — ★ กลุ่มที่ไม่มีปุ่มบน UI ต้องใช้ Console ──`);
    console.table(groups.passVerified);
  }
  if (groups.cannotReopen.length) {
    console.log(`\n── 🚫 เปิดรีเช็คใหม่ไม่ได้ (${groups.cannotReopen.length}) — initialStatus ไม่ใช่ 'audit' ⇒ reopenPharmacyAudit จะปฏิเสธ ──`);
    console.table(groups.cannotReopen);
  }
  if (!scanned) console.log('[neg] ไม่พบรายการที่เข้าเงื่อนไข');

  // เตือนล่วงหน้าถ้า session นี้กด reopen ไม่ได้ (จะได้ไม่เสียเวลาไปคัดลอกคำสั่ง)
  const notPharmacist = typeof currentRole !== 'undefined' && currentRole !== 'pharmacist';
  const onPda = typeof _isPdaApp === 'function' && _isPdaApp();
  if (notPharmacist) console.warn(`[neg] ⚠️ role ปัจจุบันคือ "${currentRole}" — reopenPharmacyAudit รับเฉพาะ pharmacist`);
  if (onPda) console.warn('[neg] ⚠️ เครื่องนี้เป็น PDA — reopen ต้องทำบน Desktop');
  if (typeof navigator !== 'undefined' && !navigator.onLine) console.warn('[neg] ⚠️ ออฟไลน์อยู่ — reopen ต้องออนไลน์ (marker เขียนขึ้น cloud ก่อนแก้ local)');

  const reopenable = [...groups.stockAdj, ...groups.passVerified].map((r) => r.sku);
  if (reopenable.length) {
    console.log(`\n── คำสั่งเปิดรีเช็คใหม่ ${reopenable.length} รายการ (คัดลอกไปวาง · หน่วง 300ms กัน transaction ชน) ──`);
    console.log(
      `for (const s of ${JSON.stringify(reopenable)}) {\n` +
      `  await reopenPharmacyAudit(s);\n` +
      `  await new Promise(r => setTimeout(r, 300));\n` +
      `}`,
    );
    console.log('[neg] ⚠️ reopenPharmacyAudit ถาม confirm() ทีละรายการ — จะต้องกดยืนยันทุกตัว');
  }

  return { branch: typeof currentBranch !== 'undefined' ? currentBranch : '', total: scanned, reopenable, ...groups };
}

window.listNegativeConfirmed = listNegativeConfirmed;
console.log('[neg] พร้อมใช้งาน — เรียก listNegativeConfirmed() หรือ listNegativeConfirmed({includeZero:true})');
})();
