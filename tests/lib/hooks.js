// Shared test entry: re-exports Playwright's test/expect plus closeApp() which
// enforces the isolation tripwire on every context created via newAppContext().
const { test, expect } = require('@playwright/test');
const { newAppContext, armDialog, waitForAppReady, waitForCatalog } = require('./boot');

// Bare page for pure-logic evaluate() tests — no login, Firestore on a dead port (fail-closed).
async function bootBare(browser) {
  const app = await newAppContext(browser, { login: false });
  await app.page.goto('/index.html');
  await waitForAppReady(app.page, { login: false });
  return app;
}

// Assert-and-close. Every spec must close its app contexts through this so a single
// blocked external request (violations) or page JS error fails the test loudly.
async function closeApp(app, { allowPageErrors = false } = {}) {
  try {
    expect(app.violations, 'blocked external requests — isolation tripwire').toEqual([]);
    if (!allowPageErrors) expect(app.pageErrors, 'uncaught page errors').toEqual([]);
  } finally {
    await app.context.close().catch(() => {});
  }
}

// e2e specs call this in beforeEach; throws a clear hint when the emulator is absent.
function requireEmulator() {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST not set — run via `npm run test:e2e`, or start `npm run emu` in another terminal and set $env:FIRESTORE_EMULATOR_HOST=\'127.0.0.1:8791\' before `npm run e2e:attach`');
  }
}

module.exports = { test, expect, newAppContext, armDialog, waitForAppReady, waitForCatalog, closeApp, requireEmulator, bootBare };
