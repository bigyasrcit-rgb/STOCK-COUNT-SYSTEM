// สูตร Confirm: effectiveQty = countedQty + soldQty + r16103Qty - inboundQty (CLAUDE.md — ห้ามเปลี่ยน)
const { test, expect, bootBare, closeApp } = require('../../lib/hooks');

test('parseTranDate — Thai/dash/ISO formats', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => {
    // parseTranDate returns LOCAL-time Dates — format with local getters, not toISOString (UTC shift)
    const fmt = (d) => (d
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
      : null);
    return {
      thai: fmt(parseTranDate('25/07/2026 8:38:50 AM')),
      thaiPm: fmt(parseTranDate('25/07/2026 1:05 PM')),
      thaiNoTime: fmt(parseTranDate('25/07/2026')),
      dashShortYear: fmt(parseTranDate('25-04-26 8:07')),
      isoStr: fmt(parseTranDate('2026-07-25 14:30:00')),
      garbage: parseTranDate('not-a-date'),
      empty: parseTranDate(''),
    };
  });
  expect(out.thai).toBe('2026-07-25 08:38:50');
  expect(out.thaiPm).toBe('2026-07-25 13:05:00');
  expect(out.thaiNoTime).toBe('2026-07-25 23:59:59'); // no time → end of day
  expect(out.dashShortYear).toBe('2026-04-25 08:07:00');
  expect(out.isoStr).toBe('2026-07-25 14:30:00');
  expect(out.garbage).toBeNull();
  expect(out.empty).toBeNull();
  await closeApp(app);
});

test('getSoldQty/Inbound/R16103 Before — timeline cutoff at scan time, blank TRANDATE skipped', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => {
    state.r16RawMap.set('S1', [
      { tranDate: '2026-07-27 08:00:00', soldQty: 2 },
      { tranDate: '27/07/2026 9:30', soldQty: 3 },   // after scan time → excluded
      { tranDate: '', soldQty: 99 },                  // no TRANDATE → never counted
    ]);
    state.r16SalesMap.set('S1', 77);
    state.r16InboundRawMap.set('S1', [
      { tranDate: '2026-07-27 07:00:00', qty: 4 },
      { tranDate: '2026-07-27 10:00:00', qty: 6 },
    ]);
    state.r16InboundMap.set('S1', 55);
    state.r16_103RawMap.set('S1', [{ tranDate: '2026-07-27 06:00:00', qty: 1 }]);
    state.r16_103Map.set('S1', 44);

    const at = '2026-07-27 09:00:00';
    const r = {
      sold: getSoldQtyBefore('S1', at),
      inbound: getInboundQtyBefore('S1', at),
      r103: getR16103QtyBefore('S1', at),
      unknownSku: getSoldQtyBefore('S-NOPE', at),
    };
    // fallback: no raw timeline → aggregate map (เครื่องที่รับ R16 ผ่าน sync ไม่มี rawMap)
    state.r16RawMap.clear();
    r.fallbackAggregate = getSoldQtyBefore('S1', at);

    state.r16SalesMap.clear(); state.r16InboundRawMap.clear(); state.r16InboundMap.clear();
    state.r16_103RawMap.clear(); state.r16_103Map.clear();
    return r;
  });
  expect(out.sold).toBe(2);
  expect(out.inbound).toBe(4);
  expect(out.r103).toBe(1);
  expect(out.unknownSku).toBe(0);
  expect(out.fallbackAggregate).toBe(77);
  await closeApp(app);
});

test('getPharmacistAuditEffectiveQty — formula and pre-baseline freeze', async ({ browser }) => {
  const app = await bootBare(browser);
  const out = await app.page.evaluate(() => {
    currentBranch = 'SRC';
    _r01BaselineAt = '';
    state.r16RawMap.set('S1', [{ tranDate: '2026-07-27 08:00:00', soldQty: 2 }]);
    state.r16InboundRawMap.set('S1', [{ tranDate: '2026-07-27 08:10:00', qty: 4 }]);
    state.r16_103RawMap.set('S1', [{ tranDate: '2026-07-27 08:20:00', qty: 1 }]);

    const normal = getPharmacistAuditEffectiveQty('S1', 10, '2026-07-27 09:00:00');

    // pre-baseline: item counted before the current R01 baseline → compare raw only, no R16
    _r01BaselineAt = new Date().toISOString();
    const frozen = getPharmacistAuditEffectiveQty('S1', 10, '2026-01-01 09:00:00');

    currentBranch = ''; _r01BaselineAt = '';
    state.r16RawMap.clear(); state.r16InboundRawMap.clear(); state.r16_103RawMap.clear();
    return { normal, frozen };
  });
  // effective = 10 + sold(2) + r103(1) - inbound(4) = 9
  expect(out.normal.effectiveQty).toBe(9);
  expect(out.normal.soldQty).toBe(2);
  expect(out.normal.inboundQty).toBe(4);
  expect(out.normal.r16103Qty).toBe(1);
  expect(out.frozen).toEqual({ effectiveQty: 10, soldQty: 0, inboundQty: 0, r16103Qty: 0 });
  await closeApp(app);
});
