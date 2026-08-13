// WH Recheck staged operation plus the cross-version safety property: an old/delayed PDA audit
// snapshot must never regress a committed final result.
const { test, expect, closeApp, requireEmulator } = require('../../lib/hooks');
const { bootFreshCount, bootJoinCount, PROJECT_ID } = require('../../lib/scenario');
const { getDoc, waitForDoc } = require('../../lib/emulator');
const {
  makeWhCountItem,
  makeAuditItem,
  makeLegacyRecheckInbox,
  seedWhWorkflow,
  listWhConfirmOps,
  readWhConfirmResults,
} = require('../../lib/wh-workflow');

test.describe('WH staged Recheck confirmation', () => {
  test.beforeEach(() => requireEmulator());
  test.setTimeout(120_000);

  test('commits Recheck result; later stale audit replace is denied and cannot regress final', async ({ browser }) => {
    const desk = await bootFreshCount(browser, { branch: 'WH', role: 'supervisor', user: 'มายด์', mode: 'desktop' });
    const counted = makeWhCountItem({ sku: 'S-NORM', epoch: desk.epoch, qty: 8, staff: 'มุก' });
    // This is a legacy-compatible audit draft, so it deliberately has no whCountOpId. An item
    // carrying operation provenance without the matching committed parent/result is invalid and
    // the production reader must (correctly) defer it rather than exposing an unverified final.
    const audit = makeAuditItem(counted, { systemQty: 10 });
    const recheck = makeLegacyRecheckInbox(audit, { qty: 10, staff: 'ตั๋ง' });
    const draft = { ...audit, ...recheck };
    await seedWhWorkflow(PROJECT_ID, {
      items: [draft],
      recheckInbox: { 'S-NORM': recheck },
    });

    const pda = await bootJoinCount(browser, {
      branch: 'WH', role: 'warehouse', user: 'ตั๋ง', mode: 'pda', expectEpoch: desk.epoch,
    });
    await Promise.all([
      desk.page.waitForFunction(() => state.scanData.get('S-NORM')?.status === 'audit' &&
        state.scanData.get('S-NORM')?.recheckQty === 10, null, { timeout: 25_000, polling: 100 }),
      pda.page.waitForFunction(() => state.scanData.get('S-NORM')?.status === 'audit' &&
        state.scanData.get('S-NORM')?.recheckQty === 10, null, { timeout: 25_000, polling: 100 }),
    ]);

    // Preserve exactly what a delayed pre-commit PDA would try to write later.
    const stalePdaSnapshot = await pda.page.evaluate(() => {
      const sd = state.scanData.get('S-NORM');
      const { retries, scans, manualEditAt, ...cloud } = sd;
      return {
        sku: 'S-NORM', countResetAt: _countResetAt || '',
        rev: (_scanItemRev.get('S-NORM') || 0) + 1, updatedBy: currentUser || '', ...cloud,
      };
    });

    await desk.page.evaluate(() => _confirmWhRecheckItems());
    await desk.page.waitForFunction(() => !_whRecheckConfirming, null, { timeout: 60_000, polling: 100 });

    const ops = await listWhConfirmOps(PROJECT_ID, { kind: 'recheck', state: 'committed' });
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op.candidateCount).toBe(1);
    expect(op.countResetAt).toBe(desk.epoch);
    const results = await readWhConfirmResults(PROJECT_ID, op.id);
    expect(Object.keys(results)).toEqual(['S-NORM']);
    expect(results['S-NORM']).toMatchObject({
      opId: op.id,
      kind: 'recheck',
      sku: 'S-NORM',
      status: 'pass',
      recheckQty: 10,
      systemQty: 10,
      countResetAt: desk.epoch,
    });
    expect(results['S-NORM']).toHaveProperty('sourceRev');
    expect(results['S-NORM'].sourceAt).toBeTruthy();

    await waitForDoc(PROJECT_ID, 'stock_sessions/WH/items/S-NORM',
      (d) => d?.status === 'pass' && d.whRecheckOpId === op.id,
      { timeout: 45_000 });

    const staleWrite = await pda.page.evaluate(async (data) => {
      try { await getScanItemsRef().doc('S-NORM').set(data, { merge: false }); return 'ALLOWED'; }
      catch (e) { return e.code || String(e); }
    }, stalePdaSnapshot);
    expect(staleWrite).toBe('permission-denied');

    const final = await getDoc(PROJECT_ID, 'stock_sessions/WH/items/S-NORM');
    expect(final.status).toBe('pass');
    expect(final.auditor).toBe('มายด์');
    expect(final.whRecheckOpId).toBe(op.id);
    expect(Object.keys((await getDoc(PROJECT_ID, 'stock_sessions/WH_recheck_confirmations')) || {})).toHaveLength(0);

    // The committed operation listener remains authoritative even on the PDA holding the stale draft.
    await pda.page.waitForFunction((id) => state.scanData.get('S-NORM')?.status === 'pass' &&
      state.scanData.get('S-NORM')?.whRecheckOpId === id, op.id, { timeout: 30_000, polling: 100 });

    await closeApp(pda);
    await closeApp(desk);
  });
});

test.describe('WH confirmation lock', () => {
  test.beforeEach(() => requireEmulator());
  test.setTimeout(60_000);

  test('an active WH Desktop lock pauses PDA scan processing until release', async ({ browser }) => {
    const desk = await bootFreshCount(browser, { branch: 'WH', role: 'supervisor', user: 'มายด์', mode: 'desktop' });
    const pda = await bootJoinCount(browser, {
      branch: 'WH', role: 'warehouse', user: 'มุก', mode: 'pda', expectEpoch: desk.epoch,
    });

    await desk.page.evaluate(async () => { window.__testWhLockToken = await _acquireBranchConfirmLock(); });
    await pda.page.waitForFunction(() => _branchScanPaused && document.getElementById('scanInput')?.disabled,
      null, { timeout: 20_000, polling: 100 });

    const blocked = await pda.page.evaluate(() => {
      scanQueue.push(parseScanLine('B-F09'));
      drainQueue();
      const sd = state.scanData.get('S-F09');
      return { status: sd?.status, qty: sd?.countedQty, queued: scanQueue.length, paused: _branchScanPaused };
    });
    expect(blocked).toMatchObject({ status: 'pending', qty: 0, queued: 1, paused: true });

    await desk.page.evaluate(() => _releaseBranchConfirmLock(window.__testWhLockToken));
    await pda.page.waitForFunction(() => !_branchScanPaused && state.scanData.get('S-F09')?.status === 'scanning' &&
      state.scanData.get('S-F09')?.countedQty === 1, null, { timeout: 20_000, polling: 100 });

    expect(await getDoc(PROJECT_ID, 'stock_sessions/WH_confirm_lock')).toBeNull();
    await closeApp(pda);
    await closeApp(desk);
  });
});
