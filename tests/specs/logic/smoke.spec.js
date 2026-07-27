const { test, expect, newAppContext, waitForAppReady, closeApp } = require('../../lib/hooks');

test.describe('smoke — harness + isolation', () => {
  test('app boots under the shim: demo project, dead Firestore port, no external requests', async ({ browser }) => {
    const app = await newAppContext(browser, { login: false });
    await app.page.goto('/index.html');
    await waitForAppReady(app.page, { login: false });

    const info = await app.page.evaluate(() => ({
      shim: window.__TEST_SHIM__,
      projectId: firebase.app().options.projectId,
      hasParse: typeof parseScanLine === 'function',
      branchModalShown: getComputedStyle(document.getElementById('branchModal')).display !== 'none',
    }));
    expect(info.shim).toBeTruthy();
    expect(info.projectId).toMatch(/^demo-/);
    expect(info.shim.port).toBe(1);
    expect(info.hasParse).toBe(true);
    expect(info.branchModalShown).toBe(true);

    await closeApp(app);
  });

  test('login backdoor boots straight to a logged-in pharmacist without modals', async ({ browser }) => {
    const app = await newAppContext(browser, { login: true, branch: 'SRC', user: 'Tester', role: 'pharmacist' });
    await app.page.goto('/index.html');
    await waitForAppReady(app.page, { login: true });

    const who = await app.page.evaluate(() => ({
      user: currentUser, role: currentRole, branch: currentBranch, pin: _pinVerified,
    }));
    expect(who).toEqual({ user: 'Tester', role: 'pharmacist', branch: 'SRC', pin: true });

    // restoreFromFirestore against the dead port must not crash the page — errors are handled
    await closeApp(app, { allowPageErrors: true });
  });
});
