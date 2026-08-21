// ★ Pending field test #2b (CLAUDE.md): Pharmacy Audit Verify on schema v2.
// Covers the July 2026 flow: PDA pharmacist rechecks (scan or inline edit) → Desktop confirms.
const { test, expect, closeApp, requireEmulator } = require('../../lib/hooks');
const { bootFreshCount, bootJoinCount, armR16, PROJECT_ID } = require('../../lib/scenario');
const { waitForDoc, getDoc } = require('../../lib/emulator');
const { seedItems } = require('../../lib/seed');

// Put SKUs straight into the audit worklist, as a first-round Confirm would.
async function seedAuditItems(epoch) {
  await seedItems(PROJECT_ID, 'SRC', epoch, [
    { sku: 'S-NORM', status: 'audit', auditStatus: 'pending', initialStatus: 'audit', countedQty: 8, scannedBy: 'PDA-A' },
    { sku: 'S-F05', status: 'audit', auditStatus: 'pending', initialStatus: 'audit', countedQty: 2, scannedBy: 'PDA-A' },
  ]);
}

// The audit marker is authoritative and overlays session state: a recheck draft entered BEFORE the
// marker lands is discarded (marker.countConfirmedAt must match sd.pharmacyAuditCountConfirmedAt to
// be kept). In production the marker is written at first-round Confirm, long before anyone rechecks —
// so wait for it here instead of racing it.
async function waitForAuditMarkerApplied(page, skus) {
  await page.waitForFunction(
    (list) => list.every((s) => !!state.scanData.get(s)?.pharmacyAuditCountConfirmedAt),
    skus, { timeout: 20000, polling: 100 },
  );
}

// The device has no pending item writes left: nothing queued and nothing in flight.
// Confirm's mid-work rev check aborts the batch if a write lands between its two server reads.
async function waitForPdaQuiet(page) {
  await page.waitForFunction(
    () => _dirtySkus.size === 0 && _scanItemInFlight.size === 0 && !_scanItemFlushing,
    null, { timeout: 20000, polling: 100 },
  );
}

test.describe('Pharmacy Audit Verify (schema v2)', () => {
  test.beforeEach(() => requireEmulator());
  test.setTimeout(90_000);

  test('recheck qty matching systemQty → pass; mismatch → stock_adjustment', async ({ browser }) => {
    const desk = await bootFreshCount(browser, { role: 'pharmacist', user: 'Pharm', mode: 'desktop' });
    await armR16(desk.page);
    await seedAuditItems(desk.epoch);

    const pda = await bootJoinCount(browser, { role: 'pharmacist', user: 'PharmPDA', mode: 'pda', expectEpoch: desk.epoch });
    await pda.page.waitForFunction(() => state.scanData.get('S-NORM')?.status === 'audit' &&
      state.scanData.get('S-F05')?.status === 'audit', null, { timeout: 15000, polling: 100 });
    await waitForAuditMarkerApplied(pda.page, ['S-NORM', 'S-F05']);

    // S-NORM sys 10 → recheck 10 = pass · S-F05 sys 5 → recheck 4 = stock_adjustment
    await pda.page.evaluate(() => {
      updatePharmacyRecheckQty('S-NORM', 10);
      updatePharmacyRecheckQty('S-F05', 4);
      return _flushDirtySkus();
    });
    await waitForDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-NORM', (d) => d && d.recheckQty === 10);
    await waitForDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-F05', (d) => d && d.recheckQty === 4);

    // Confirm re-reads the server and aborts the whole batch if any candidate's rev moved mid-work
    // (the production mid-work guard). A PDA still flushing trips it, so wait for it to go quiet
    // instead of racing — a real pharmacist never hits Confirm inside the PDA's write window.
    await waitForPdaQuiet(pda.page);

    await desk.page.evaluate(() => _confirmPharmacyAuditBatched());
    await desk.page.waitForFunction(() => _branchConfirming === false, null, { timeout: 30000, polling: 100 });

    const pass = await waitForDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-NORM', (d) => d && d.status === 'pass');
    const adj = await waitForDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-F05', (d) => d && d.status === 'stock_adjustment');
    expect(pass.auditor).toBe('Pharm');
    expect(adj.auditor).toBe('Pharm');
    expect(adj.recheckQty).toBe(4);
    expect(await getDoc(PROJECT_ID, 'stock_sessions/SRC_confirm_lock')).toBeNull();

    await closeApp(pda);
    await closeApp(desk);
  });

  test('audit items not yet rechecked stay in the worklist for the next round', async ({ browser }) => {
    const desk = await bootFreshCount(browser, { role: 'pharmacist', user: 'Pharm', mode: 'desktop' });
    await armR16(desk.page);
    await seedAuditItems(desk.epoch);

    const pda = await bootJoinCount(browser, { role: 'pharmacist', user: 'PharmPDA', mode: 'pda', expectEpoch: desk.epoch });
    await pda.page.waitForFunction(() => state.scanData.get('S-NORM')?.status === 'audit', null, { timeout: 15000, polling: 100 });
    await waitForAuditMarkerApplied(pda.page, ['S-NORM', 'S-F05']);

    await pda.page.evaluate(() => { updatePharmacyRecheckQty('S-NORM', 10); return _flushDirtySkus(); });
    await waitForDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-NORM', (d) => d && d.recheckQty === 10);
    await waitForPdaQuiet(pda.page);

    await desk.page.evaluate(() => _confirmPharmacyAuditBatched());
    await desk.page.waitForFunction(() => _branchConfirming === false, null, { timeout: 30000, polling: 100 });

    await waitForDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-NORM', (d) => d && d.status === 'pass');
    const untouched = await getDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-F05');
    expect(untouched.status).toBe('audit');
    expect(untouched.auditor || '').toBe('');

    await closeApp(pda);
    await closeApp(desk);
  });

  test('updatePharmacyRecheckQty: SET semantics, 0 allowed, negatives rejected, auditor guard', async ({ browser }) => {
    const desk = await bootFreshCount(browser, { role: 'pharmacist', user: 'Pharm', mode: 'desktop' });
    await seedItems(PROJECT_ID, 'SRC', desk.epoch, [
      { sku: 'S-NORM', status: 'audit', auditStatus: 'pending', initialStatus: 'audit', countedQty: 8, scannedBy: 'PDA-A' },
      { sku: 'S-F05', status: 'audit', auditStatus: 'approved', initialStatus: 'audit', countedQty: 2, scannedBy: 'PDA-A', auditor: 'SomeonePharm' },
    ]);
    const pda = await bootJoinCount(browser, { role: 'pharmacist', user: 'PharmPDA', mode: 'pda', expectEpoch: desk.epoch });
    await pda.page.waitForFunction(() => state.scanData.get('S-NORM')?.status === 'audit', null, { timeout: 15000, polling: 100 });
    await waitForAuditMarkerApplied(pda.page, ['S-NORM']);

    // SET (not accumulate): 7 then 3 → 3 · 0 = "รีเช็คแล้วไม่มีของ" ต้องบันทึกได้ · ติดลบถูกปฏิเสธ
    const out = await pda.page.evaluate(() => {
      updatePharmacyRecheckQty('S-NORM', 7);
      const afterFirst = state.scanData.get('S-NORM').recheckQty;
      updatePharmacyRecheckQty('S-NORM', 3);
      const afterSecond = state.scanData.get('S-NORM').recheckQty;
      updatePharmacyRecheckQty('S-NORM', 0);            // accepted (ส.ค. 2026)
      const afterZero = state.scanData.get('S-NORM').recheckQty;
      const inPendingAtZero = getPharmacistAuditPendingMap().has('S-NORM');
      updatePharmacyRecheckQty('S-NORM', -2);           // rejected — ติดลบ
      const afterNegative = state.scanData.get('S-NORM').recheckQty;
      updatePharmacyRecheckQty('S-F05', 9);             // rejected — already has auditor
      const guarded = state.scanData.get('S-F05').recheckQty;
      return { afterFirst, afterSecond, afterZero, inPendingAtZero, afterNegative, guarded, by: state.scanData.get('S-NORM').recheckBy };
    });
    expect(out.afterFirst).toBe(7);
    expect(out.afterSecond).toBe(3);
    expect(out.afterZero).toBe(0);
    expect(out.inPendingAtZero).toBe(true);   // 0 ต้องเข้าคิวยืนยัน ไม่ค้าง audit ถาวร
    expect(out.afterNegative).toBe(0);        // ค่าติดลบไม่ถูกเขียนทับ
    expect(out.guarded).toBeUndefined();
    expect(out.by).toBe('PharmPDA');

    await pda.page.evaluate(() => _flushDirtySkus());
    await waitForDoc(PROJECT_ID, 'stock_sessions/SRC/items/S-NORM', (d) => d && d.recheckQty === 0);

    await closeApp(pda);
    await closeApp(desk);
  });
});
