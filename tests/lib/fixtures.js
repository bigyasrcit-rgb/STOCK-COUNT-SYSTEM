// Synthetic ~20-SKU catalog. NEVER put real product/CSV data here.
// Row shapes mirror what the app's own loaders produce (and what the cloud master docs store):
//   PBM (loadProductMaster): { sku, productName, unitPrice, cat? }  ← Product Branch Master, 1 doc ต่อสาขา
//   R01 (loadR01):           { colE, productName, systemQty }
//   R05 (loadR05):           { barcode, colE, unitName, unitMultiplier, unitPrice }
//
// The count-quantity price gate reads R05 unitPrice (per barcode), NOT the ProductMaster price —
// so barcode prices below are what the price-gate specs assert on. PM prices are kept only to prove
// they no longer drive the gate.
//
// Col D (colD) drives two separate things:
//   1) filter — the parser drops rows whose colD is D / P / REVIEW.
//      pmSourceRows keeps every row (what toPmCsv emits); pmRows is the post-filter set the app should
//      end up with — asserting one against the other is what proves the filter runs.
//   2) countable set (ส.ค. 2026) — only colD A / B / C is "ต้องเดินไปนับ", and the parser keeps the
//      letter as `cat` on surviving rows. R01 col G is no longer part of that decision.

const pmSourceRows = [];
const pmRows = [];
const r01Rows = [];
const r05Rows = [];
const PM_SKIPPED_COL_D = ['D', 'P', 'REVIEW'];
const PM_COUNT_COL_D = ['A', 'B', 'C'];
const isAbcColD = (colD) => PM_COUNT_COL_D.includes(String(colD ?? '').trim().toUpperCase());

// R01 col P (index 15) = product category. Categories that are not stock-on-hand ("11. …" office
// supplies / expenses / freight, and anything marked DELETE) stay fully usable but drop out of the
// Total SKU / Progress set. `colP` is fixture-only: the app stores just an `nc` flag on the parsed row.
const R01_NON_COUNT_COL_P = ['11. อุปกรณ์สำนักงาน / ค่าใช้จ่าย / ขนส่ง', '12. DELETE'];
const isNonCountColP = (colP) => R01_NON_COUNT_COL_P.includes(colP);

// colD defaults to 'A' so ordinary fixtures stay countable; pass colD:'' for the "in PBM but
// unclassified" case and inR01:false for "in PBM only, never stocked here".
// barcodes: [barcode, unitName, unitMultiplier, unitPrice]
function add({ sku, name, price = 10, colD = 'A', colP = '', sys = 1, barcodes = [[sku + '-B', 'TAB', 1, 10]], inPm = true, inR01 = true }) {
  if (inPm) {
    pmSourceRows.push({ sku, productName: name, unitPrice: price, colD });
    if (!PM_SKIPPED_COL_D.includes(colD)) {
      pmRows.push({ sku, productName: name, unitPrice: price, ...(isAbcColD(colD) ? { cat: colD } : {}) });
    }
  }
  if (inR01) r01Rows.push({ colE: sku, productName: name, systemQty: sys, colP });
  for (const [barcode, unitName, unitMultiplier, unitPrice] of barcodes) {
    r05Rows.push({ barcode, colE: sku, unitName, unitMultiplier, unitPrice: unitPrice === undefined ? null : unitPrice });
  }
}

// cheap tablet + expensive box: the tablet may take a typed qty, the box may not
add({ sku: 'S-NORM',   name: 'Test Paracetamol 500', price: 50,   sys: 10, barcodes: [['B-NORM', 'TAB', 1, 50], ['B-NORM-BOX', 'BOX', 12, 1500]] });
add({ sku: 'S-PRICEY', name: 'Test Expensive Serum', price: 20,   sys: 5,  barcodes: [['B-PRICEY', 'EA', 1, 1500]] });
add({ sku: 'S-NOPRICE',name: 'Test No Price Item',   price: 50,   sys: 8,  barcodes: [['B-NOPRICE', 'EA', 1, null]] });
add({ sku: 'S-ZERO',   name: 'Test Zero Stock Med',  price: 20,   sys: 0,  barcodes: [['B-ZERO', 'TAB', 1, 20]] });
add({ sku: 'S-NEG',    name: 'Test Negative Stock',  price: 20,   sys: -3, barcodes: [['B-NEG', 'TAB', 1, 20]] });
add({ sku: 'S-MULTI',  name: 'Test Multi Pack',      price: 100,  sys: 60, barcodes: [['B-M1', 'TAB', 1, 100], ['B-M6', 'STRIP', 6, 600], ['B-M24', 'BOX', 24, 2400]] });
// Col D variants — A/B/C stay in the catalog and pull their SKU into the count even at zero stock.
// D/P/REVIEW are dropped from PBM but still have stock in R01, so they stay scannable (as DEL) AND
// still count — the A/B/C clause adds, it never subtracts.
add({ sku: 'S-CATA',   name: 'Test Controlled A',    price: 30, colD: 'A', sys: 4, barcodes: [['B-CATA', 'TAB', 1, 30]] });
add({ sku: 'S-CATP',   name: 'Test Psychotropic P',  price: 30, colD: 'P', sys: 4, barcodes: [['B-CATP', 'TAB', 1, 30]] });
add({ sku: 'S-CATD',   name: 'Test Discontinued D',  price: 30, colD: 'D', sys: 4, barcodes: [['B-CATD', 'TAB', 1, 30]] });
add({ sku: 'S-REVIEW', name: 'Test Review Row',      price: 30, colD: 'REVIEW', sys: 4, barcodes: [['B-REVIEW', 'TAB', 1, 30]] });
// The whole point of the ส.ค. 2026 rule: a fast-moving item the system thinks is empty still gets counted
add({ sku: 'S-ABC0',   name: 'Test Fast Mover Empty',price: 30, colD: 'B', sys: 0, barcodes: [['B-ABC0', 'TAB', 1, 30]] });
// Unclassified (blank Col D) — counted only through the stock clause, so it splits on systemQty:
// stock → counted; zero → the one shape that drops out of the count entirely
add({ sku: 'S-NOCAT',  name: 'Test Unclassified',    price: 30, colD: '',  sys: 5, barcodes: [['B-NOCAT', 'TAB', 1, 30]] });
add({ sku: 'S-NOCAT0', name: 'Test Unclassified 0',  price: 30, colD: '',  sys: 0, barcodes: [['B-NOCAT0', 'TAB', 1, 30]] });
// Classified A but never stocked at this branch (no R01 row at all) → not countable
add({ sku: 'S-PMONLY', name: 'Test PBM Only',        price: 30, colD: 'A', inR01: false, barcodes: [['B-PMONLY', 'TAB', 1, 30]] });
add({ sku: 'S-999',    name: 'Test Boundary 999',    price: 10,   sys: 3,  barcodes: [['B-999', 'EA', 1, 999.99]] });
add({ sku: 'S-1000',   name: 'Test Boundary 1000',   price: 10,   sys: 3,  barcodes: [['B-1000', 'EA', 1, 1000]] });
// DEL item (in R01, not in ProductMaster) — now allowed to take a qty when its barcode is cheap
add({ sku: 'S-ONLYR01',name: 'Test R01 Only',        inPm: false, sys: 6,  barcodes: [['B-ONLYR01', 'EA', 1, 40]] });
// R01 col P categories that must NOT count. Col D is 'A' on purpose: the R01 category has to win over
// the PBM classification, otherwise office supplies would be pulled back into the count.
add({ sku: 'S-OFFICE', name: 'Test Office Supply',   price: 15, sys: 7,  colD: 'A', colP: '11. อุปกรณ์สำนักงาน / ค่าใช้จ่าย / ขนส่ง', barcodes: [['B-OFFICE', 'EA', 1, 15]] });
add({ sku: 'S-DELCAT', name: 'Test Deleted Category',price: 15, sys: 9,  colD: 'C', colP: '12. DELETE', barcodes: [['B-DELCAT', 'EA', 1, 15]] });
for (let i = 1; i <= 9; i++) {
  add({ sku: `S-F0${i}`, name: `Test Filler ${i}`, price: 10, sys: i, barcodes: [[`B-F0${i}`, 'EA', 1, 10]] });
}

// CSV emitters matching the exact column positions the file parsers read.
function esc(v) { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
const joinRows = (rows) => rows.map((r) => r.map(esc).join(',')).join('\r\n');

// PBM: col0=sku, col1=name, col3=colD (D/P/REVIEW get dropped by the parser), col9=price
// Emits pmSourceRows on purpose — the app must do the filtering, not the fixture.
function toPmCsv() {
  const rows = [['SKU', 'NAME', 'C2', 'GROUP', 'C4', 'C5', 'C6', 'C7', 'C8', 'PRICE']];
  for (const r of pmSourceRows) rows.push([r.sku, r.productName, '', r.colD || '', '', '', '', '', '', r.unitPrice == null ? '' : String(r.unitPrice)]);
  return joinRows(rows);
}
// R01: col4=colE, col5=name, col6=systemQty, col15=colP (category)
function toR01Csv() {
  const rows = [['C0', 'C1', 'C2', 'C3', 'COLE', 'NAME', 'QTY', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13', 'C14', 'CATEGORY']];
  for (const r of r01Rows) rows.push(['', '', '', '', r.colE, r.productName, String(r.systemQty), '', '', '', '', '', '', '', '', r.colP || '']);
  return joinRows(rows);
}
// R05: col0=barcode, col1=unitPrice, col4=colE, col6=unitName, col7=unitMultiplier
function toR05Csv() {
  const rows = [['BARCODE', 'PRICE', 'C2', 'C3', 'COLE', 'C5', 'UNIT', 'MULT']];
  for (const r of r05Rows) {
    rows.push([r.barcode, r.unitPrice == null ? '' : String(r.unitPrice), '', '', r.colE, '', r.unitName, String(r.unitMultiplier)]);
  }
  return joinRows(rows);
}

// Canary for "is the derived catalog actually usable?" — skuMap can exist while every systemQty is 0
// (derived before R01 landed), which silently corrupts pass/audit decisions.
const CANARY = { sku: 'S-NORM', systemQty: 10 };

// Shape loadR01() produces (col P collapsed to an `nc` flag) — this is what lands in {branch}_r01 and
// what seedMasters must write, so the cloud-restore path behaves exactly like a real upload.
const r01CloudRows = r01Rows.map(({ colE, productName, systemQty, colP }) => ({
  colE, productName, systemQty, ...(isNonCountColP(colP) ? { nc: 1 } : {}),
}));

// "SKU ที่ต้องนับ" (ส.ค. 2026) = has an R01 row AND a countable col-P category
//                                AND ( systemQty !== 0  OR  classified A/B/C in the PBM ).
// The single set behind both Total SKU and the Progress numerator/denominator.
// The A/B/C clause only ever ADDS: a fast mover the system reports as 0 still has to be checked on
// the shelf. Because it can never subtract, a PBM with no `cat` at all degrades to exactly the
// legacy rule — which is what every branch runs until its file is re-uploaded.
const ABC_SKUS = new Set(pmRows.filter((r) => r.cat).map((r) => r.sku));
const COUNTABLE_SKUS = new Set(
  r01Rows
    .filter((r) => !isNonCountColP(r.colP) && (r.systemQty !== 0 || ABC_SKUS.has(r.colE)))
    .map((r) => r.colE),
);

// What the same fixtures produce when the PBM carries no Col D (docs uploaded before ส.ค. 2026).
// COUNTABLE_SKUS must be a strict superset of this.
const LEGACY_COUNTABLE_SKUS = new Set(
  r01Rows.filter((r) => r.systemQty !== 0 && !isNonCountColP(r.colP)).map((r) => r.colE),
);

// PBM shape as it was written before Col D was kept — used to prove the fallback path
const pmRowsNoCat = pmRows.map(({ sku, productName, unitPrice }) => ({ sku, productName, unitPrice }));

module.exports = {
  pmSourceRows, pmRows, pmRowsNoCat, r01Rows, r01CloudRows, r05Rows,
  toPmCsv, toR01Csv, toR05Csv,
  CANARY,
  CATALOG_SIZE: r01Rows.length,
  ABC_SKUS,
  COUNTABLE_SKUS,
  COUNTABLE_COUNT: COUNTABLE_SKUS.size,
  LEGACY_COUNTABLE_SKUS,
  LEGACY_COUNTABLE_COUNT: LEGACY_COUNTABLE_SKUS.size,
};
