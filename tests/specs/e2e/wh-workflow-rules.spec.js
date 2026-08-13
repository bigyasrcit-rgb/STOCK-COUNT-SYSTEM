// WH workflow provenance is an authoritative same-epoch marker. A delayed PDA may still hold an
// old scanning/audit snapshot, so rules must reject any write which removes or changes an existing
// whCountOpId/whRecheckOpId. Starting a genuinely newer epoch remains allowed.
const { test, expect, closeApp, requireEmulator } = require('../../lib/hooks');
const { bootFreshCount, PROJECT_ID } = require('../../lib/scenario');
const { getDoc } = require('../../lib/emulator');
const { makeWhCountItem, makeAuditItem } = require('../../lib/wh-workflow');

test.describe('firestore.rules — WH workflow provenance guard', () => {
  test.beforeEach(() => requireEmulator());
  test.setTimeout(60_000);

  test('same epoch cannot remove/change whCountOpId; recheck draft preserving it is allowed', async ({ browser }) => {
    const app = await bootFreshCount(browser, { branch: 'WH', role: 'warehouse', user: 'มุก', mode: 'pda' });
    const base = makeAuditItem(makeWhCountItem({ sku: 'S-NORM', epoch: app.epoch, qty: 8, staff: 'มุก' }), {
      systemQty: 10,
    });
    await app.page.evaluate(async ({ base }) => {
      await getScanItemsRef().doc(base.sku).set({ ...base, whCountOpId: 'count-op-1' });
    }, { base });

    const result = await app.page.evaluate(async ({ epoch }) => {
      const ref = getScanItemsRef().doc('S-NORM');
      const attempt = async (data) => {
        try { await ref.set(data, { merge: false }); return 'ALLOWED'; }
        catch (e) { return e.code || String(e); }
      };
      const snap = await ref.get({ source: 'server' });
      const current = snap.data();
      const withoutCountMarker = { ...current }; delete withoutCountMarker.whCountOpId;
      let createWithMarker;
      try {
        const extra = getScanItemsRef().doc('S-F09');
        await extra.set({
          sku: 'S-F09', countResetAt: epoch, status: 'pass', countedQty: 9,
          scannedBy: 'มุก', rev: 1, whCountOpId: 'count-op-created',
        });
        await extra.delete();
        createWithMarker = 'ALLOWED';
      } catch (e) { createWithMarker = e.code || String(e); }
      return {
        removeMarker: await attempt(withoutCountMarker),
        changeMarker: await attempt({ ...current, whCountOpId: 'count-op-other' }),
        preserveWithDraft: await attempt({
          ...current,
          recheckQty: 10,
          recheckBy: 'มุก',
          recheckAt: new Date().toISOString(),
          whCountOpId: 'count-op-1',
        }),
        // A later startNewCount epoch intentionally replaces the whole item lifecycle.
        newerEpoch: await attempt({
          sku: 'S-NORM', countResetAt: `${epoch}-new`, status: 'scanning', countedQty: 1,
          scannedBy: 'มุก', rev: Number(current.rev || 0) + 1,
        }),
        olderEpoch: await attempt({
          sku: 'S-NORM', countResetAt: epoch, status: 'scanning', countedQty: 1,
          scannedBy: 'มุก', rev: Number(current.rev || 0) + 2,
        }),
        createWithMarker,
      };
    }, { epoch: app.epoch });

    expect(result.removeMarker).toBe('permission-denied');
    expect(result.changeMarker).toBe('permission-denied');
    expect(result.preserveWithDraft).toBe('ALLOWED');
    expect(result.newerEpoch).toBe('ALLOWED');
    expect(result.olderEpoch).toBe('permission-denied');
    expect(result.createWithMarker).toBe('ALLOWED');
    expect((await getDoc(PROJECT_ID, 'stock_sessions/WH/items/S-NORM')).countResetAt).toBe(`${app.epoch}-new`);

    await closeApp(app);
  });

  test('same epoch cannot remove/change whRecheckOpId', async ({ browser }) => {
    const app = await bootFreshCount(browser, { branch: 'WH', role: 'warehouse', user: 'ตั๋ง', mode: 'pda' });
    const item = {
      ...makeWhCountItem({ sku: 'S-F05', epoch: app.epoch, qty: 5, staff: 'ตั๋ง', status: 'pass' }),
      status: 'pass', auditStatus: 'approved', auditor: 'มายด์',
      whCountOpId: 'count-op-2', whRecheckOpId: 'recheck-op-1',
    };
    await app.page.evaluate((data) => getScanItemsRef().doc(data.sku).set(data), item);

    const result = await app.page.evaluate(async () => {
      const ref = getScanItemsRef().doc('S-F05');
      const current = (await ref.get({ source: 'server' })).data();
      const attempt = async (data) => {
        try { await ref.set(data); return 'ALLOWED'; }
        catch (e) { return e.code || String(e); }
      };
      const removed = { ...current }; delete removed.whRecheckOpId;
      return {
        removeMarker: await attempt(removed),
        changeMarker: await attempt({ ...current, whRecheckOpId: 'recheck-op-other' }),
        keepBoth: await attempt({ ...current, updatedBy: 'listener-reconcile' }),
      };
    });

    expect(result.removeMarker).toBe('permission-denied');
    expect(result.changeMarker).toBe('permission-denied');
    expect(result.keepBoth).toBe('ALLOWED');

    await closeApp(app);
  });

  test('operation publish is monotonic and staged result documents are immutable', async ({ browser }) => {
    const app = await bootFreshCount(browser, { branch: 'WH', role: 'supervisor', user: 'มายด์', mode: 'desktop' });
    const result = await app.page.evaluate(async ({ epoch }) => {
      const op = getWhConfirmOpsRef().doc('rules-op-1');
      const staged = op.collection('results').doc('S-NORM');
      const attempt = async (fn) => {
        try { await fn(); return 'ALLOWED'; }
        catch (e) { return e.code || String(e); }
      };
      const opData = {
        kind: 'count', state: 'preparing', countResetAt: epoch, staffName: null,
        candidateCount: 1, candidateHash: 'fixture-hash', r01Version: 'R01-TEST-1',
        r16Version: 'R16-WH-TEST-1', r16_103Version: '', owner: 'มายด์',
        createdAt: new Date().toISOString(), committedAt: null,
      };
      const createOp = await attempt(() => op.set(opData));
      const createResult = await attempt(() => staged.set({
        opId: 'rules-op-1', kind: 'count', sku: 'S-NORM', countResetAt: epoch,
        sourceRev: 1, sourceAt: new Date().toISOString(), status: 'pass', countedQty: 10,
      }));
      const mutateResult = await attempt(() => staged.update({ countedQty: 99 }));
      const commit = await attempt(() => op.update({ state: 'committed', committedAt: new Date().toISOString() }));
      const reopen = await attempt(() => op.update({ state: 'preparing', committedAt: null }));
      const abortAfterCommit = await attempt(() => op.update({ state: 'aborted' }));
      const abortedOp = getWhConfirmOpsRef().doc('rules-op-2');
      const createAbortable = await attempt(() => abortedOp.set({ ...opData, state: 'preparing' }));
      const abort = await attempt(() => abortedOp.update({ state: 'aborted' }));
      const mutateAborted = await attempt(() => abortedOp.update({ state: 'preparing' }));
      const deleteResult = await attempt(() => staged.delete());
      const deleteCommittedOp = await attempt(() => op.delete());
      const deleteAbortedOp = await attempt(() => abortedOp.delete());
      return { createOp, createResult, mutateResult, commit, reopen, abortAfterCommit,
        createAbortable, abort, mutateAborted, deleteResult, deleteCommittedOp, deleteAbortedOp };
    }, { epoch: app.epoch });

    expect(result.createOp).toBe('ALLOWED');
    expect(result.createResult).toBe('ALLOWED');
    expect(result.mutateResult).toBe('permission-denied');
    expect(result.commit).toBe('ALLOWED');
    expect(result.reopen).toBe('permission-denied');
    expect(result.abortAfterCommit).toBe('permission-denied');
    expect(result.createAbortable).toBe('ALLOWED');
    expect(result.abort).toBe('ALLOWED');
    expect(result.mutateAborted).toBe('permission-denied');
    expect(result.deleteResult).toBe('ALLOWED');
    expect(result.deleteCommittedOp).toBe('ALLOWED');
    expect(result.deleteAbortedOp).toBe('ALLOWED');

    await closeApp(app);
  });

  test('legacy WH final documents are read/delete-only after workflow-v2 cutover', async ({ browser }) => {
    const app = await bootFreshCount(browser, { branch: 'WH', role: 'supervisor', user: 'Supervisor', mode: 'desktop' });
    const created = await app.page.evaluate(async () => {
      const attempt = async (fn) => {
        try { await fn(); return 'ALLOWED'; }
        catch (e) { return e.code || String(e); }
      };
      const sessions = _db.collection('stock_sessions');
      return {
        count: await attempt(() => sessions.doc('WH_count_confirmations').set({ S1: { status: 'pass' } })),
        recheck: await attempt(() => sessions.doc('WH_recheck_confirmations').set({ S1: { status: 'pass' } })),
      };
    });
    expect(created).toEqual({ count: 'permission-denied', recheck: 'permission-denied' });

    const { adminDb } = require('../../lib/emulator');
    const db = adminDb(PROJECT_ID);
    await db.doc('stock_sessions/WH_count_confirmations').set({ S1: { status: 'pass' } });
    await db.doc('stock_sessions/WH_recheck_confirmations').set({ S1: { status: 'pass' } });
    const existing = await app.page.evaluate(async () => {
      const attempt = async (fn) => {
        try { await fn(); return 'ALLOWED'; }
        catch (e) { return e.code || String(e); }
      };
      const sessions = _db.collection('stock_sessions');
      const count = sessions.doc('WH_count_confirmations');
      const recheck = sessions.doc('WH_recheck_confirmations');
      return {
        countRead: (await count.get({ source: 'server' })).exists,
        recheckRead: (await recheck.get({ source: 'server' })).exists,
        countUpdate: await attempt(() => count.update({ 'S2.status': 'pass' })),
        recheckUpdate: await attempt(() => recheck.update({ 'S2.status': 'pass' })),
        countDelete: await attempt(() => count.delete()),
        recheckDelete: await attempt(() => recheck.delete()),
      };
    });
    expect(existing).toEqual({
      countRead: true,
      recheckRead: true,
      countUpdate: 'permission-denied',
      recheckUpdate: 'permission-denied',
      countDelete: 'ALLOWED',
      recheckDelete: 'ALLOWED',
    });
    await closeApp(app);
  });

  test('the provenance guard does not alter non-WH item behavior', async ({ browser }) => {
    const app = await bootFreshCount(browser, { branch: 'SRC', role: 'assistant', user: 'PDA-A', mode: 'pda' });
    const result = await app.page.evaluate(async () => {
      const ref = getScanItemsRef().doc('S-NORM');
      await ref.set({
        sku: 'S-NORM', countResetAt: _countResetAt, status: 'pass', countedQty: 10,
        rev: 1, whCountOpId: 'irrelevant-on-src',
      });
      try {
        await ref.set({
          sku: 'S-NORM', countResetAt: _countResetAt, status: 'scanning', countedQty: 1,
          rev: 2, whCountOpId: 'changed-on-src',
        });
        return 'ALLOWED';
      } catch (e) { return e.code || String(e); }
    });
    expect(result).toBe('ALLOWED');
    await closeApp(app);
  });
});
