// Negative control: prove the isolation tripwire actually trips.
const { test, expect, newAppContext, waitForAppReady, closeApp, requireEmulator } = require('../../lib/hooks');
const { emuPort } = require('../../lib/emulator');

test.describe('isolation tripwire', () => {
  test.beforeEach(() => requireEmulator());

  test('a deliberate googleapis request is blocked and recorded', async ({ browser }) => {
    const app = await newAppContext(browser, { login: false, firestorePort: emuPort() });
    await app.page.goto('/index.html');
    await waitForAppReady(app.page, { login: false });

    const outcome = await app.page.evaluate(async () => {
      try {
        await fetch('https://firestore.googleapis.com/v1/projects/stock-count-1d6e7/databases/(default)/documents/x');
        return 'FETCHED';
      } catch (e) { return 'BLOCKED'; }
    });
    expect(outcome).toBe('BLOCKED');
    expect(app.violations.length).toBeGreaterThan(0);
    expect(app.violations[0].kind).toBe('GOOGLEAPIS');
    expect(app.violations[0].url).toContain('firestore.googleapis.com');

    app.violations.length = 0; // tripwire proven — clear so closeApp's clean-run assert passes
    await closeApp(app);
  });
});
