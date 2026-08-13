// WH Count confirmation on the per-SKU staged-operation protocol.
// Covers the production-sized (>500 SKU) case which cannot fit into one Firestore write transaction,
// plus the compatibility bridge where an old PDA has written the same count to WH_counts.
const { test, expect, closeApp, requireEmulator } = require('../../lib/hooks');
const { bootFreshCount, bootJoinCount, armWhR16, PROJECT_ID } = require('../../lib/scenario');
const { adminDb, getDoc, waitForDoc } = require('../../lib/emulator');
const F = require('../../lib/fixtures');
const {
  WH_CONFIRM_OP,
  makeWhCountItem,
  makeLegacyCountInbox,
  makeLegacyCountMarker,
  makeManyPending,
  seedWhWorkflow,
  listWhConfirmOps,
  readWhConfirmResults,
  readCollectionMap,
} = require('../../lib/wh-workflow');

async function extendWhR01(rows) {
  const ref = adminDb(PROJECT_ID).doc('stock_sessions/WH_r01');
  const snap = await ref.get();
  const data = snap.data() || {};
  await ref.set({ ...data, data_json: JSON.stringify([...F.r01Rows, ...rows]) });
}

async function waitForLocalScanning(page, count, { timeout = 45_000 } = {}) {
  await page.waitForFunction((n) => {
    let found = 0;
    for (const item of state.scanData.values()) if (item?.status === 'scanning') found += 1;
    return found >= n;
  }, count, { timeout, polling: 100 });
}

function expectOpContract(op, { kind, epoch, count, staffName }) {
  expect(op.kind).toBe(kind);
  expect(op.state).toBe('committed');
  expect(op.countResetAt).toBe(epoch);
  expect(op.staffName || null).toBe(staffName || null);
  expect(op.candidateCount).toBe(count);
  expect(typeof op.candidateHash).toBe('string');
  expect(op.candidateHash.length).toBeGreaterThan(0);
  expect(op.r01Version).toBe('R01-TEST-1');
  expect(op.r16Version).toBe('R16-WH-TEST-1');
  expect(op.r16_103Version || '').toBe('');
  expect(op.owner).toBe('มายด์');
  expect(op.createdAt).toBeTruthy();
  expect(op.committedAt).toBeTruthy();
  for (const field of WH_CONFIRM_OP.fields) expect(op, `operation missing ${field}`).toHaveProperty(field);
}

function expectResultContract(result, { opId, kind, sku, epoch }) {
  expect(result.opId).toBe(opId);
  expect(result.kind).toBe(kind);
  expect(result.sku).toBe(sku);
  expect(result.countResetAt).toBe(epoch);
  expect(Number.isFinite(Number(result.sourceRev))).toBe(true);
  expect(result.sourceAt).toBeTruthy();
  for (const field of WH_CONFIRM_OP.resultFields) expect(result, `result missing ${field}`).toHaveProperty(field);
}

test.describe('WH staged Count confirmation', () => {
  test.beforeEach(() => requireEmulator());
  test.setTimeout(240_000);

  test('Confirm-All commits 577 per-SKU results and never grows WH_count_confirmations', async ({ browser }) => {
    const desk = await bootFreshCount(browser, { branch: 'WH', role: 'supervisor', user: 'มายด์', mode: 'desktop' });
    const fixture = makeManyPending({ count: 577, epoch: desk.epoch, prefix: 'WH-SCALE-' });
    await extendWhR01(fixture.r01Rows);
    await seedWhWorkflow(PROJECT_ID, { items: fixture.items, countInbox: fixture.countInbox });
    await waitForLocalScanning(desk.page, 577);
    await armWhR16(desk.page);

    const legacyBefore = await getDoc(PROJECT_ID, 'stock_sessions/WH_count_confirmations');
    expect(Object.keys(legacyBefore || {})).toHaveLength(0);

    await desk.page.evaluate(() => _confirmWhCountItems());
    await desk.page.waitForFunction(() => !_whCountConfirming, null, { timeout: 180_000, polling: 100 });

    const ops = await listWhConfirmOps(PROJECT_ID, { kind: 'count', state: 'committed' });
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expectOpContract(op, { kind: 'count', epoch: desk.epoch, count: 577, staffName: null });

    const results = await readWhConfirmResults(PROJECT_ID, op.id);
    expect(Object.keys(results)).toHaveLength(577);
    expect(new Set(Object.keys(results)).size).toBe(577);
    for (const sku of ['WH-SCALE-0001', 'WH-SCALE-0289', 'WH-SCALE-0577']) {
      expectResultContract(results[sku], { opId: op.id, kind: 'count', sku, epoch: desk.epoch });
      expect(results[sku].status).toBe('pass');
    }

    // Materialization may be idempotent background cleanup, but committed results must eventually
    // become the item source of truth with provenance.
    await waitForDoc(PROJECT_ID, 'stock_sessions/WH/items/WH-SCALE-0577',
      (d) => d?.status === 'pass' && d.whCountOpId === op.id, { timeout: 60_000 });
    const materialized = await readCollectionMap(PROJECT_ID, 'stock_sessions/WH/items');
    const scaleItems = Object.values(materialized).filter((d) => String(d.sku || '').startsWith('WH-SCALE-'));
    expect(scaleItems).toHaveLength(577);
    expect(scaleItems.every((d) => d.status === 'pass' && d.whCountOpId === op.id)).toBe(true);

    // The failing production document is frozen for compatibility/rollback and must not receive
    // even one new marker from the new protocol.
    const legacyAfter = await getDoc(PROJECT_ID, 'stock_sessions/WH_count_confirmations');
    expect(legacyAfter).toEqual(legacyBefore);

    await closeApp(desk);
  });

  test('per-staff Confirm unions item + legacy inbox, dedupes the same SKU, and leaves other staff untouched', async ({ browser }) => {
    const desk = await bootFreshCount(browser, { branch: 'WH', role: 'supervisor', user: 'มายด์', mode: 'desktop' });
    const itemAndLegacy = makeWhCountItem({ sku: 'S-NORM', epoch: desk.epoch, qty: 10, staff: 'มุก' });
    const itemOtherStaff = makeWhCountItem({ sku: 'S-F02', epoch: desk.epoch, qty: 2, staff: 'ตั๋ง' });
    const legacyOnly = makeWhCountItem({ sku: 'S-F01', epoch: desk.epoch, qty: 1, staff: 'มุก', rev: 0 });
    await seedWhWorkflow(PROJECT_ID, {
      items: [itemAndLegacy, itemOtherStaff],
      countInbox: {
        'S-NORM': makeLegacyCountInbox(itemAndLegacy),
        'S-F01': makeLegacyCountInbox(legacyOnly),
      },
    });
    await waitForLocalScanning(desk.page, 3);
    await armWhR16(desk.page);

    await desk.page.evaluate(() => _confirmWhCountItems('มุก'));
    await desk.page.waitForFunction(() => !_whCountConfirming, null, { timeout: 60_000, polling: 100 });

    const ops = await listWhConfirmOps(PROJECT_ID, { kind: 'count', state: 'committed' });
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expectOpContract(op, { kind: 'count', epoch: desk.epoch, count: 2, staffName: 'มุก' });
    const results = await readWhConfirmResults(PROJECT_ID, op.id);
    expect(Object.keys(results).sort()).toEqual(['S-F01', 'S-NORM']);
    expectResultContract(results['S-NORM'], { opId: op.id, kind: 'count', sku: 'S-NORM', epoch: desk.epoch });
    expectResultContract(results['S-F01'], { opId: op.id, kind: 'count', sku: 'S-F01', epoch: desk.epoch });

    await waitForDoc(PROJECT_ID, 'stock_sessions/WH/items/S-F01',
      (d) => d?.status === 'pass' && d.whCountOpId === op.id);
    const untouched = await getDoc(PROJECT_ID, 'stock_sessions/WH/items/S-F02');
    expect(untouched.status).toBe('scanning');
    expect(untouched.whCountOpId).toBeUndefined();

    expect(Object.keys((await getDoc(PROJECT_ID, 'stock_sessions/WH_count_confirmations')) || {})).toHaveLength(0);

    await closeApp(desk);
  });

  test('a reloaded Supervisor rolls a committed op forward into items and clears stale legacy pending', async ({ browser }) => {
    const first = await bootFreshCount(browser, { branch: 'WH', role: 'supervisor', user: 'Supervisor', mode: 'desktop' });
    const item = makeWhCountItem({ sku: 'S-NORM', epoch: first.epoch, qty: 10, staff: 'Counter' });
    await seedWhWorkflow(PROJECT_ID, {
      items: [item],
      countInbox: { 'S-NORM': makeLegacyCountInbox(item) },
    });

    const opId = 'reload-recovery-count-op';
    const committedAt = new Date().toISOString();
    const marker = {
      ...makeLegacyCountMarker(item, { status: 'pass', systemQty: 10, confirmedAt: committedAt }),
      opId, kind: 'count', sku: item.sku, sourceRev: item.rev, sourceAt: item.countAt,
      sourceFingerprint: 'fixture-recovery-source',
    };
    const candidateHash = await first.page.evaluate((results) => _whWorkflowHashResults(results), { 'S-NORM': marker });
    await closeApp(first);

    // No client is alive while the committed parent/result is installed. The next Supervisor must
    // discover it on reload and finish both idempotent materialization and compatibility cleanup.
    const db = adminDb(PROJECT_ID);
    const batch = db.batch();
    batch.set(db.doc(`stock_sessions/WH/confirm_ops/${opId}`), {
      kind: 'count', state: 'committed', countResetAt: item.countResetAt, staffName: '',
      candidateCount: 1, candidateHash, r01Version: 'R01-TEST-1', r16Version: 'R16-WH-TEST-1',
      r16_103Version: '', owner: 'Supervisor', createdAt: committedAt, committedAt,
    });
    batch.set(db.doc(`stock_sessions/WH/confirm_ops/${opId}/results/S-NORM`), marker);
    await batch.commit();

    const reloaded = await bootJoinCount(browser, {
      branch: 'WH', role: 'supervisor', user: 'Supervisor', mode: 'desktop', expectEpoch: item.countResetAt,
    });
    await waitForDoc(PROJECT_ID, 'stock_sessions/WH/items/S-NORM',
      (d) => d?.status === 'pass' && d.whCountOpId === opId, { timeout: 45_000 });
    await waitForDoc(PROJECT_ID, 'stock_sessions/WH_counts',
      (d) => d && !Object.prototype.hasOwnProperty.call(d, 'S-NORM'), { timeout: 45_000 });
    await reloaded.page.waitForFunction((id) => state.scanData.get('S-NORM')?.status === 'pass' &&
      state.scanData.get('S-NORM')?.whCountOpId === id, opId, { timeout: 30_000, polling: 100 });
    expect(Object.keys((await getDoc(PROJECT_ID, 'stock_sessions/WH_count_confirmations')) || {})).toHaveLength(0);

    await closeApp(reloaded);
  });

  test('candidate changed after staging aborts the whole operation without publishing a final', async ({ browser }) => {
    const desk = await bootFreshCount(browser, { branch: 'WH', role: 'supervisor', user: 'Supervisor', mode: 'desktop' });
    const item = makeWhCountItem({ sku: 'S-NORM', epoch: desk.epoch, qty: 10, staff: 'Counter' });
    await seedWhWorkflow(PROJECT_ID, { items: [item] });
    await waitForLocalScanning(desk.page, 1);
    await armWhR16(desk.page);

    await desk.page.evaluate(async () => {
      const original = window._whStageConfirmOperation;
      window._whStageConfirmOperation = async function (...args) {
        const staged = await original.apply(this, args);
        await getScanItemsRef('WH').doc('S-NORM').set({
          countedQty: 11,
          rev: 99,
          countAt: new Date().toISOString(),
          timestamp: '2026-08-13 18:00:00',
        }, { merge: true });
        return staged;
      };
      await _confirmWhCountItems();
    });

    const committed = await listWhConfirmOps(PROJECT_ID, { kind: 'count', state: 'committed' });
    const aborted = await listWhConfirmOps(PROJECT_ID, { kind: 'count', state: 'aborted' });
    expect(committed).toHaveLength(0);
    expect(aborted).toHaveLength(1);
    expect(aborted[0].candidateCount).toBe(1);
    const physical = await getDoc(PROJECT_ID, 'stock_sessions/WH/items/S-NORM');
    expect(physical.status).toBe('scanning');
    expect(physical.countedQty).toBe(11);
    expect(physical.whCountOpId).toBeUndefined();
    expect(Object.keys((await getDoc(PROJECT_ID, 'stock_sessions/WH_count_confirmations')) || {})).toHaveLength(0);

    await closeApp(desk);
  });

  test('R01 version changed after staging aborts the whole operation without publishing a final', async ({ browser }) => {
    const desk = await bootFreshCount(browser, { branch: 'WH', role: 'supervisor', user: 'Supervisor', mode: 'desktop' });
    const item = makeWhCountItem({ sku: 'S-NORM', epoch: desk.epoch, qty: 10, staff: 'Counter' });
    await seedWhWorkflow(PROJECT_ID, { items: [item] });
    await waitForLocalScanning(desk.page, 1);
    await armWhR16(desk.page);

    await desk.page.evaluate(async () => {
      const original = window._whStageConfirmOperation;
      window._whStageConfirmOperation = async function (...args) {
        const staged = await original.apply(this, args);
        await _db.collection('stock_sessions').doc('WH_r01').update({ r01Version: 'R01-RACE' });
        return staged;
      };
      await _confirmWhCountItems();
    });

    expect(await listWhConfirmOps(PROJECT_ID, { kind: 'count', state: 'committed' })).toHaveLength(0);
    const aborted = await listWhConfirmOps(PROJECT_ID, { kind: 'count', state: 'aborted' });
    expect(aborted).toHaveLength(1);
    expect(aborted[0].candidateCount).toBe(1);
    const physical = await getDoc(PROJECT_ID, 'stock_sessions/WH/items/S-NORM');
    expect(physical.status).toBe('scanning');
    expect(physical.countedQty).toBe(10);
    expect(physical.whCountOpId).toBeUndefined();
    expect(Object.keys((await getDoc(PROJECT_ID, 'stock_sessions/WH_count_confirmations')) || {})).toHaveLength(0);

    await closeApp(desk);
  });
});
