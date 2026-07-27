// Emulator access for seeding and assertions.
// firebase-admin here BYPASSES security rules — use it for seed/inspect only;
// anything that must prove rules behavior goes through the page's web SDK.
const admin = require('firebase-admin');

const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8791';
process.env.FIRESTORE_EMULATOR_HOST = HOST;

const _apps = new Map();
function adminDb(projectId) {
  if (!_apps.has(projectId)) _apps.set(projectId, admin.initializeApp({ projectId }, 'emu-' + projectId));
  return _apps.get(projectId).firestore();
}

function emuPort() { return Number(HOST.split(':').pop()); }

async function clearAll(projectId) {
  const res = await fetch(`http://${HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`emulator clearAll failed: ${res.status} ${await res.text()}`);
}

async function getDoc(projectId, path) {
  const snap = await adminDb(projectId).doc(path).get();
  return snap.exists ? snap.data() : null;
}

async function setDoc(projectId, path, data, opts = { merge: true }) {
  await adminDb(projectId).doc(path).set(data, opts);
}

async function waitForDoc(projectId, path, predicate, { timeout = 15000, interval = 100 } = {}) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    last = await getDoc(projectId, path);
    try { if (predicate(last)) return last; } catch (e) { /* predicate error = not yet */ }
    if (Date.now() - t0 > timeout) throw new Error(`waitForDoc timeout (${timeout}ms): ${path}\nlast=${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

module.exports = { adminDb, clearAll, getDoc, setDoc, waitForDoc, emuPort, HOST };
