// Seed the emulator with the master-data doc set the app restores from.
// Doc shapes mirror the app's own writers:
//   {branch}_pm  (syncProductMasterToFirestore): { branch, data_json, row_count, cat_coded, updated_at_text }
//                 ← Product Branch Master: 1 doc ต่อสาขา (ส.ค. 2026 แทน global_pm เดิม)
//                   cat_coded is a console-only marker; the countable rule reads `cat` on the rows.
//                   pmCatCoded:false seeds pmRowsNoCat = a pre-ส.ค.-2026 file (no Col D anywhere).
//   global_r05   (syncMasterToFirestore):        { data_json }   ← ยัง global อยู่ (ใช้ร่วมทุกสาขา)
//   {branch}_r01 (+ syncR16MetaToFirestore):     { data_json, r01UploadedAt, r01Version, r16* meta }
const { adminDb } = require('./emulator');
const F = require('./fixtures');

async function seedMasters(projectId, { branch = 'SRC', r01Version = 'R01-TEST-1', pmCatCoded = true } = {}) {
  const db = adminDb(projectId);
  const pm = pmCatCoded ? F.pmRows : F.pmRowsNoCat;
  await Promise.all([
    db.doc(`stock_sessions/${branch}_pm`).set({
      branch,
      data_json: JSON.stringify(pm),
      row_count: pm.length,
      ...(pmCatCoded ? { cat_coded: true } : {}),
      updated_at_text: 'test-fixture',
    }),
    db.doc('stock_sessions/global_r05').set({ data_json: JSON.stringify(F.r05Rows) }),
    db.doc(`stock_sessions/${branch}_r01`).set({
      // r01CloudRows = shape loadR01 writes (col P already collapsed to `nc`) — not the raw CSV shape
      data_json: JSON.stringify(F.r01CloudRows),
      r01UploadedAt: 'test-fixture',
      r01Version,
      r16UploadedAt: '',
      r16Loaded: false,
      r16DetailVersion: '',
      r16_103UploadedAt: '',
      r16_103Loaded: false,
      r16_103DetailVersion: '',
    }, { merge: true }),
  ]);
}

// Pre-seed scan item docs for a given epoch (schema v2 subcollection).
// Field shape mirrors _scanItemPayload (index.html:1223): {sku, countResetAt, ...sd, rev, updatedBy}.
async function seedItems(projectId, branch, epoch, items) {
  const db = adminDb(projectId);
  const batch = db.batch();
  const now = new Date();
  const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  for (const it of items) {
    batch.set(db.doc(`stock_sessions/${branch}/items/${it.sku}`), {
      countResetAt: epoch,
      rev: 1,
      updatedBy: 'seed',
      timestamp: ts,
      scannedBy: it.scannedBy || 'Seeder',
      ...it,
    });
  }
  await batch.commit();
}

module.exports = { seedMasters, seedItems };
