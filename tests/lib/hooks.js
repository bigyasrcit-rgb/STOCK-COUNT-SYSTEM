// Shared test entry: re-exports Playwright's test/expect plus closeApp() which
// enforces the isolation tripwire on every context created via newAppContext().
const { test: base, expect } = require('@playwright/test');
const { newAppContext, armDialog, waitForAppReady, waitForCatalog, closeAllContexts } = require('./boot');

// เก็บกวาด browser context ที่ค้างหลังทุกเทส ไม่ว่าผ่านหรือล้ม
// เทสที่ล้มก่อนถึง closeApp() จะทิ้ง context ไว้จนจบ worker — เป็นการรั่วของทรัพยากรจริง
// ⚠️ ไม่ใช่ตัวแก้เทส flaky: ทดลองแล้ว (เทสล้มจงใจ → เทสถัดไป) พบว่าเทสถัดไปผ่านทั้งเปิดและปิด fixture นี้
//    สาเหตุ flaky ของ wh-workflow-rules.spec.js:157 ยังไม่ทราบ — ดู tests/README.md
// ต้องเป็น fixture ไม่ใช่ test.afterEach — hooks.js ถูก require ครั้งเดียวแล้ว cache ไว้
// afterEach จึงจะผูกกับ spec ไฟล์แรกที่ require เท่านั้น ส่วน fixture ครอบทุกไฟล์ที่ใช้ test ตัวนี้
const test = base.extend({
  _closeLeakedContexts: [async ({}, use) => {
    await use();
    await closeAllContexts();
  }, { auto: true }],
});

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
