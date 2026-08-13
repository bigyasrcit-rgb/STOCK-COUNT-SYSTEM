// High-level flows composed from boot + seed:
//   bootFreshCount — device 1: clean emulator state → real startNewCount() → seed masters → catalog ready.
//     Uses the app's own startNewCount so the session doc / epoch / schemaVersion are always format-correct
//     (no hand-crafted session blobs to drift out of date).
//   bootJoinCount  — device 2+: boots after the fact and adopts session/epoch/catalog from the cloud.
const { newAppContext, armDialog, waitForAppReady, waitForCatalog } = require('./boot');
const { emuPort, clearAll } = require('./emulator');
const { seedMasters } = require('./seed');
const F = require('./fixtures');

const PROJECT_ID = 'demo-stock-count';
const MIN_SKUS = F.r01Rows.length - 1; // allow for rows a rebuild may classify specially

// startNewCount() deletes {branch}_r01 through the page's own SDK, so that client's cache remembers
// the doc as deleted. seedMasters() then re-creates it with firebase-admin — a write the page has not
// necessarily observed yet — and restoreMasterFromFirestore()'s plain .get() can still be answered
// from that stale cache, leaving state.r01Data empty forever. Retry the restore until the catalog is
// actually complete. (Production never hits this: the app uploads masters through its own SDK.)
async function restoreMastersUntilReady(app, { attempts = 8, perAttemptMs = 2500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    await app.page.evaluate(() => restoreMasterFromFirestore(true));
    // skuMap is derived from R01+PM+R05 by whichever load finishes last, so it can be left built
    // from PM alone — every systemQty 0, which quietly turns pass/audit decisions into nonsense.
    // Re-derive explicitly, then verify with a known fixture value before letting the test proceed.
    await app.page.evaluate(() => rebuildMaps());
    try {
      await waitForCatalog(app.page, { minSkus: MIN_SKUS, timeout: perAttemptMs });
      const derived = await app.page.evaluate((c) => state.skuMap.get(c.sku)?.systemQty, F.CANARY);
      if (derived === F.CANARY.systemQty) return;
      lastErr = new Error(`catalog derived but stale: skuMap[${F.CANARY.sku}].systemQty=${derived}, expected ${F.CANARY.systemQty}`);
    } catch (e) { lastErr = e; }
  }
  await dumpCatalogState('restoreMastersUntilReady', app);
  throw lastErr;
}

// waitForCatalog failing means the app never finished loading master data — print exactly what it
// did have, so the timeout names a cause instead of just a line number.
async function dumpCatalogState(where, app) {
  const diag = await app.page.evaluate(() => ({
    skus: state.skuMap.size, r01: state.r01Data.length, r05: state.r05Data.length,
    pm: state.productMasterData.length, epoch: _countResetAt, schema: _schemaVersion,
    user: typeof currentUser !== 'undefined' ? currentUser : '(unset)',
    badges: ['ProductMaster', 'R01', 'R05'].map((k) => (document.getElementById('badge' + k) || {}).textContent).join('/'),
  })).catch((err) => `evaluate failed: ${err.message}`);
  console.log(`[${where}] catalog timeout — state: ${JSON.stringify(diag)} pageErrors: ${JSON.stringify(app.pageErrors)}`);
}

async function bootFreshCount(browser, opts = {}) {
  const { branch = 'SRC', role = 'pharmacist', user = 'Tester', mode = 'desktop', projectId = PROJECT_ID, clear = true } = opts;
  if (clear) await clearAll(projectId);

  const app = await newAppContext(browser, { branch, role, user, mode, projectId, firestorePort: emuPort(), login: true });
  await app.page.goto('/index.html');
  await waitForAppReady(app.page);

  // Real startNewCount(): new epoch, schemaVersion 2, cloud session doc created, old masters wiped.
  // prompt() opened inside page.evaluate deadlocks Playwright — stub it for the call instead of using a real dialog.
  await app.page.evaluate(async () => {
    const orig = window.prompt;
    window.prompt = () => CLEAR_PIN;
    try { await startNewCount(); } finally { window.prompt = orig; }
  });

  // Masters must be seeded AFTER startNewCount (it deletes {branch}_r01).
  await seedMasters(projectId, { branch });
  await restoreMastersUntilReady(app);

  app.epoch = await app.page.evaluate(() => _countResetAt);
  app.projectId = projectId;
  return app;
}

async function bootJoinCount(browser, opts = {}) {
  const { branch = 'SRC', role = 'assistant', user = 'Tester2', mode = 'pda', projectId = PROJECT_ID, expectEpoch } = opts;
  const app = await newAppContext(browser, { branch, role, user, mode, projectId, firestorePort: emuPort(), login: true });
  await app.page.goto('/index.html');
  await waitForAppReady(app.page);
  // Epoch adoption (session snapshot with a newer countResetAt) wipes local r01 via
  // _resetLocalR01ToEmpty — whether it lands before or after the boot-time master restore is an
  // async race (role-dependent steps shift the timing). Make the join deterministic: wait for the
  // epoch first, then force one more master restore so the catalog is complete afterwards.
  if (expectEpoch) {
    await app.page.waitForFunction((e) => _countResetAt === e, expectEpoch, { timeout: 15000, polling: 100 });
  }
  await restoreMastersUntilReady(app);
  app.epoch = await app.page.evaluate(() => _countResetAt);
  app.projectId = projectId;
  return app;
}

// Arm R16 exactly like a real upload: page state + the {branch}_r01 meta doc, kept in lockstep
// (Confirm's version gate compares both sides).
async function armR16(page, { version = 'R16-TEST-1' } = {}) {
  await page.evaluate((v) => {
    state.r16Loaded = true;
    state.r16DateMismatch = false;
    state.r16DetailVersion = v;
    state.r16UploadedAt = 'test-fixture';
    state.r16SalesMap.clear(); state.r16RawMap.clear();
    state.r16InboundMap.clear(); state.r16InboundRawMap.clear();
    return syncR16MetaToFirestore();
  }, version);
}

// Arm the WH raw-timeline/version gate without uploading a CSV. WH Confirm checks both the
// in-page raw timeline flags and the dedicated Cloud meta document, unlike pharmacy branches
// which keep the R16 version on {branch}_r01. Empty timelines are intentional here: individual
// specs seed counted/system quantities so the R16 adjustment is zero unless a spec says otherwise.
async function armWhR16(page, { version = 'R16-WH-TEST-1' } = {}) {
  await page.evaluate(async (v) => {
    if (currentBranch !== 'WH') throw new Error('armWhR16 requires branch WH');
    state.r16Data = [];
    state.r16SalesMap.clear(); state.r16RawMap.clear();
    state.r16InboundMap.clear(); state.r16InboundRawMap.clear();
    state.r16Loaded = true;
    state.r16DateMismatch = false;
    state.r16DetailVersion = v;
    state.r16UploadedAt = 'test-fixture';
    state.r16_103Map.clear(); state.r16_103RawMap.clear();
    state.r16_103Loaded = false;
    state.r16_103DetailVersion = '';
    state.r16_103UploadedAt = '';
    _whR16TimelineLoading = false;
    _whR16TimelineReady = true;
    _whR16103TimelineReady = false;
    await getWhR16MetaRef('104').set({
      ready: true,
      kind: '104',
      version: v,
      generation: 'test-generation-104',
      chunkCount: 0,
      rowCount: 0,
      countResetAt: _countResetAt || '',
      r01Version: state.r01Version || '',
      uploadedAtText: 'test-fixture',
      dateMismatch: false,
      dateMismatchDetail: '',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await getWhR16MetaRef('103').delete().catch(() => {});
    updateConfirmBtn();
  }, version);
  // A boot-time R01 listener can schedule its 250ms Cloud timeline reload just after the fixture
  // is armed. Drive one authoritative reload after that debounce window so Confirm never races a
  // still-running fixture load (the production UI correctly blocks while loading).
  await page.waitForTimeout(300);
  await page.evaluate(async () => {
    clearTimeout(_whR16MetaReloadTimer); _whR16MetaReloadTimer = null;
    await _loadWhR16CloudTimelines();
  });
  await page.waitForFunction((v) => !_whR16TimelineLoading && _whR16TimelineReady &&
    state.r16Loaded && state.r16DetailVersion === v, version, { timeout: 15_000, polling: 50 });
}

module.exports = { bootFreshCount, bootJoinCount, armR16, armWhR16, PROJECT_ID, MIN_SKUS };
