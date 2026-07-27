// firestore.rules preservesScanSchemaVersion(): once a branch is on schema v2, a client must not
// downgrade it or replace the session doc in a way that drops the field (an old v1 client's set()).
// Must run through the PAGE's web SDK — firebase-admin bypasses rules.
const { test, expect, closeApp, requireEmulator } = require('../../lib/hooks');
const { bootFreshCount, PROJECT_ID } = require('../../lib/scenario');
const { getDoc } = require('../../lib/emulator');

test.describe('firestore.rules — schema v2 guard', () => {
  test.beforeEach(() => requireEmulator());
  test.setTimeout(60_000);

  test('v2 session doc: downgrade rejected, same-version update allowed, v1-style set() rejected', async ({ browser }) => {
    const app = await bootFreshCount(browser, { role: 'pharmacist', user: 'Pharm', mode: 'desktop' });
    expect(Number((await getDoc(PROJECT_ID, 'stock_sessions/SRC')).schemaVersion)).toBe(2);

    const res = await app.page.evaluate(async () => {
      const ref = _db.collection('stock_sessions').doc('SRC');
      const attempt = async (fn) => { try { await fn(); return 'ALLOWED'; } catch (e) { return e.code || String(e); } };
      return {
        downgrade: await attempt(() => ref.update({ schemaVersion: 1 })),
        sameVersion: await attempt(() => ref.update({ schemaVersion: 2, updated_at: new Date().toISOString() })),
        higher: await attempt(() => ref.update({ schemaVersion: 3 })),
        v1StyleSet: await attempt(() => ref.set({ session_data_json: '{}', updated_at: 'x' })), // drops schemaVersion
        mergeKeepsField: await attempt(() => ref.set({ updated_at: 'y' }, { merge: true })),
      };
    });

    expect(res.downgrade).toBe('permission-denied');
    expect(res.sameVersion).toBe('ALLOWED');
    expect(res.higher).toBe('ALLOWED');
    expect(res.v1StyleSet).toBe('permission-denied');
    expect(res.mergeKeepsField).toBe('ALLOWED');

    // guard must have held: the doc is still v2
    const after = await getDoc(PROJECT_ID, 'stock_sessions/SRC');
    expect(Number(after.schemaVersion)).toBeGreaterThanOrEqual(2);

    await closeApp(app);
  });

  test('items subcollection stays writable (guard applies to the parent only)', async ({ browser }) => {
    const app = await bootFreshCount(browser, { role: 'pharmacist', user: 'Pharm', mode: 'desktop' });
    const out = await app.page.evaluate(async () => {
      try {
        await _db.collection('stock_sessions').doc('SRC').collection('items').doc('S-RULE')
          .set({ sku: 'S-RULE', countResetAt: _countResetAt, status: 'scanning', countedQty: 1, rev: 1 });
        return 'ALLOWED';
      } catch (e) { return e.code || String(e); }
    });
    expect(out).toBe('ALLOWED');
    await closeApp(app);
  });
});
