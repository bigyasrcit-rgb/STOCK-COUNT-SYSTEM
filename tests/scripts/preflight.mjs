// Preflight checks for the test environment. Exits non-zero with a fix hint on the first failure.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const testsDir = join(here, '..');
let failed = false;
const ok = (msg) => console.log(`  OK   ${msg}`);
const bad = (msg, hint) => { console.log(`  FAIL ${msg}`); if (hint) console.log(`       → ${hint}`); failed = true; };

// 1. Node
const major = Number(process.versions.node.split('.')[0]);
major >= 18 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} < 18`, 'install Node 18+');

// 2. Java (PATH first, then known Microsoft OpenJDK install dirs — fresh installs may not be on this shell's PATH yet)
export function findJava() {
  const onPath = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (!onPath.error) return 'java';
  const roots = ['C:\\Program Files\\Microsoft', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Java'];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) {
      const exe = join(root, d, 'bin', 'java.exe');
      if (/jdk|jre/i.test(d) && existsSync(exe)) return exe;
    }
  }
  return null;
}
const java = findJava();
if (java) {
  const v = spawnSync(java, ['-version'], { encoding: 'utf8' });
  const line = (v.stderr || v.stdout || '').split('\n')[0].trim();
  ok(`Java: ${line} (${java})`);
  if (java !== 'java') console.log(`       note: not on PATH — run tests via npm scripts (they resolve it) or open a new shell`);
} else {
  bad('Java not found (Firestore emulator needs Java 11+)', 'winget install Microsoft.OpenJDK.21  — then open a NEW shell');
}

// 3. firebase-tools + playwright installed locally
existsSync(join(testsDir, 'node_modules', '.bin', 'firebase.cmd')) || existsSync(join(testsDir, 'node_modules', '.bin', 'firebase'))
  ? ok('firebase-tools installed') : bad('firebase-tools not installed', 'npm install (in tests/)');
existsSync(join(testsDir, 'node_modules', '@playwright', 'test'))
  ? ok('@playwright/test installed') : bad('@playwright/test not installed', 'npm install (in tests/)');

// 4. vendored SDK files present and version-matched to index.html
const indexHtml = readFileSync(join(testsDir, '..', 'index.html'), 'utf8');
const tags = [...indexHtml.matchAll(/gstatic\.com\/firebasejs\/([\d.]+)\/(firebase-[a-z-]+\.js)/g)];
if (tags.length !== 2) bad(`index.html firebase CDN tags changed (found ${tags.length}, expected 2)`, 'update scripts/vendor-sdk.mjs + lib/routes.js anchors');
for (const [, ver, file] of tags) {
  existsSync(join(testsDir, 'vendor', file))
    ? ok(`vendor/${file} (v${ver})`)
    : bad(`vendor/${file} missing`, 'npm run setup');
}

// 5. ports free (static server 4173, emulator 8791) — only warn for 8791 since emulators:exec owns it
const portFree = (port) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(false));
  srv.once('listening', () => srv.close(() => resolve(true)));
  srv.listen(port, '127.0.0.1');
});
for (const port of [4173, 8791]) {
  (await portFree(port)) ? ok(`port ${port} free`) : bad(`port ${port} in use`, 'close the process using it (previous emulator/server run?)');
}

console.log(failed ? '\nPreflight FAILED' : '\nPreflight OK');
process.exit(failed ? 1 : 0);
