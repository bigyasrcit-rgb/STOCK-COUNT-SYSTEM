// auto-r01 (Windows Task Scheduler) writes R01 straight to `{branch}_r01` every morning — it can NEVER
// touch the session doc, because scanData lives in the same session_data_json blob on schema v1.
// So the baseline travels through the master doc instead, and the app has to pick it up on its own.
//
// This guards the two index.html paths that make that work:
//   1. live device  — the pharmacy `{branch}_r01` listener adopts `r01BaselineAt` → _applyR01BaselineUpdate()
//   2. page reload  — restoreMasterFromFirestore() reloads data_json when cloud r01Version differs
// Without them a device shows badge "Ready" + today's timestamp while skuMap still holds yesterday's
// systemQty — wrong stock decisions, silently. See auto-r01/TODO-safe-enable.md bugs #3 and #4.
const { test, expect, closeApp, requireEmulator } = require('../../lib/hooks');
const { bootFreshCount, PROJECT_ID } = require('../../lib/scenario');
const { setDoc, getDoc } = require('../../lib/emulator');

// mirrors auto_r01_import.py build_payload(): same fields, same ISO shape (must compare > lexicographically
// against what new Date().toISOString() produces)
function autoR01Write(branch, rows, iso) {
  return setDoc(PROJECT_ID, `stock_sessions/${branch}_r01`, {
    data_json: JSON.stringify(rows),
    r01UploadedAt: '08:10 น. 26/08/2026',
    r01Version: iso,
    r01BaselineAt: iso,
    r16Loaded: false,
    r16UploadedAt: '',
    r16DetailVersion: '',
    r16_103Loaded: false,
    r16_103UploadedAt: '',
    r16_103DetailVersion: '',
  });
}

const tomorrowIso = () => new Date(Date.now() + 86400_000).toISOString();

test.describe('auto-r01 → app adoption', () => {
  test.beforeEach(() => requireEmulator());
  test.setTimeout(90_000);

  test('a logged-in pharmacy device adopts the master-doc baseline: new R01, R16 cleared', async ({ browser }) => {
    const app = await bootFreshCount(browser, { role: 'pharmacist', user: 'Pharm', mode: 'desktop' });

    // stand in for "R16 was uploaded yesterday evening and Confirm is unlocked"
    await app.page.evaluate(() => {
      state.r16Loaded = true;
      state.r16DetailVersion = 'R16-YESTERDAY';
      state.r16SalesMap.set('S-NORM', 5);
    });
    const before = await app.page.evaluate(() => ({
      qty: state.skuMap.get('S-NORM')?.systemQty ?? null,
      baseline: _r01BaselineAt,
    }));
    expect(before.qty).not.toBe(4242);

    const iso = tomorrowIso();
    await autoR01Write('SRC', [{ colE: 'S-NORM', productName: 'ของวันนี้', systemQty: 4242 }], iso);

    // listener → _applyR01BaselineUpdate(): loads R01, rebuilds maps, clears R16, toasts
    await app.page.waitForFunction(
      (v) => state.r01Version === v && state.r16Loaded === false,
      iso, { timeout: 20000, polling: 100 },
    );

    const after = await app.page.evaluate(() => ({
      qty: state.skuMap.get('S-NORM')?.systemQty ?? null,
      rows: state.r01Data.length,
      sales: state.r16SalesMap.size,
      baseline: _r01BaselineAt,
      adopted: _adoptedMasterBaselineAt,
    }));
    expect(after.qty).toBe(4242);          // catalog really rebuilt, not just the badge
    expect(after.rows).toBe(1);
    expect(after.sales).toBe(0);           // yesterday's R16 gone → Confirm blocked until today's upload
    expect(after.baseline).toBe(iso);
    expect(after.adopted).toBe(iso);
    expect(after.baseline).not.toBe(before.baseline);

    await closeApp(app);
  });

  test('re-adoption is suppressed after startNewCount() blanks _r01BaselineAt', async ({ browser }) => {
    const app = await bootFreshCount(browser, { role: 'pharmacist', user: 'Pharm', mode: 'desktop' });

    const iso = tomorrowIso();
    await autoR01Write('SRC', [{ colE: 'S-NORM', productName: 'ของวันนี้', systemQty: 4242 }], iso);
    await app.page.waitForFunction((v) => _r01BaselineAt === v, iso, { timeout: 20000, polling: 100 });

    // startNewCount() resets the baseline to '' (it moves backwards by design — countResetAt is the
    // forward-only epoch). The master doc still holds this morning's value, so without the
    // _adoptedMasterBaselineAt memo the listener would re-fire on the next snapshot.
    await app.page.evaluate(() => {
      _r01BaselineAt = '';
      state.r16Loaded = true;
      state.r16SalesMap.set('S-NORM', 9);
    });

    // any unrelated write re-delivers the same doc to the listener
    await setDoc(PROJECT_ID, 'stock_sessions/SRC_r01', { r01UploadedAt: '08:11 น. 26/08/2026' });
    await app.page.waitForFunction(
      () => document.getElementById('r01Timestamp')?.textContent?.includes('08:11'),
      null, { timeout: 20000, polling: 100 },
    );

    const after = await app.page.evaluate(() => ({
      baseline: _r01BaselineAt,
      r16: state.r16Loaded,
      sales: state.r16SalesMap.size,
    }));
    expect(after.baseline).toBe('');   // NOT re-adopted
    expect(after.r16).toBe(true);      // R16 not cleared a second time
    expect(after.sales).toBe(1);

    await closeApp(app);
  });

  test('a reloaded device picks up the new R01 instead of the stale local copy', async ({ browser }) => {
    const app = await bootFreshCount(browser, { role: 'pharmacist', user: 'Pharm', mode: 'desktop' });
    await app.page.evaluate(() => saveSession());

    const iso = tomorrowIso();
    await autoR01Write('SRC', [{ colE: 'S-NORM', productName: 'ของวันนี้', systemQty: 777 }], iso);
    await app.page.waitForFunction((v) => state.r01Version === v, iso, { timeout: 20000, polling: 100 });
    await app.page.evaluate(() => saveSession());

    // put localStorage back to a stale R01 while the cloud stays new — the exact state a device
    // that was closed overnight wakes up in
    await app.page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem(lsKey()) || '{}');
      raw.r01Data = [{ colE: 'S-NORM', productName: 'ของเมื่อวาน', systemQty: 1 }];
      raw.r01Version = '2000-01-01T00:00:00.000Z';
      localStorage.setItem(lsKey(), JSON.stringify(raw));
    });

    await app.page.reload({ waitUntil: 'domcontentloaded' });
    await app.page.waitForFunction(
      () => typeof state !== 'undefined' && state.r01Data.length > 0 && state.r01Version,
      null, { timeout: 30000, polling: 100 },
    );
    await app.page.waitForFunction((v) => state.r01Version === v, iso, { timeout: 30000, polling: 100 });

    const after = await app.page.evaluate(() => ({
      qty: state.skuMap.get('S-NORM')?.systemQty ?? null,
      name: state.r01Data[0]?.productName,
    }));
    expect(after.name).toBe('ของวันนี้');
    expect(after.qty).toBe(777);

    await closeApp(app);
  });

  test('the master-doc baseline is inert for WH — WH adopts through r01Version instead', async ({ browser }) => {
    const app = await bootFreshCount(browser, { role: 'supervisor', user: 'Sup', mode: 'desktop', branch: 'WH' });

    // _applyWhR01Doc() adopts only when incomingVersion > state.r01Version, compared as plain strings.
    // The fixture seeds the placeholder 'R01-TEST-1', which sorts AFTER any '2026-…' ISO — in production
    // r01Version only ever comes from new Date().toISOString() (loadR01) or auto_r01_import.py, both ISO.
    await app.page.evaluate(() => { state.r01Version = '2000-01-01T00:00:00.000Z'; });

    const iso = tomorrowIso();
    await autoR01Write('WH', [{ colE: 'S-NORM', productName: 'คลังวันนี้', systemQty: 555 }], iso);

    await app.page.waitForFunction((v) => state.r01Version === v, iso, { timeout: 20000, polling: 100 });

    const after = await app.page.evaluate(() => ({
      qty: state.skuMap.get('S-NORM')?.systemQty ?? null,
      // _applyR01BaselineUpdate is gated on _isPharmacyBranch() — WH must never stamp a pharmacy baseline
      baseline: _r01BaselineAt,
      adopted: _adoptedMasterBaselineAt,
    }));
    expect(after.qty).toBe(555);
    expect(after.baseline).toBe('');
    expect(after.adopted).toBe('');

    await closeApp(app);
  });
});
