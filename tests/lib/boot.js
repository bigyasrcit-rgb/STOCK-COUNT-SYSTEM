// Context/page factory for the app under test.
// login:true uses the real _autoUpdate backdoor (index.html:3325-3340): seed
// localStorage.selectedBranch + sessionStorage {_autoUpdate:'1', _autoUpdateUser, _autoUpdateRole}
// → the app boots straight into initAfterLogin() with no modals.
// login:false lands on the branch selector — enough for pure-logic evaluate() tests.
const { installShim } = require('./routes');

const BASE_URL = 'http://127.0.0.1:4173';
const PDA_UA = 'Mozilla/5.0 (Linux; Android 10; PDA) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 StockCountPDA/1.11';

async function newAppContext(browser, opts = {}) {
  const {
    branch = 'SRC', user = 'Tester', role = 'pharmacist',
    mode = 'desktop',            // 'desktop' (>600px) | 'pda' (≤600px + StockCountPDA UA)
    login = true,
    projectId = 'demo-stock-count',
    firestorePort = 1,           // dead port by default — e2e passes 8791 explicitly
  } = opts;

  const violations = [];
  const pageErrors = [];

  const context = await browser.newContext({
    serviceWorkers: 'block',     // sw.js registration at index.html:7944 is unconditional — must block here
    baseURL: BASE_URL,
    viewport: mode === 'pda' ? { width: 390, height: 700 } : { width: 1440, height: 900 },
    userAgent: mode === 'pda' ? PDA_UA : undefined,
    // static-server.mjs sees this header and injects the emulator shim into index.html
    extraHTTPHeaders: { 'x-test-shim': `${projectId}:${firestorePort}` },
  });
  await installShim(context, { projectId, firestorePort, violations });

  if (login) {
    await context.addInitScript(({ branch, user, role }) => {
      try {
        localStorage.setItem('selectedBranch', branch);
        sessionStorage.setItem('_autoUpdate', '1');
        sessionStorage.setItem('_autoUpdateUser', user);
        sessionStorage.setItem('_autoUpdateRole', role);
      } catch (e) {}
    }, { branch, user, role });
  }

  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  // Single managed dialog handler: armDialog(page, 'text') → next prompt/confirm is accepted with that text.
  page.on('dialog', async (d) => {
    const r = page.__dialogResponse;
    page.__dialogResponse = undefined;
    try { r !== undefined ? await d.accept(String(r)) : await d.dismiss(); } catch (e) {}
  });

  return { context, page, violations, pageErrors, opts: { branch, user, role, mode, login, projectId } };
}

function armDialog(page, response) { page.__dialogResponse = response; }

// Ready = shim applied + firebase app initialized. With login:true also waits for currentUser.
async function waitForAppReady(page, { login = true, timeout = 20000 } = {}) {
  // polling:100 everywhere — default rAF polling stalls on unfocused pages (multi-context suites)
  await page.waitForFunction(
    (needLogin) => window.__TEST_SHIM__ && typeof firebase !== 'undefined' && firebase.apps.length > 0 &&
      (!needLogin || (typeof currentUser !== 'undefined' && !!currentUser)),
    login, { timeout, polling: 100 },
  );
}

// Catalog loaded = ALL master datasets present and rebuildMaps() ran on them.
// Checking skuMap alone races the boot-time restore (initAfterLogin's restore and ours overlap;
// the force path clears r01Data before refilling it).
async function waitForCatalog(page, { minSkus = 1, timeout = 20000 } = {}) {
  await page.waitForFunction(
    (n) => typeof state !== 'undefined' && state.skuMap && state.skuMap.size >= n &&
      state.r01Data.length > 0 && state.r05Data.length > 0 && state.productMasterData.length > 0,
    minSkus, { timeout, polling: 100 },
  );
}

module.exports = { newAppContext, armDialog, waitForAppReady, waitForCatalog, BASE_URL };
