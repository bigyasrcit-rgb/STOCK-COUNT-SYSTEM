// The isolation guarantee lives in this file.
// installShim() puts a default-deny route on the browser context:
//   - only 127.0.0.1/localhost requests pass through
//   - the two gstatic Firebase SDK files are served from tests/vendor/ (never from the network)
//   - anything else external is aborted AND recorded in `violations` (tests assert it stays empty)
//   - ?_vchk= heartbeat probes get a stable ETag; maintenance.json?_vchk= always answers {enabled:false}
//   - the app document gets a <script> injected right after the firebase CDN tags that wraps
//     firebase.initializeApp → forces a demo- projectId + useEmulator(127.0.0.1, port).
//     For the "logic" project the port is 1 (dead port) so any accidental Firestore op fails closed, locally.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const VENDOR = join(__dirname, '..', 'vendor');
const SDK_FILES = new Set(['firebase-app-compat.js', 'firebase-firestore-compat.js']);
const GOOGLE_HOSTS = /(^|\.)googleapis\.com$|(^|\.)gstatic\.com$|(^|\.)firebaseio\.com$|(^|\.)firebaseapp\.com$/i;
// Anchor must match index.html:15 exactly — hard-throw if the CDN tags ever change so the shim can't silently stop applying.
const INJECT_ANCHOR = /(<script src="https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.0\/firebase-firestore-compat\.js"><\/script>)/;

function shimJs(projectId, firestorePort) {
  return `(function(){
  var realInit = firebase.initializeApp.bind(firebase);
  firebase.initializeApp = function(cfg){
    var app = realInit(Object.assign({}, cfg, {
      projectId: ${JSON.stringify(projectId)},
      apiKey: 'demo-api-key',
      authDomain: ${JSON.stringify(projectId + '.firebaseapp.com')},
      storageBucket: ${JSON.stringify(projectId + '.appspot.com')},
      messagingSenderId: '0',
      appId: 'demo-app-id'
    }));
    var fs = firebase.firestore();
    fs.useEmulator('127.0.0.1', ${Number(firestorePort)});
    // Playwright route interception disturbs the WebChannel streaming transport — force long polling,
    // which round-trips as plain requests and passes through route.fallback() cleanly.
    // Must come AFTER useEmulator (which calls settings() itself without merge).
    fs.settings({ experimentalForceLongPolling: true, experimentalAutoDetectLongPolling: false, merge: true });
    window.__TEST_SHIM__ = { projectId: ${JSON.stringify(projectId)}, port: ${Number(firestorePort)} };
    return app;
  };
})();`;
}

async function installShim(context, { projectId, firestorePort, violations }) {
  await context.route('**/*', async (route) => {
    const req = route.request();
    let url;
    try { url = new URL(req.url()); } catch { return route.abort('blockedbyclient'); }
    const host = url.hostname;
    const isLocal = host === '127.0.0.1' || host === 'localhost';

    // vendored Firebase SDK — the only "external" URLs ever answered, and they never leave this machine
    if (host === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
      const name = url.pathname.split('/').pop();
      if (SDK_FILES.has(name)) {
        return route.fulfill({ body: readFileSync(join(VENDOR, name)), contentType: 'text/javascript; charset=utf-8' });
      }
    }

    // Firestore WebChannel connectivity probe (goog closure lib) — fired when the channel drops
    // (constantly, on the logic project's dead port). Carries no data; fulfil locally with 204
    // so it never leaves the machine and never pollutes the violations tripwire.
    if (host === 'www.google.com' && url.pathname === '/images/cleardot.gif') {
      return route.fulfill({ status: 204, body: '' });
    }

    if (!isLocal) {
      violations.push({ url: req.url(), method: req.method(), kind: GOOGLE_HOSTS.test(host) ? 'GOOGLEAPIS' : 'EXTERNAL' });
      return route.abort('blockedbyclient');
    }

    // heartbeat / maintenance probes
    if (url.searchParams.has('_vchk')) {
      if (url.pathname.endsWith('maintenance.json')) return route.fulfill({ json: { enabled: false } });
      return route.fulfill({ status: 200, headers: { ETag: '"pw-stable-etag"' }, body: '' });
    }

    // NOTE: the emulator shim is injected by static-server.mjs (triggered by the x-test-shim
    // request header boot.js sets on the context) — fulfilling the document here poisons its
    // origin in Chromium and every cross-port fetch (the emulator!) then dies with ERR_FAILED.
    return route.fallback();
  });
}

module.exports = { installShim, shimJs, INJECT_ANCHOR };
