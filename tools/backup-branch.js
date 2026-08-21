/*
 * Read-only Firestore backup — ดาวน์โหลดข้อมูลรอบนับทั้งหมดเป็นไฟล์ JSON ก่อน deploy/เริ่มนับใหม่
 *
 * วิธีใช้ (Desktop เท่านั้น · ต้อง login เข้าสาขาที่จะ backup แล้ว):
 *   1. เปิดแอป → login → กด F12 → แท็บ Console
 *   2. วางไฟล์นี้ทั้งไฟล์ แล้ว Enter
 *   3. backup สาขาที่ login อยู่:      await backupBranch()
 *      backup สาขาอื่นด้วย (ไม่ต้องสลับสาขา):  await backupBranch('KKL')
 *      backup ทุกสาขารวดเดียว:        await backupAllBranches()
 *   4. เบราว์เซอร์จะดาวน์โหลดไฟล์ .json ให้ — เก็บไว้ในที่ปลอดภัย
 *
 * Safety properties:
 * - อ่านอย่างเดียว 100% — ใช้เฉพาะ .get() ไม่มี set/update/delete/transaction ที่ไหนเลย
 * - บังคับอ่านจาก server ({source:'server'}) ไม่ยอมรับข้อมูลจาก cache
 *   (backup ที่มาจาก cache อาจเก่ากว่าของจริง = อันตรายกว่าไม่ backup)
 * - ไม่แตะ state ของหน้าเว็บ ไม่หยุด listener ไม่ยกเลิก timer — สแกนต่อได้ระหว่างรัน
 * - ถ้าอ่าน collection ไหนไม่ผ่าน จะบันทึก error ไว้ในไฟล์และรายงาน ไม่ทิ้งเงียบ
 *
 * ⚠️ ค่าใช้จ่าย Firestore: อ่าน 1 read ต่อ 1 document
 *   สาขายาที่นับครบ ~5,400 items → ~5,500 reads/สาขา · 4 สาขา ≈ 20,000 reads
 *   Spark มี 50,000 reads/วัน — ทำได้ แต่ควรทำครั้งเดียว และเลี่ยงช่วงพนักงานสแกนหนัก
 *   ดูจำนวน read จริงได้จากบรรทัดสรุปตอนจบ
 */
(() => {
'use strict';

const ALL_BRANCHES = ['SRC', 'KKL', 'SSS', 'WH'];
const AUDIT_LOG_DAYS = 60;

let reads = 0;

// Firestore Timestamp / Date → รูปแบบที่ JSON เก็บได้และดูออกว่าเดิมเป็น timestamp
function serialize(v) {
  if (v === null || v === undefined) return v;
  if (typeof v.toDate === 'function') return { __ts__: v.toDate().toISOString() };
  if (v instanceof Date) return { __ts__: v.toISOString() };
  if (Array.isArray(v)) return v.map(serialize);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = serialize(v[k]);
    return out;
  }
  return v;
}

async function readDoc(path) {
  try {
    const snap = await _db.doc(path).get({ source: 'server' });
    reads++;
    return snap.exists ? serialize(snap.data()) : null;
  } catch (e) {
    return { __error__: `${e.code || ''} ${e.message}`.trim() };
  }
}

async function readCollection(ref, label) {
  try {
    const snap = await ref.get({ source: 'server' });
    reads += snap.size;
    const out = {};
    snap.forEach((d) => { out[d.id] = serialize(d.data()); });
    return out;
  } catch (e) {
    console.warn(`[backup] อ่าน ${label} ไม่สำเร็จ:`, e.message);
    return { __error__: `${e.code || ''} ${e.message}`.trim() };
  }
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// stock_audit_log ใช้ documentId = {branch}_{YYYY-MM-DD} → ดึงเป็นช่วงแทนการ scan ทั้ง collection
async function readAuditLog(branch) {
  const from = new Date();
  from.setDate(from.getDate() - AUDIT_LOG_DAYS);
  try {
    const snap = await _db.collection('stock_audit_log')
      .orderBy(firebase.firestore.FieldPath.documentId())
      .startAt(`${branch}_${dateKey(from)}`)
      .endAt(`${branch}_9999-99-99`)
      .get({ source: 'server' });
    reads += snap.size;
    const out = {};
    snap.forEach((d) => { out[d.id] = serialize(d.data()); });
    return out;
  } catch (e) {
    console.warn('[backup] อ่าน stock_audit_log ไม่สำเร็จ:', e.message);
    return { __error__: `${e.code || ''} ${e.message}`.trim() };
  }
}

// WH: operation หนึ่งอันมี results เป็น subcollection ต้องตามเข้าไปเก็บด้วย
async function readWhConfirmOps() {
  const ops = {};
  try {
    const parents = await _db.collection('stock_sessions').doc('WH').collection('confirm_ops').get({ source: 'server' });
    reads += parents.size;
    for (const op of parents.docs) {
      const results = await readCollection(op.ref.collection('results'), `confirm_ops/${op.id}/results`);
      ops[op.id] = { ...serialize(op.data()), results };
    }
  } catch (e) {
    console.warn('[backup] อ่าน WH confirm_ops ไม่สำเร็จ:', e.message);
    return { __error__: `${e.code || ''} ${e.message}`.trim() };
  }
  return ops;
}

function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return blob.size;
}

async function backupBranch(branch) {
  if (typeof _db === 'undefined' || !_db) throw new Error('ยังไม่ได้เชื่อมต่อ Firestore — เปิดแอปและ login ก่อน');
  branch = branch || (typeof currentBranch !== 'undefined' ? currentBranch : '');
  if (!branch) throw new Error('ไม่รู้ว่าจะ backup สาขาไหน — ใส่ชื่อสาขา เช่น backupBranch("SRC")');

  const startedAt = new Date();
  const before = reads;
  console.log(`[backup] เริ่ม ${branch} — อ่านจาก server เท่านั้น (ห้ามปิดหน้าเว็บจนกว่าจะเสร็จ)`);

  const S = (n) => `stock_sessions/${n}`;
  const data = {
    __meta__: {
      branch,
      startedAt: startedAt.toISOString(),
      takenBy: (typeof currentUser !== 'undefined' && currentUser) || '',
      appUrl: location.href,
      note: 'read-only backup — ไฟล์นี้ไม่มีผลกับระบบจนกว่าจะมีคนเขียนสคริปต์กู้คืนโดยเฉพาะ',
    },
    session: await readDoc(S(branch)),
    items: await readCollection(_db.collection('stock_sessions').doc(branch).collection('items'), `${branch}/items`),
    r01: await readDoc(S(`${branch}_r01`)),
    adjlot: await readDoc(S(`${branch}_adjlot`)),
    confirmLock: await readDoc(S(`${branch}_confirm_lock`)),
    v1Backup: await readDoc(S(`${branch}_v1_backup`)),
    productBranchMaster: await readDoc(S(`${branch}_pm`)),
    auditLog: await readAuditLog(branch),
  };

  if (branch === 'WH') {
    data.whCounts = await readDoc(S('WH_counts'));
    data.whCountConfirmations = await readDoc(S('WH_count_confirmations'));
    data.whRechecks = await readDoc(S('WH_rechecks'));
    data.whRecheckConfirmations = await readDoc(S('WH_recheck_confirmations'));
    data.whR16_104_meta = await readDoc(S('WH_r16_104_meta'));
    data.whR16_103_meta = await readDoc(S('WH_r16_103_meta'));
    data.whLocation = await readDoc(S('WH_location'));
    data.whConfirmOps = await readWhConfirmOps();
  } else {
    data.pharmacyAuditMarkers = await readDoc(S(`${branch}_pharmacy_audit_markers`));
  }

  // master ที่ใช้ร่วมทุกสาขา — เก็บติดไปทุกไฟล์ เผื่อกู้จากไฟล์เดียวได้จบ
  data.globalR05 = await readDoc(S('global_r05'));
  data.globalPm = await readDoc(S('global_pm'));

  // สรุปให้ตรวจด้วยตาว่าได้ของครบจริง
  const items = data.items && !data.items.__error__ ? data.items : {};
  const byStatus = {};
  for (const it of Object.values(items)) {
    const s = it && it.status ? it.status : '(ไม่มี status)';
    byStatus[s] = (byStatus[s] || 0) + 1;
  }
  const epoch = (() => {
    try { return JSON.parse(data.session?.session_data_json || '{}').countResetAt || ''; } catch (e) { return ''; }
  })();

  data.__meta__.summary = {
    epoch,
    schemaVersion: data.session?.schemaVersion ?? 1,
    itemCount: Object.keys(items).length,
    byStatus,
    r01Rows: (() => { try { return JSON.parse(data.r01?.data_json || '[]').length; } catch (e) { return null; } })(),
    readsUsed: reads - before,
  };

  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const bytes = download(`backup-${branch}-${stamp}.json`, data);

  console.log(`[backup] ✅ ${branch} เสร็จ — items ${data.__meta__.summary.itemCount} · ${Math.round(bytes / 1024)} KB · ใช้ ${reads - before} reads`);
  console.table(byStatus);
  return data.__meta__.summary;
}

async function backupAllBranches(list) {
  const branches = list || ALL_BRANCHES;
  const before = reads;
  const out = {};
  for (const b of branches) {
    try { out[b] = await backupBranch(b); }
    catch (e) { out[b] = { error: e.message }; console.error(`[backup] ${b} ล้มเหลว:`, e.message); }
  }
  console.log(`[backup] รวมทุกสาขา — ใช้ ${reads - before} reads`);
  console.table(out);
  return out;
}

window.backupBranch = backupBranch;
window.backupAllBranches = backupAllBranches;
console.log('[backup] พร้อมใช้งาน — เรียก await backupBranch() หรือ await backupAllBranches()');
})();
