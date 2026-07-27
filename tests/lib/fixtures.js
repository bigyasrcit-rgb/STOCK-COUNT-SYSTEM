// Synthetic ~20-SKU catalog. NEVER put real product/CSV data here.
// Row shapes mirror what the app's own loaders produce (and what the cloud master docs store):
//   PM  (loadProductMaster index.html:2601): { sku, productName, unitPrice, cat? }
//   R01 (loadR01 :2616):                     { colE, productName, systemQty }
//   R05 (loadR05 :2640):                     { barcode, colE, unitName, unitMultiplier }

const pmRows = [];
const r01Rows = [];
const r05Rows = [];

function add({ sku, name, price = 10, cat = '', sys = 1, barcodes = [[sku + '-B', 'TAB', 1]], inPm = true }) {
  if (inPm) pmRows.push({ sku, productName: name, unitPrice: price, ...(cat ? { cat } : {}) });
  r01Rows.push({ colE: sku, productName: name, systemQty: sys });
  for (const [barcode, unitName, unitMultiplier] of barcodes) r05Rows.push({ barcode, colE: sku, unitName, unitMultiplier });
}

add({ sku: 'S-NORM',   name: 'Test Paracetamol 500', price: 50,     sys: 10, barcodes: [['B-NORM', 'TAB', 1], ['B-NORM-BOX', 'BOX', 12]] });
add({ sku: 'S-PRICEY', name: 'Test Expensive Serum', price: 1500,   sys: 5,  barcodes: [['B-PRICEY', 'EA', 1]] });
add({ sku: 'S-NOPRICE',name: 'Test No Price Item',   price: null,   sys: 8,  barcodes: [['B-NOPRICE', 'EA', 1]] });
add({ sku: 'S-ZERO',   name: 'Test Zero Stock Med',  price: 20,     sys: 0,  barcodes: [['B-ZERO', 'TAB', 1]] });
add({ sku: 'S-NEG',    name: 'Test Negative Stock',  price: 20,     sys: -3, barcodes: [['B-NEG', 'TAB', 1]] });
add({ sku: 'S-MULTI',  name: 'Test Multi Pack',      price: 100,    sys: 60, barcodes: [['B-M1', 'TAB', 1], ['B-M6', 'STRIP', 6], ['B-M24', 'BOX', 24]] });
add({ sku: 'S-CATA',   name: 'Test Controlled A',    price: 30, cat: 'A', sys: 4, barcodes: [['B-CATA', 'TAB', 1]] });
add({ sku: 'S-CATP',   name: 'Test Psychotropic P',  price: 30, cat: 'P', sys: 4, barcodes: [['B-CATP', 'TAB', 1]] });
add({ sku: 'S-999',    name: 'Test Boundary 999',    price: 999.99, sys: 3,  barcodes: [['B-999', 'EA', 1]] });
add({ sku: 'S-1000',   name: 'Test Boundary 1000',   price: 1000,   sys: 3,  barcodes: [['B-1000', 'EA', 1]] });
add({ sku: 'S-ONLYR01',name: 'Test R01 Only',        inPm: false,   sys: 6,  barcodes: [['B-ONLYR01', 'EA', 1]] });
for (let i = 1; i <= 9; i++) {
  add({ sku: `S-F0${i}`, name: `Test Filler ${i}`, price: 10, sys: i, barcodes: [[`B-F0${i}`, 'EA', 1]] });
}

// CSV emitters matching the exact column positions the file parsers read.
function esc(v) { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
const joinRows = (rows) => rows.map((r) => r.map(esc).join(',')).join('\r\n');

// PM: col0=sku, col1=name, col3=colD(cat/REVIEW), col9=price
function toPmCsv() {
  const rows = [['SKU', 'NAME', 'C2', 'GROUP', 'C4', 'C5', 'C6', 'C7', 'C8', 'PRICE']];
  for (const r of pmRows) rows.push([r.sku, r.productName, '', r.cat || '', '', '', '', '', '', r.unitPrice == null ? '' : String(r.unitPrice)]);
  return joinRows(rows);
}
// R01: col4=colE, col5=name, col6=systemQty
function toR01Csv() {
  const rows = [['C0', 'C1', 'C2', 'C3', 'COLE', 'NAME', 'QTY']];
  for (const r of r01Rows) rows.push(['', '', '', '', r.colE, r.productName, String(r.systemQty)]);
  return joinRows(rows);
}
// R05: col0=barcode, col4=colE, col6=unitName, col7=unitMultiplier
function toR05Csv() {
  const rows = [['BARCODE', 'C1', 'C2', 'C3', 'COLE', 'C5', 'UNIT', 'MULT']];
  for (const r of r05Rows) rows.push([r.barcode, '', '', '', r.colE, '', r.unitName, String(r.unitMultiplier)]);
  return joinRows(rows);
}

// Canary for "is the derived catalog actually usable?" — skuMap can exist while every systemQty is 0
// (derived before R01 landed), which silently corrupts pass/audit decisions.
const CANARY = { sku: 'S-NORM', systemQty: 10 };

module.exports = { pmRows, r01Rows, r05Rows, toPmCsv, toR01Csv, toR05Csv, CANARY, CATALOG_SIZE: r01Rows.length };
