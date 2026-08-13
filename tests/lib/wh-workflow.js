// Synthetic WH workflow fixtures. These shapes mirror the deployed legacy inbox/marker documents
// and the schema-v2 stock_sessions/WH/items/{sku} documents. Never put production data here.
const { adminDb } = require('./emulator');

function localTimestamp(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ` +
    `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function makeWhCountItem({
  sku, epoch, qty = 1, staff = 'มุก', at = new Date(), rev = 1,
  status = 'scanning', systemQty,
} = {}) {
  if (!sku || epoch == null) throw new Error('makeWhCountItem requires sku and epoch');
  const countAt = at instanceof Date ? at.toISOString() : String(at);
  const timestamp = localTimestamp(at instanceof Date ? at : new Date(at));
  return {
    sku: String(sku),
    countResetAt: String(epoch),
    rev,
    updatedBy: staff,
    countedQty: Number(qty),
    status,
    auditStatus: status === 'pass' ? 'approved' : 'pending',
    scannedBy: staff,
    auditor: '',
    timestamp,
    firstScanAt: timestamp,
    barcode: `B-${sku}`,
    location: 'A1-01',
    countAt,
    ...(systemQty == null ? {} : { systemQty: Number(systemQty) }),
  };
}

function makeLegacyCountInbox(item) {
  return {
    countedQty: Number(item.countedQty),
    scannedBy: item.scannedBy || '',
    timestamp: item.timestamp || '',
    firstScanAt: item.firstScanAt || item.timestamp || '',
    barcode: item.barcode || '',
    location: item.location || '',
    countAt: item.countAt || '',
    countResetAt: item.countResetAt || '',
  };
}

function makeLegacyCountMarker(item, {
  status = 'pass', systemQty = item.countedQty, confirmedBy = 'มายด์',
  confirmedAt = new Date().toISOString(), r01Version = 'R01-TEST-1',
  r16Version = 'R16-WH-TEST-1', r16_103Version = '',
} = {}) {
  const countedQty = Number(item.countedQty);
  return {
    status,
    auditStatus: status === 'pass' ? 'approved' : status === 'audit' ? 'pending' : 'stock_adjustment',
    countedQty,
    scannedBy: item.scannedBy || '',
    countAt: item.countAt || '',
    timestamp: item.timestamp || '',
    firstScanAt: item.firstScanAt || item.timestamp || '',
    barcode: item.barcode || '',
    location: item.location || '',
    soldQty: 0,
    inboundQty: 0,
    r16103Qty: 0,
    effectiveQty: countedQty,
    systemQty: Number(systemQty),
    r01Version,
    r16Version,
    r16_103Version,
    confirmedAt,
    confirmedBy,
    countResetAt: item.countResetAt || '',
  };
}

function makeAuditItem(item, {
  systemQty = Number(item.countedQty) + 1,
  confirmedBy = 'มายด์', confirmedAt = new Date().toISOString(),
  r01Version = 'R01-TEST-1', r16Version = 'R16-WH-TEST-1',
} = {}) {
  const marker = makeLegacyCountMarker(item, {
    status: 'audit', systemQty, confirmedBy, confirmedAt, r01Version, r16Version,
  });
  return {
    ...item,
    ...marker,
    sku: item.sku,
    rev: Number(item.rev || 0) + 1,
    initialStatus: 'audit',
    auditor: '',
    countConfirmedAt: confirmedAt,
    countConfirmedBy: confirmedBy,
  };
}

function makeLegacyRecheckInbox(item, {
  qty = item.systemQty == null ? item.countedQty : item.systemQty,
  staff = 'ตั๋ง', at = new Date(),
} = {}) {
  return {
    recheckQty: Number(qty),
    recheckBy: staff,
    recheckAt: at instanceof Date ? at.toISOString() : String(at),
    countResetAt: item.countResetAt || '',
  };
}

function makeLegacyRecheckMarker(item, recheck, {
  status = Number(recheck.recheckQty) === Number(item.systemQty) ? 'pass' : 'stock_adjustment',
  auditor = 'มายด์', confirmedAt = new Date().toISOString(),
  r01Version = 'R01-TEST-1', r16Version = 'R16-WH-TEST-1', r16_103Version = '',
} = {}) {
  return {
    status,
    auditStatus: status === 'pass' ? 'approved' : 'stock_adjustment',
    auditor,
    confirmedAt,
    timestamp: localTimestamp(new Date(confirmedAt)),
    recheckQty: Number(recheck.recheckQty),
    recheckBy: recheck.recheckBy || '',
    recheckAt: recheck.recheckAt || '',
    systemQty: Number(item.systemQty),
    r01Version,
    r16Version,
    r16_103Version,
    countResetAt: item.countResetAt || '',
  };
}

async function writeDocsBatched(db, docs, { batchSize = 400 } = {}) {
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = db.batch();
    for (const { path, data, merge = false } of docs.slice(i, i + batchSize)) {
      batch.set(db.doc(path), data, { merge });
    }
    await batch.commit();
  }
}

async function seedWhWorkflow(projectId, {
  items = [], countInbox = {}, countMarkers = {}, recheckInbox = {}, recheckMarkers = {},
  replaceLegacy = true,
} = {}) {
  const db = adminDb(projectId);
  await writeDocsBatched(db, items.map((item) => ({
    path: `stock_sessions/WH/items/${item.sku}`,
    data: item,
  })));
  const legacy = [
    ['WH_counts', countInbox],
    ['WH_count_confirmations', countMarkers],
    ['WH_rechecks', recheckInbox],
    ['WH_recheck_confirmations', recheckMarkers],
  ];
  for (const [id, data] of legacy) {
    const ref = db.doc(`stock_sessions/${id}`);
    if (replaceLegacy) await ref.set(data);
    else await ref.set(data, { merge: true });
  }
}

async function readCollectionMap(projectId, path) {
  const snap = await adminDb(projectId).collection(path).get();
  const out = {};
  snap.forEach((doc) => { out[doc.id] = doc.data(); });
  return out;
}

async function listWhConfirmOps(projectId, { kind, state } = {}) {
  const all = await readCollectionMap(projectId, WH_CONFIRM_OP.collection);
  return Object.entries(all)
    .map(([id, data]) => ({ id, ...data }))
    .filter((op) => (!kind || op.kind === kind) && (!state || op.state === state));
}

async function readWhConfirmResults(projectId, opId) {
  return readCollectionMap(projectId, `${whConfirmOpPath(opId)}/results`);
}

function makeManyPending({ count, epoch, prefix = 'WH-T', staffNames = ['มุก', 'ตั๋ง'] }) {
  const items = [];
  const countInbox = {};
  const r01Rows = [];
  for (let i = 0; i < count; i++) {
    const sku = `${prefix}${String(i + 1).padStart(4, '0')}`;
    const qty = (i % 9) + 1;
    const item = makeWhCountItem({ sku, epoch, qty, staff: staffNames[i % staffNames.length] });
    items.push(item);
    countInbox[sku] = makeLegacyCountInbox(item);
    r01Rows.push({ colE: sku, productName: `Synthetic WH item ${i + 1}`, systemQty: qty });
  }
  return { items, countInbox, r01Rows };
}

// Public schema contract for the staged WH confirmation protocol. Tests intentionally refer to
// these exact field names so an accidental runtime/schema rename fails loudly.
const WH_CONFIRM_OP = Object.freeze({
  collection: 'stock_sessions/WH/confirm_ops',
  states: Object.freeze(['preparing', 'committed', 'aborted']),
  kinds: Object.freeze(['count', 'recheck']),
  fields: Object.freeze([
    'kind', 'state', 'countResetAt', 'staffName', 'candidateCount', 'candidateHash',
    'r01Version', 'r16Version', 'r16_103Version', 'owner', 'createdAt', 'committedAt',
  ]),
  resultFields: Object.freeze([
    'opId', 'kind', 'sku', 'countResetAt', 'sourceRev', 'sourceAt',
  ]),
});

function whConfirmOpPath(opId) {
  return `${WH_CONFIRM_OP.collection}/${opId}`;
}

function whConfirmResultPath(opId, sku) {
  return `${whConfirmOpPath(opId)}/results/${sku}`;
}

module.exports = {
  localTimestamp,
  makeWhCountItem,
  makeLegacyCountInbox,
  makeLegacyCountMarker,
  makeAuditItem,
  makeLegacyRecheckInbox,
  makeLegacyRecheckMarker,
  makeManyPending,
  WH_CONFIRM_OP,
  whConfirmOpPath,
  whConfirmResultPath,
  seedWhWorkflow,
  writeDocsBatched,
  readCollectionMap,
  listWhConfirmOps,
  readWhConfirmResults,
};
