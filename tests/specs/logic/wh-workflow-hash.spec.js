// WH operation hashes must be identical on modern Desktop (SubtleCrypto) and older PDA WebViews
// (the pure-JS fallback), including non-ASCII text and differently ordered object keys.
const { test, expect, bootBare, closeApp } = require('../../lib/hooks');

test('WH canonical hash: SubtleCrypto and pure-JS SHA-256 fallback are byte-identical', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(async () => {
    const results = {
      'SKU-😀': { sku: 'SKU-😀', status: 'audit', note: 'ตรวจนับซ้ำ', nested: { z: 2, ก: 1 } },
      'SKU-001': { status: 'pass', countedQty: 10, sku: 'SKU-001', staff: 'มายด์' },
    };
    const rows = Object.entries(results)
      .sort(([a], [b]) => _whCompareText(a, b))
      .map(([sku, marker]) => [sku, marker]);
    const bytes = new TextEncoder().encode(_whStableJson(rows));
    const fallback = _whSha256Fallback(bytes);
    const subtleBytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    const subtle = [...subtleBytes].map((v) => v.toString(16).padStart(2, '0')).join('');
    const workflow = await _whWorkflowHashResults(results);
    const reordered = await _whWorkflowHashResults({
      'SKU-001': { staff: 'มายด์', sku: 'SKU-001', countedQty: 10, status: 'pass' },
      'SKU-😀': { nested: { ก: 1, z: 2 }, note: 'ตรวจนับซ้ำ', status: 'audit', sku: 'SKU-😀' },
    });
    return { fallback, subtle, workflow, reordered };
  });

  expect(out.fallback).toMatch(/^[a-f0-9]{64}$/);
  expect(out.fallback).toBe(out.subtle);
  expect(out.workflow).toBe(out.subtle);
  expect(out.reordered).toBe(out.workflow);
  await closeApp(app);
});
