// Connectivity guard: if this fails, every other e2e failure is a red herring.
// Proves the shimmed page reaches the emulator (and only the emulator).
const { test, expect, newAppContext, waitForAppReady, closeApp, requireEmulator } = require('../../lib/hooks');
const { emuPort } = require('../../lib/emulator');

test('page reaches the Firestore emulator through the shim (server round-trip, not cache)', async ({ browser }) => {
  requireEmulator();
  const app = await newAppContext(browser, { login: false, firestorePort: emuPort() });
  await app.page.goto('/index.html');
  await waitForAppReady(app.page, { login: false });

  const result = await app.page.evaluate(() =>
    Promise.race([
      (async () => {
        await _db.collection('stock_sessions').doc('probe1').set({ t: Date.now() });
        const s = await _db.collection('stock_sessions').doc('probe1').get();
        return `OK exists=${s.exists} fromCache=${s.metadata.fromCache}`;
      })(),
      new Promise((r) => setTimeout(() => r('TIMEOUT-8s'), 8000)),
    ])
  );
  expect(result).toBe('OK exists=true fromCache=false');
  await closeApp(app, { allowPageErrors: true });
});
