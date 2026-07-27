// Download the exact Firebase compat SDK files index.html uses into tests/vendor/
// so test runs are deterministic and work fully offline (route shim serves these locally).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const testsDir = join(here, '..');
const vendorDir = join(testsDir, 'vendor');
const indexHtml = readFileSync(join(testsDir, '..', 'index.html'), 'utf8');

const urls = [...indexHtml.matchAll(/<script src="(https:\/\/www\.gstatic\.com\/firebasejs\/[^"]+)"><\/script>/g)].map(m => m[1]);
if (urls.length !== 2) {
  console.error(`Expected exactly 2 gstatic firebase script tags in index.html, found ${urls.length}. Update vendor-sdk.mjs/routes.js.`);
  process.exit(1);
}

mkdirSync(vendorDir, { recursive: true });
for (const url of urls) {
  const name = url.split('/').pop();
  const res = await fetch(url);
  if (!res.ok) { console.error(`Download failed ${res.status}: ${url}`); process.exit(1); }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(join(vendorDir, name), buf);
  const sha = createHash('sha256').update(buf).digest('hex');
  console.log(`vendored ${name}  ${buf.length} bytes  sha256=${sha}`);
}
console.log(`done → ${vendorDir}`);
