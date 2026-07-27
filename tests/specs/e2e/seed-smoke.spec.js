const { test, expect, closeApp, requireEmulator } = require('../../lib/hooks');
const { bootFreshCount, bootJoinCount, PROJECT_ID, MIN_SKUS } = require('../../lib/scenario');
const { getDoc } = require('../../lib/emulator');

test.describe('seed smoke — fresh count against the emulator', () => {
  test.beforeEach(() => requireEmulator());

  test('startNewCount + seeded masters give a ready catalog and a v2 session doc', async ({ browser }) => {
    const app = await bootFreshCount(browser, {});
    const snap = await app.page.evaluate(() => ({
      skus: state.skuMap.size,
      r01: state.r01Data.length,
      r05: state.r05Data.length,
      pm: state.productMasterData.length,
      epoch: _countResetAt,
      schema: _schemaVersion,
    }));
    expect(snap.skus).toBeGreaterThanOrEqual(MIN_SKUS);
    expect(snap.r01).toBeGreaterThan(0);
    expect(snap.r05).toBeGreaterThan(0);
    expect(snap.pm).toBeGreaterThan(0);
    expect(snap.epoch).toBeTruthy();
    expect(snap.schema).toBe(2);

    const sess = await getDoc(PROJECT_ID, 'stock_sessions/SRC');
    expect(sess).toBeTruthy();
    expect(Number(sess.schemaVersion)).toBe(2);

    await closeApp(app);
  });

  test('a second device joins and adopts the same epoch + catalog', async ({ browser }) => {
    const desktop = await bootFreshCount(browser, {});
    const pda = await bootJoinCount(browser, { mode: 'pda', role: 'pharmacist', user: 'PDA1', expectEpoch: desktop.epoch });
    expect(pda.epoch).toBe(desktop.epoch);
    const isPda = await pda.page.evaluate(() => navigator.userAgent.includes('StockCountPDA') && window.innerWidth <= 600);
    expect(isPda).toBe(true);
    await closeApp(pda);
    await closeApp(desktop);
  });
});
