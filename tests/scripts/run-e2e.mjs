// Runs the e2e project with an isolated Firestore emulator.
//
// We own the whole lifecycle (emulator + static server + playwright) instead of using
// `firebase emulators:exec`: that nests an extra shell whose stdio pipes stay open while any
// grandchild lives, so a run could finish every test and then hang forever at teardown on Windows.
//
// Also resolves Java itself — a shell opened BEFORE the JDK was installed still has a stale PATH.
//
// Usage: node scripts/run-e2e.mjs [extra playwright args...]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const testsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const EMULATOR_PORT = 8791;
const HUB_PORT = 4400;
const STATIC_PORT = 4173;

const probe = (port) => new Promise((resolve) => {
  const sock = net.connect({ port, host: '127.0.0.1' });
  sock.setTimeout(700);
  const done = (up) => { sock.destroy(); resolve(up); };
  sock.once('connect', () => done(true));
  sock.once('error', () => done(false));
  sock.once('timeout', () => done(false));
});

async function waitForPort(port, what, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await probe(port)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${what} did not come up on port ${port} within ${timeoutMs}ms`);
}

function javaBinDir() {
  if (!spawnSync('java', ['-version']).error) return null; // already on PATH
  const roots = ['C:\\Program Files\\Microsoft', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Java'];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) {
      const bin = join(root, d, 'bin');
      if (/jdk|jre/i.test(d) && existsSync(join(bin, 'java.exe'))) return bin;
    }
  }
  return null;
}

// --- preflight ---------------------------------------------------------------
// Two overlapping runs share one emulator, and each test's clearAll() wipes what the other just
// seeded — which surfaces as a scatter of unrelated 20s timeouts. Fail loudly instead.
for (const [port, what] of [[EMULATOR_PORT, 'Firestore emulator'], [HUB_PORT, 'emulator hub']]) {
  if (await probe(port)) {
    console.error(`[run-e2e] port ${port} is already in use (${what}).`);
    console.error('          Another test run or `npm run emu` is active — stop it first, or use `npm run e2e:attach` to reuse it.');
    process.exit(1);
  }
}

// firebase-tools requires the rules file inside the firebase.json directory — refresh it every run
// so tests always exercise the production rules.
copyFileSync(join(testsDir, '..', 'firestore.rules'), join(testsDir, 'firestore.rules'));

const env = { ...process.env };
env.PATH = [join(testsDir, 'node_modules', '.bin'), dirname(process.execPath), env.PATH].join(delimiter);
const javaBin = javaBinDir();
if (javaBin) {
  env.PATH = javaBin + delimiter + env.PATH;
  env.JAVA_HOME = dirname(javaBin);
  console.log(`[run-e2e] using Java at ${javaBin} (not on PATH — open a new shell to pick it up permanently)`);
} else if (spawnSync('java', ['-version']).error) {
  console.error('[run-e2e] Java not found. Install it with:  winget install Microsoft.OpenJDK.21');
  process.exit(1);
}
env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${EMULATOR_PORT}`;

// --- children ----------------------------------------------------------------
const children = [];
function start(name, args, opts = {}) {
  const child = spawn(process.execPath, args, { cwd: testsDir, env, stdio: 'inherit', ...opts });
  child.on('error', (e) => console.error(`[run-e2e] ${name} failed to start: ${e.message}`));
  children.push({ name, child });
  return child;
}
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const { child } of children) {
    if (child.exitCode === null && !child.killed) {
      try { process.platform === 'win32' ? spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']) : child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

const firebaseBin = join(testsDir, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
start('emulator', [firebaseBin, 'emulators:start', '--only', 'firestore', '--project', 'demo-stock-count']);
await waitForPort(EMULATOR_PORT, 'Firestore emulator');

// Start the static server ourselves so Playwright reuses it (reuseExistingServer) rather than
// managing a child of its own.
if (!(await probe(STATIC_PORT))) {
  start('static-server', [join(testsDir, 'lib', 'static-server.mjs')]);
  await waitForPort(STATIC_PORT, 'static server', 20_000);
}

const playwrightBin = join(testsDir, 'node_modules', '@playwright', 'test', 'cli.js');
const pw = start('playwright', [playwrightBin, 'test', '--project=e2e', ...process.argv.slice(2)]);
pw.on('exit', (code) => { cleanup(); process.exit(code ?? 1); });
