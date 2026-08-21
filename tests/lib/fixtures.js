// Synthetic ~20-SKU catalog. NEVER put real product/CSV data here.
// Row shapes mirror what the app's own loaders produce (and what the cloud master docs store):
//   PBM (loadProductMaster): { sku, productName, unitPrice }   ← Product Branch Master, 1 doc ต่อสาขา
//   R01 (loadR01):           { colE, productName, systemQty }
//   R05 (loadR05):           { barcode, colE, unitName, unitMultiplier, unitPrice }
//
// The count-quantity price gate reads R05 unitPrice (per barcode), NOT the ProductMaster price —
// so barcode prices below are what the price-gate specs assert on. PM prices are kept only to prove
// they no longer drive the gate.
//
// Col D (colD) is a SOURCE-ONLY column: the parser drops rows whose colD is D / P / REVIEW.
// pmSourceRows keeps every row (what toPmCsv emits); pmRows is the post-filter set the app should end
// up with — asserting one against the other is what proves the filter runs.

const pmSourceRows = [];
const pmRows = [];
const r01Rows = [];
const r05Rows = [];
const PM_SKIPPED_COL_D = ['D', 'P', 'REVIEW'];

// R01 col P (index 15) = product category. Categories that are not stock-on-hand ("11. …" office
// supplies / expenses / freight, and anything marked DELETE) stay fully usable but drop out of the
// Total SKU / Progress set. `colP` is fixture-only: the app stores just an `nc` flag on the parsed row.
const R01_NON_COUNT_COL_P = ['11. อุปกรณ์สำนักงาน / ค่าใช้จ่าย / ขนส่ง', '12. DELETE'];
const isNonCountColP = (colP) => R01_NON_COUNT_COL_P.includes(colP);

// barcodes: [barcode, unitName, unitMultiplier, unitPrice]
function add({ sku, name, price = 10, colD = '', colP = '', sys = 1, barcodes = [[sku + '-B', 'TAB', 1, 10]], inPm = true }) {
  if (inPm) {
    pmSourceRows.push({ sku, productName: name, unitPrice: price, colD });
    if (!PM_SKIPPED_COL_D.includes(colD)) pmRows.push({ sku, productName: name, unitPrice: price });
  }
  r01Rows.push({ colE: sku, productName: name, systemQty: sys, colP });
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
// Col D variants — A stays in the catalog; D/P/REVIEW are dropped from PBM but D/P still have stock in
// R01, so they must remain scannable (as DEL) AND still count toward Progress.
add({ sku: 'S-CATA',   name: 'Test Controlled A',    price: 30, colD: 'A', sys: 4, barcodes: [['B-CATA', 'TAB', 1, 30]] });
add({ sku: 'S-CATP',   name: 'Test Psychotropic P',  price: 30, colD: 'P', sys: 4, barcodes: [['B-CATP', 'TAB', 1, 30]] });
add({ sku: 'S-CATD',   name: 'Test Discontinued D',  price: 30, colD: 'D', sys: 4, barcodes: [['B-CATD', 'TAB', 1, 30]] });
add({ sku: 'S-REVIEW', name: 'Test Review Row',      price: 30, colD: 'REVIEW', sys: 4, barcodes: [['B-REVIEW', 'TAB', 1, 30]] });
add({ sku: 'S-999',    name: 'Test Boundary 999',    price: 10,   sys: 3,  barcodes: [['B-999', 'EA', 1, 999.99]] });
add({ sku: 'S-1000',   name: 'Test Boundary 1000',   price: 10,   sys: 3,  barcodes: [['B-1000', 'EA', 1, 1000]] });
// DEL item (in R01, not in ProductMaster) — now allowed to take a qty when its barcode is cheap
add({ sku: 'S-ONLYR01',name: 'Test R01 Only',        inPm: false, sys: 6,  barcodes: [['B-ONLYR01', 'EA', 1, 40]] });
// R01 col P categories that must NOT count — stock is non-zero on purpose, so only the category excludes them
add({ sku: 'S-OFFICE', name: 'Test Office Supply',   price: 15, sys: 7,  colP: '11. อุปกรณ์สำนักงาน / ค่าใช้จ่าย / ขนส่ง', barcodes: [['B-OFFICE', 'EA', 1, 15]] });
add({ sku: 'S-DELCAT', name: 'Test Deleted Category',price: 15, sys: 9,  colP: '12. DELETE', barcodes: [['B-DELCAT', 'EA', 1, 15]] });
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

// "SKU ที่ต้องนับ" = R01 rows with systemQty !== 0 AND a countable col-P category — the single set
// behind both Total SKU and the Progress numerator/denominator. PBM membership is deliberately
// irrelevant; negatives count (the "sold short" case) while a true 0 does not.
const COUNTABLE_SKUS = new Set(
  r01Rows.filter((r) => r.systemQty !== 0 && !isNonCountColP(r.colP)).map((r) => r.colE),
);

module.exports = {
  pmSourceRows, pmRows, r01Rows, r01CloudRows, r05Rows,
  toPmCsv, toR01Csv, toR05Csv,
  CANARY,
  CATALOG_SIZE: r01Rows.length,
  COUNTABLE_SKUS,
  COUNTABLE_COUNT: COUNTABLE_SKUS.size,
};
