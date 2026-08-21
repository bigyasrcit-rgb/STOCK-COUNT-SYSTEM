/*
 * กู้คืน items จากไฟล์ backup ของ tools/backup-branch.js — โหมด "เติมเฉพาะที่หาย" เท่านั้น
 *
 * วิธีใช้ (Desktop เท่านั้น · โหลดหน้าใหม่ · login สาขาที่จะกู้ · ห้ามมีใครสแกนอยู่):
 *   1. F12 → Console → วางไฟล์นี้ทั้งไฟล์ → Enter
 *   2. ตรวจก่อน (ไม่เขียนอะไรเลย):   await restoreItems()
 *      → เลือกไฟล์ backup-XXX-....json → อ่านรายงานให้ครบ
 *   3. ถ้ารายงานถูกต้อง ค่อยเขียนจริง: await restoreItems({dryRun:false})
 *      → เลือกไฟล์เดิม → พิมพ์ยืนยันตามที่ขึ้นบนจอ
 *   4. เสร็จแล้ว **โหลดหน้าเว็บใหม่** และบอกทุกเครื่องให้โหลดใหม่ด้วย
 *
 * Safety properties:
 * - dry-run เป็นค่าเริ่มต้น — ต้องสั่ง {dryRun:false} เองถึงจะเขียน
 * - **ไม่เขียนทับ document ที่มีอยู่เด็ดขาด** — ตรวจซ้ำใน transaction ทุกครั้งก่อนเขียน
 *   ถ้ามี SKU นั้นอยู่แล้ว (ไม่ว่ารอบไหน) จะข้าม ไม่แตะเลย
 * - ต้องเป็นสาขาเดียวกับที่ login และ **epoch (countResetAt) ต้องตรงเป๊ะ** กับ Cloud
 *   ถ้ามีคนกด "เริ่มนับใหม่" หลัง backup → หยุดทันที ไม่ยอมกู้
 * - รองรับเฉพาะ schemaVersion 2 (items subcollection)
 * - ก่อนเขียนจริงจะดาวน์โหลด safety backup ของสภาพ Cloud ปัจจุบันให้ก่อนเสมอ
 * - หยุด timer sync/flush/reconcile ของหน้านี้ระหว่างเขียน กันการเขียนชนกันเอง
 * - ตรวจผลหลังเขียน แล้วรายงานว่าสำเร็จ/ข้าม/ล้มเหลว กี่รายการ
 * - ไม่แตะ WH confirm_ops, markers, master ใดๆ — items อย่างเดียว
 */
(() => {
'use strict';

const CONCURRENCY_DELAY_MS = 25;   // เว้นจังหวะระหว่าง transaction กัน Firestore เบรก

// ย้อน serialize ของ backup-branch.js: {__ts__:iso} → Firestore Timestamp
function revive(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(revive);
  if (typeof v === 'object') {
    if (typeof v.__ts__ === 'string') return firebase.firestore.Timestamp.fromDate(new Date(v.__ts__));
    const out = {};
    for (const k of Object.keys(v)) out[k] = revive(v[k]);
    return out;
  }
  return v;
}

function pickFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (!f) return reject(new Error('ไม่ได้เลือกไฟล์'));
      const fr = new FileReader();
      fr.onload = () => { try { resolve({ name: f.name, json: JSON.parse(fr.result) }); } catch (e) { reject(new Error('ไฟล์ไม่ใช่ JSON ที่อ่านได้: ' + e.message)); } };
      fr.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'));
      fr.readAsText(f);
    };
    input.click();
  });
}

function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function cloudEpochOf(sessionData) {
  try { return JSON.parse(sessionData.session_data_json || '{}').countResetAt || ''; } catch (e) { return ''; }
}

// หยุดงานเบื้องหลังของหน้านี้ กันไม่ให้ flush/sync เขียนชนกับการกู้คืน
function pauseBackgroundWork() {
  const stopped = [];
  try { clearTimeout(_firestoreSyncTimer); stopped.push('firestoreSync'); } catch (e) {}
  try { clearTimeout(_saveTimer); stopped.push('save'); } catch (e) {}
  try { clearTimeout(_scanItemFlushTimer); stopped.push('itemFlush'); } catch (e) {}
  try { clearInterval(_scanItemReconcileTimer); stopped.push('reconcile'); } catch (e) {}
  // dirty ที่ค้างอยู่คือ "ของหน้านี้" ไม่ใช่ของที่กำลังกู้ — ล้างทิ้งเพื่อไม่ให้ไปลบ/ทับ item ที่เพิ่งเขียน
  // บนหน้าที่เพิ่งโหลดและไม่มีใครสแกน ค่านี้ต้องเป็น 0 — ถ้าไม่ใช่ แปลว่ารันผิดจังหวะ ต้องเตือน
  let pendingDirty = 0;
  try {
    if (typeof _dirtySkus !== 'undefined') { pendingDirty = _dirtySkus.size; _dirtySkus.clear(); }
  } catch (e) {}
  if (pendingDirty) {
    console.warn(`[restore] ⚠️ หน้านี้มีการแก้ค้างอยู่ ${pendingDirty} SKU ที่ยังไม่ได้ sync และถูกล้างทิ้ง — ` +
      'ควรรันบนหน้าที่เพิ่งโหลดและไม่มีใครสแกน · ตรวจยอดสาขานี้ซ้ำหลังกู้เสร็จ');
  }
  return stopped;
}

async function restoreItems(opts = {}) {
  const dryRun = opts.dryRun !== false;   // ต้องสั่ง false เองเท่านั้น

  if (typeof _db === 'undefined' || !_db) throw new Error('ยังไม่ได้เชื่อมต่อ Firestore — เปิดแอปและ login ก่อน');
  if (typeof currentBranch === 'undefined' || !currentBranch) throw new Error('ยังไม่ได้เลือกสาขา');
  if (typeof _isPdaApp === 'function' && _isPdaApp()) throw new Error('ต้องรันบน Desktop เท่านั้น');
  if (!navigator.onLine) throw new Error('ต้องออนไลน์');

  console.log(`[restore] โหมด: ${dryRun ? 'ตรวจอย่างเดียว (ไม่เขียน)' : '⚠️ เขียนจริง'} · สาขาที่ login: ${currentBranch}`);
  console.log('[restore] เลือกไฟล์ backup...');
  const { name, json } = await pickFile();

  // ── 1. ตรวจไฟล์ ──────────────────────────────────────────────────────────
  const meta = json.__meta__ || {};
  const fileBranch = meta.branch || '';
  const fileEpoch = (meta.summary && meta.summary.epoch) || '';
  const items = json.items;
  if (!fileBranch) throw new Error('ไฟล์นี้ไม่ใช่ backup ของ tools/backup-branch.js (ไม่มี __meta__.branch)');
  if (!items || items.__error__ || typeof items !== 'object') throw new Error('ไฟล์นี้ไม่มีข้อมูล items ที่ใช้ได้');
  if (fileBranch !== currentBranch) throw new Error(`ไฟล์เป็นของสาขา ${fileBranch} แต่ตอนนี้ login สาขา ${currentBranch} — สลับสาขาให้ตรงก่อน`);
  if (!fileEpoch) throw new Error('ไฟล์ไม่มี epoch (countResetAt) — กู้ไม่ได้');

  // ── 2. ตรวจ Cloud ว่าเป็นรอบเดียวกันจริง ─────────────────────────────────
  const sessionSnap = await _db.doc(`stock_sessions/${currentBranch}`).get({ source: 'server' });
  if (!sessionSnap.exists) throw new Error('ไม่พบ session ของสาขานี้บน Cloud');
  const sessionData = sessionSnap.data() || {};
  const cloudEpoch = cloudEpochOf(sessionData);
  const cloudSchema = Number(sessionData.schemaVersion) || 1;

  if (cloudSchema !== 2) throw new Error(`สาขานี้เป็น schemaVersion ${cloudSchema} — เครื่องมือนี้รองรับเฉพาะ v2 (items subcollection)`);
  if (cloudEpoch !== fileEpoch) {
    throw new Error(
      `รอบนับไม่ตรงกัน — หยุดเพื่อความปลอดภัย\n` +
      `  ไฟล์ backup : ${fileEpoch}\n` +
      `  Cloud ตอนนี้ : ${cloudEpoch}\n` +
      `แปลว่ามีคนกด "เริ่มนับใหม่" หลังจากทำ backup — การกู้จะทำให้ข้อมูลสองรอบปนกัน`,
    );
  }

  // ── 3. หาว่าหายอะไรบ้าง (เทียบด้วย document ID ทุกรอบ ไม่ใช่เฉพาะรอบนี้) ──
  const itemsRef = _db.collection('stock_sessions').doc(currentBranch).collection('items');
  const existingSnap = await itemsRef.get({ source: 'server' });
  const existing = new Set(existingSnap.docs.map((d) => d.id));

  const missing = [];
  const skippedEpoch = [];
  for (const [sku, raw] of Object.entries(items)) {
    if (!raw || typeof raw !== 'object') continue;
    if (String(raw.countResetAt || '') !== fileEpoch) { skippedEpoch.push(sku); continue; }
    if (existing.has(sku)) continue;
    missing.push({ sku, data: raw });
  }

  const byStatus = {};
  for (const m of missing) { const s = m.data.status || '(ไม่มี status)'; byStatus[s] = (byStatus[s] || 0) + 1; }

  console.log('─────────── รายงาน ───────────');
  console.log(`ไฟล์            : ${name}`);
  console.log(`สาขา / รอบนับ   : ${fileBranch} / ${fileEpoch}`);
  console.log(`items ในไฟล์    : ${Object.keys(items).length}`);
  console.log(`มีอยู่บน Cloud   : ${existing.size}`);
  console.log(`หายไป (จะกู้)   : ${missing.length}`);
  if (skippedEpoch.length) console.log(`ข้าม (คนละรอบ)  : ${skippedEpoch.length}`);
  if (missing.length) console.table(byStatus);
  if (missing.length) console.log('ตัวอย่าง 10 รายการแรก:', missing.slice(0, 10).map((m) => `${m.sku}=${m.data.countedQty ?? '-'}/${m.data.status}`).join(', '));
  console.log('──────────────────────────────');

  if (!missing.length) { console.log('[restore] ✅ ไม่มีอะไรหาย — ไม่ต้องกู้'); return { missing: 0 }; }
  if (dryRun) {
    console.log(`[restore] ตรวจอย่างเดียว ยังไม่เขียนอะไรลง Cloud`);
    console.log(`[restore] ถ้ารายงานข้างบนถูกต้อง ให้รัน: await restoreItems({dryRun:false})`);
    return { dryRun: true, missing: missing.length, byStatus };
  }

  // ── 4. ยืนยันด้วยมือ ─────────────────────────────────────────────────────
  const phrase = `RESTORE ${currentBranch}`;
  const typed = prompt(`จะเขียน ${missing.length} รายการลงสาขา ${currentBranch}\n(ของที่มีอยู่แล้วจะไม่ถูกแตะ)\n\nพิมพ์ข้อความนี้เพื่อยืนยัน:\n${phrase}`);
  if (typed !== phrase) { console.log('[restore] ยกเลิก — ข้อความยืนยันไม่ตรง ไม่มีอะไรถูกเขียน'); return { cancelled: true }; }

  // ── 5. safety backup ของสภาพปัจจุบัน ก่อนแตะอะไรทั้งสิ้น ────────────────
  const safety = {};
  existingSnap.forEach((d) => { safety[d.id] = d.data(); });
  download(`pre-restore-${currentBranch}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    { __meta__: { branch: currentBranch, epoch: cloudEpoch, takenAt: new Date().toISOString(), note: 'สภาพ items บน Cloud ก่อนกู้คืน' }, session: sessionData, items: safety });
  console.log('[restore] ดาวน์โหลด safety backup ของสภาพปัจจุบันแล้ว');

  const stopped = pauseBackgroundWork();
  console.log('[restore] หยุดงานเบื้องหลังของหน้านี้:', stopped.join(', ') || '(ไม่มี)');

  // ── 6. เขียนทีละรายการด้วย transaction — สร้างใหม่เท่านั้น ห้ามทับ ──────
  let created = 0, skipped = 0;
  const failed = [];
  for (let i = 0; i < missing.length; i++) {
    const { sku, data } = missing[i];
    const payload = revive({ ...data });
    payload.sku = String(sku);
    payload.countResetAt = fileEpoch;
    payload.updatedBy = 'restore';
    payload.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    try {
      const res = await _db.runTransaction(async (tx) => {
        const snap = await tx.get(itemsRef.doc(sku));
        if (snap.exists) return 'exists';           // มีคนเขียนแทรกระหว่างทาง → ไม่แตะ
        tx.set(itemsRef.doc(sku), payload);
        return 'created';
      });
      if (res === 'created') created++; else skipped++;
    } catch (e) {
      failed.push({ sku, error: `${e.code || ''} ${e.message}`.trim() });
    }
    if ((i + 1) % 50 === 0) console.log(`[restore] ${i + 1}/${missing.length} …`);
    await new Promise((r) => setTimeout(r, CONCURRENCY_DELAY_MS));
  }

  // ── 7. ตรวจผลจาก server ──────────────────────────────────────────────────
  const afterSnap = await itemsRef.get({ source: 'server' });
  const after = new Set(afterSnap.docs.map((d) => d.id));
  const stillMissing = missing.filter((m) => !after.has(m.sku)).map((m) => m.sku);

  console.log('─────────── ผลการกู้คืน ───────────');
  console.log(`เขียนใหม่สำเร็จ : ${created}`);
  console.log(`ข้าม (มีอยู่แล้ว): ${skipped}`);
  console.log(`ล้มเหลว        : ${failed.length}`);
  console.log(`items บน Cloud  : ${existing.size} → ${after.size}`);
  if (failed.length) console.table(failed.slice(0, 20));
  if (stillMissing.length) console.warn('ยังหายอยู่:', stillMissing.slice(0, 20));
  console.log('───────────────────────────────────');
  console.log('[restore] ⚠️ โหลดหน้าเว็บใหม่ และให้ทุกเครื่องโหลดใหม่ด้วย เพื่อให้เห็นข้อมูลตรงกัน');

  return { created, skipped, failed, stillMissing, before: existing.size, after: after.size };
}

window.restoreItems = restoreItems;
console.log('[restore] พร้อมใช้งาน — ตรวจก่อนด้วย await restoreItems()  ·  เขียนจริงด้วย await restoreItems({dryRun:false})');
})();
