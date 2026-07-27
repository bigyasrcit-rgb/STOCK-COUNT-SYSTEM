// Seed the emulator with the master-data doc set the app restores from.
// Doc shapes mirror the app's own writers:
//   global_pm  (syncProductMasterToFirestore index.html:5424): { data_json, row_count, updated_at_text }
//   global_r05 (syncMasterToFirestore :5407):                  { data_json }
//   {branch}_r01 (:5404 + syncR16MetaToFirestore :5417):       { data_json, r01UploadedAt, r01Version, r16* meta }
const { adminDb } = require('./emulator');
const F = require('./fixtures');

async function seedMasters(projectId, { branch = 'SRC', r01Version = 'R01-TEST-1' } = {}) {
  const db = adminDb(projectId);
  await Promise.all([
    db.doc('stock_sessions/global_pm').set({
      data_json: JSON.stringify(F.pmRows),
      row_count: F.pmRows.length,
      updated_at_text: 'test-fixture',
    }),
    db.doc('stock_sessions/global_r05').set({ data_json: JSON.stringify(F.r05Rows) }),
    db.doc(`stock_sessions/${branch}_r01`).set({
      data_json: JSON.stringify(F.r01Rows),
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
