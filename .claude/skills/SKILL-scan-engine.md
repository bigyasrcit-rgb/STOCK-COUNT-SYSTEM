# SKILL: Scan Engine

โหลดไฟล์นี้เมื่อแก้ไขหรือ debug งานที่เกี่ยวกับ: การสแกน barcode, PDA detection, cloud sync,
role filter ใน scan list, Firestore listener, หรือ WH recheck workflow

---

## PDA vs Manual Detection

`handleScanInput()` ตรวจ inter-keystroke timing (`PDA_KEYSTROKE_THRESHOLD_MS = 150ms`):

- **PDA mode** — keystroke ติดกันภายใน 150ms → `_pdaMode = true` → auto-submit หลัง debounce 80ms (`SCAN_DEBOUNCE_MS`)
- **Manual mode** — keystroke ห่างกัน ≥150ms → `_pdaMode = false` → ไม่ auto-submit แต่มี fallback debounce 350ms ถ้า `value.trim().length >= 6`
- Detection เกิดจาก keystroke ที่ 2 (keystroke แรกไม่มี prev timestamp เทียบ)
- `_pdaMode` reset เป็น false หลังสแกนสำเร็จ

```js
const PDA_KEYSTROKE_THRESHOLD_MS = 150;
const SCAN_DEBOUNCE_MS = 80;
// fallback ใน handleScanInput:
} else if (e.target.value.trim().length >= 6) {
  _scanDebounceTimer = setTimeout(() => { processScan(); }, 350);
}
```

**Enter key:** `handleScanKey()` รับ `e.key==='Enter'`, `e.keyCode===13`, `e.which===13` (ครอบ PDA เก่า)
**Manual submit ⏎:** `submitScanManual()` → clear debounce/PDA state → `processScan()`

State: `_lastKeystrokeTime`, `_pdaMode` reset ใน `resetScanRuntimeState()`, `handleScanKey()` (Enter), debounce callback, `\r\n` path, `removeScanItem()`

### PDA battery policy

- Android wrapper ใช้ `FLAG_KEEP_SCREEN_ON` ระหว่างมีการใช้งาน และปล่อย flag หลังไม่มีการแตะหรือรับ Intent barcode 2 นาที; ห้ามเปลี่ยนกลับไปใช้ `SCREEN_BRIGHT_WAKE_LOCK` เพราะจะบังคับจอสว่างตลอดกะ
- Web Audio บน PDA suspend หลังเสียงสุดท้าย 1.5 วินาทีและ resume อัตโนมัติก่อนเสียงถัดไป โดยไม่เปลี่ยนจังหวะเรียก `beepSuccess`/`beepError`/`beepWarn`
- `body.pda-power-save` ปิดเฉพาะ decorative infinite animations; Desktop และ Firestore Realtime listeners ไม่ได้รับผลกระทบ
- Toast ใช้ข้อความเต็มบน Desktop แต่ผ่าน `_toastMessageForDevice()` เพื่อย่อคำเฉพาะในแอป `StockCountPDA`; ข้อความใหม่ที่ยาวควรเพิ่ม mapping/rule ที่ฟังก์ชันกลางแทนการแยกข้อความตาม role ใน scan path

### CSS ซ่อนตัวอักษรระหว่างรับ barcode

```css
.scan-input.pda-receiving { color: transparent; caret-color: transparent; }
```

ใส่ class เมื่อ PDA mode, เอาออกใน `processScan()` / `resetScanRuntimeState()`

---

## Scan Input Formats

```
barcode                 → qty = 1
barcode,qty
location,barcode,qty
SKU                     → resolve smallest-unit barcode
SKU,qty
location,SKU,qty
```

---

## handleBarcode() — Core Scan Logic

1. lookup `barcodeMap` → ถ้าไม่พบ → lookup `skuDirectMap`
2. ถ้า item confirmed (`pass`, `audit`, `stock_adjustment`) → block scan, toast "สแกนและ Confirm ไปแล้ว"
3. accumulate `countedQty`, set `status='scanning'`, `scannedBy=currentUser`, `firstScanAt` (ครั้งแรกเท่านั้น)

**WH recheck branch (warehouse role สแกน SKU ที่ `status==='audit'`):**
- สะสม `sd.recheckQty`, `sd.recheckBy = currentUser`
- status คง `audit` ไม่เปลี่ยน

**2-minute scan gap — ถอดออกแล้ว (July 2026, ทุก branch):**
- เดิมสาขายา: SKU เดิมสแกนซ้ำหลัง 2 นาที → `showScanGapModal()` ถามรีเซ็ต — **ลบ block ออกจาก `processScan` แล้ว** สแกนซ้ำ = บวกสะสม ไม่ reset/ไม่เตือน
- `showScanGapModal`/`confirmScanGap`/modal HTML = **dead code** (จงใจทิ้งไว้ ไม่ลบ) — แต่ `_scanGapHold` ยังถูกเช็คใน hold-guard ทุกจุด (คู่กับ `_zeroSysHold`) **ห้ามลบ guard พวกนั้น** ถ้าจะ reintroduce gap ต้องเช็คทั้งคู่เหมือนเดิม
- ⚠️ operational: เผลอสแกนของที่นับไปนานแล้วซ้ำ = ยอดบวกเพิ่มเงียบๆ — ทางแก้ของ user คือปุ่ม ✕ (`removeScanItem`) นับใหม่

---

## negSys — ระบบติดลบ (สาขายาเท่านั้น, July 2026)

`rebuildMaps`: สาขายา (`_isPharmacyBranch()`) systemQty < 0 → clamp เป็น `0` + flag `skuMap[sku].negSys=true`
(ข้อมูลดิบใน `r01Data` เก็บค่าติดลบจริง — WH ไม่ clamp เห็นค่าจริง)

**zeroSysModal — ถาม "มีของจริงไหม" (นับ 0 บน PDA):**
สแกน**ครั้งแรก**ของสินค้า `negSys || systemQty===0` (plain scan, `qty===null`) → `handleBarcode` เซ็ต `_zeroSysHold` + `showZeroSysModal()` แล้ว return — ยังไม่บันทึกอะไร
- "🚫 ไม่มีของ" → `confirmZeroSys(false)`: countedQty += 0, status `scanning` → Confirm แล้ว **pass** (0===0) เข้า progress
- "✅ มีของ" → `confirmZeroSys(true)`: บวก addQty ตามสแกนปกติ — สแกนถัดไปของ SKU เดิมไม่ถามซ้ำ (`sd.scans.length>0`)
- `_zeroSysHold` เป็น hold state คู่กับ `_scanGapHold` — **ทุก guard ต้องเช็คทั้งคู่**: `handleScanKey`, `handleScanInput`, `submitScanManual`, `processScan`, `drainQueue`, `resetScanRuntimeState`, `_loginModalOpen` (refocus list)
- พิมพ์ `bc,qty` เอง (qty ไม่ null รวม `,0`) → ข้าม modal บันทึกตรง

- `evaluatePendingScans`: item `negSys` ที่ effectiveCnt ≠ 0 → **`stock_adjustment` ทันที** (`auditStatus='stock_adjustment'`) ข้ามคิวเภสัช verify; effectiveCnt = 0 → pass

## noStock — ไม่มีของจริง ระบบมีสต็อค (สาขายาเท่านั้น, July 2026)

เคสกลับด้านของ negSys: systemQty > 0 แต่ชั้นว่าง (สแกนไม่ได้ พิมพ์ `,0` บน PDA ไม่ได้)
ปุ่ม **🚫 นับ 0** ในป็อปอัพสต็อค (gate: `_isPharmacyBranch() && currentRole==='assistant' && status==='pending' && systemQty>0`)
→ `showNoStockModal(sku)` → `confirmNoStock()` — **popup path ไม่ใช่ scan path** (pattern เดียวกับ `updatePopupQty` ไม่แตะ `_zeroSysHold`/`drainQueue`):
- เซ็ต `countedQty=0, status='scanning', noStock=true, scannedBy, timestamp/firstScanAt` + `scanListMap.set` ตรงๆ → ขึ้น RESULT qty 0
- re-guard `status==='pending'` ตอน confirm (กัน cloud listener เปลี่ยน status ระหว่าง modal เปิด)
- `evaluatePendingScans`: `sd.noStock && effectiveCnt===0 && sys>0` → **`stock_adjustment` ทันที** ข้ามคิวเภสัช (branch ถัดจาก rule negSys) → ORDS ขาด diff = 0−systemQty
- สแกนของจริงภายหลัง (effectiveCnt ≠ 0) → flag เป็นหมัน ตกลง rule ปกติ — ไม่ต้องล้างใน `handleBarcode`
- **flag hygiene 3 จุด** (mutate in place ต้องล้างเอง): `removeScanItem` (✕ undo), `resetStaleScanningItems` (ข้ามวัน), day-rollover scrub ใน `syncToFirestore` (destructure exclusion) — `_resetLocalScanDataToPending` สร้าง object ใหม่ flag หลุดเอง
- persist ครบทุก layer (localStorage / Firestore / ข้ามเครื่อง) เพราะ sync strip แค่ `retries`/`scans`
- known gap (ตั้งใจยังไม่แก้ ก.ค. 2026): เภสัชยืนยัน qty=0 ในคิว audit ไม่ได้ (`getPharmacistAuditPendingMap` กรอง `>0`) — item audit ที่นับ 0 ค้างตลอด; noStock ไม่ผ่าน audit เลยไม่ชนบั๊กนี้
- `reEvaluateAuditItems`: rule เดียวกัน — negSys ไม่ตรง → `stock_adjustment` ไม่หลุดกลับเข้า `audit`
- Diff ในตาราง Stock Adj + เอกสารปรับสต็อก = `countedQty − 0` = ยอดนับจริง (IRPS ของเกิน) เพราะไม่มี `recheckQty`
- อัพ R01 ใหม่ item เหล่านี้คงสถานะ (flow July 2026: อัพ R01 ไม่รีเซ็ตอะไรใน scanData เลย — ดู "Audit ข้าม R01 Baseline")
- ศูนย์จริง (systemQty = 0 ใน R01) **ไม่เข้า rule นี้** — ยังผ่าน audit → เภสัช verify ตามปกติ

---

## drainQueue & Render Decision

⚠️ **อย่าใช้ `size>prevSize || _pendingPatches.size>0`** — จะ full render ทุกสแกน

```js
// หลัง drain:
if (scanListMap.size > prevSize) {
  renderScanList(); // SKU ใหม่ = full render
} else if (_pendingPatches.size) {
  // patch ทีละ key, ถ้า patchScanRow คืน false → fallback renderScanList()
}
```

`patchScanRow(key)` — in-place DOM update เซลล์ QTY + ย้ายแถวขึ้นบนสุด
คืน `true` = patch สำเร็จ, `false` = ไม่เจอ row/cell → caller ต้อง fallback full render

---

## Scan List Filter by Role (rebuildScanListMap)

| Role | แสดง |
|---|---|
| assistant | เฉพาะ `scannedBy === currentUser` |
| warehouse | ของตัวเอง (scanning) + ทุกคน (audit → worklist รีเช็ค). PDA: แยก 2 tab "เริ่มนับ" / "รีเช็ค" |
| pharmacist | เฉพาะ `status === 'audit'` |
| supervisor | ทุกการสแกนของทุกคน; Desktop WH มี status filter row |
| ไม่ได้ login | ทั้งหมด |

**WH PDA 2 tab:** `_whResultTab === 'result'` (scanning) / `_whResultTab === 'recheck'` (audit)
`setWhResultTab(tab)` สลับ + rebuild; `updateWhResultTabs()` อัปเดต active + จำนวน

**Scan list QTY — audit exception:**
- pharmacist / warehouse / supervisor → แสดง `entry.totalQty` (bold) เสมอ ไม่ใช้ threshold >100
- `totalQty` ของ audit row = `sd.recheckQty` ทุก role ที่รีเช็ค (เภสัชสาขายา, warehouse/supervisor WH) — ดู `showRecheck` ใน `rebuildScanListMap()`
- ปุ่ม ✕ บน audit row = `resetRecheckItem()` (ล้าง `recheckQty/recheckBy/recheckAt` + ตั้ง `manualEditAt`) เปิดให้ warehouse WH และเภสัชสาขายา

---

## Scan List QTY Masking

**Threshold inline qty input (July 2026): `_isPharmacyBranch()?10:100`** — สาขายา >10, WH >100 (3 จุดต้องตรงกัน: `renderScanList`, `patchScanRow`, popup `canEdit`)

| Status | เงื่อนไข | แสดง |
|---|---|---|
| scanning | systemQty > threshold (10 สาขายา / 100 WH) | inline `<input>` → `updateInlineQty` |
| scanning | systemQty ≤ threshold | `countedQty` (bold) |
| unknown | — | `countedQty` (bold) เสมอ |
| audit | pharmacist/supervisor | `totalQty` (bold, read-only) |
| pass/audit/etc | countedQty > 100 | แสดง (re-check warning) — **ยังใช้ 100 คงเดิม ไม่ใช่ threshold ใหม่** |
| pass/audit/etc | countedQty ≤ 100 | ซ่อน (กันเกิด counter bias) |

**WH warehouse override:**
- WH PDA (`noEditPda`): scanning ที่ systemQty > 100 → ได้ inline input; ≤100 + audit → `<span>` scan only
- WH Desktop: scanning → ได้ input เสมอ; audit (recheck) → `updateRecheckInlineQty()` เขียน `recheckQty`+`recheckBy`
- ช่องจำนวน inline บน PDA เรียก `beepSuccess()` หนึ่งครั้งหลังบันทึกค่าที่ถูกต้อง; `updateRecheckInlineQty()` ส่งเสียงเฉพาะเมื่อจำนวนเปลี่ยนจริง เพื่อไม่ให้ดังจากการแตะแล้ว blur โดยไม่แก้ค่า

## Pharmacy Desktop-only Confirm (July 2026)

- SRC/KKL/SSS ซ่อนและบล็อก Confirm ใน native app จาก User-Agent `StockCountPDA` โดยตรง ไม่อิง viewport; WH ใช้ confirmation workflow เดิม
- Desktop ต้องออนไลน์และ acquire `stock_sessions/{branch}_confirm_lock` ก่อน Confirm; lock มี `token`, `owner`, `countResetAt`, `startedAt`, `expiresAt` และอายุ 5 นาที การปลดต้องใช้ token เดียวกับเจ้าของ
- PDA ทุกเครื่องฟัง branch lock แล้ว disable ช่อง scan/audit พร้อม guard ที่ `receiveBarcode`, `processScan`, `drainQueue`, `handleBarcode`, การแก้จำนวน และ modal ที่เปลี่ยนยอด; คิวที่รับไว้ก่อนล็อกพักอยู่และทำต่อหลัง lock ถูกลบ/หมดอายุ
- Desktop รอ pending sync จาก PDA แล้วอ่าน session/master จาก Firestore server, snapshot เฉพาะ `scanning`, คำนวณด้วยสูตรเดิมเป็น batch ละ 25 ผ่าน animation frame และแสดง progress
- ก่อน apply ต้องอ่าน server ซ้ำและยืนยัน `countResetAt`, `r01Version`, `r16DetailVersion`, `countedQty`, `timestamp`, `scannedBy`; ถ้าเปลี่ยนให้ abort โดยห้ามเปลี่ยน status บางส่วน รายการใหม่ที่อยู่นอก snapshot คง `scanning` สำหรับรอบถัดไป
- หลัง apply ให้ checkpoint local ก่อน render และ sync Firestore; ถ้า sync ล้มเหลวให้คง lock จน retry สำเร็จหรือ TTL หมด เพื่อกัน Confirm ซ้ำทันที
- Pharmacy branch เขียน Audit result ลง `stock_sessions/{branch}_pharmacy_audit_markers` ก่อน apply local; marker transaction ผูก `countResetAt` และชนะ stale `session_data_json`
- `syncToFirestore(true)` สงวนไว้เฉพาะ `startNewCount()` — stale-day reset/login/Admin exit ใช้ merge เท่านั้น

เงื่อนไข: `sysQty > (_isPharmacyBranch()?10:100) || (whStaffEdit && !noEditPda)`
ทั้ง `renderScanList()` และ `patchScanRow()` ต้องเช็คเหมือนกัน · in-app guide (`guideQtyRule`) แสดงเลข threshold ตาม branch อัตโนมัติ

---

## WH Count/Recheck Confirmation Workflow v2 (August 2026)

- WH workflow v2 ใช้ `stock_sessions/WH/items/{sku}` เป็น live state ของ Count/Recheck; `WH_counts`/`WH_rechecks` เป็น legacy bridge ชั่วคราวเท่านั้น ห้ามบวกสอง source เพราะเป็น scan เดียวกันซ้ำกัน ให้เลือกค่าล่าสุดด้วย `countAt`/`recheckAt`.
- `stock_sessions/WH_r01` has `r01Version`; every WH client listens for a newer version and rebuilds `skuMap`. WH Supervisor login always reloads the cloud R01/session base, so localStorage is cache only.
- WH R16 raw timelines are cloud-shared through top-level versioned chunk docs (`WH_r16_104_<generation>_<index>` / `WH_r16_103_<generation>_<index>`) plus `WH_r16_104_meta` / `WH_r16_103_meta`. Each `data_json` chunk targets at most 650 KB. Upload writes all chunks before switching meta; only the active meta generation is authoritative. Meta also stores `r01Version`; uploading a new R01 invalidates the old R16 set until R16.104/103 are uploaded for that version.
- Supervisor downloads the matching raw timeline into memory/IndexedDB and rebuilds aggregate maps from that same version. IndexedDB is only a cache and is accepted only when `countResetAt` and version match the cloud meta.
- Supervisor precedence is fixed: R01/R16 master → item base → Count final (`committed` op; legacy marker เฉพาะช่วง compatibility) → Count pending เฉพาะเมื่อยังไม่มี final → Recheck final → Recheck pending เฉพาะเมื่อยังไม่มี Recheck final. Recheck final wins over an older Count `audit`.
- Operation schema:
  - `stock_sessions/WH/confirm_ops/{opId}`: `kind`, `state`, `countResetAt`, `staffName`, `candidateCount`, `candidateHash`, `r01Version`, `r16Version`, `r16_103Version`, `owner`, `createdAt`, `committedAt`.
  - `stock_sessions/WH/confirm_ops/{opId}/results/{sku}`: `opId`, `kind`, `sku`, `countResetAt`, `sourceRev`, `sourceAt` + marker fields เดิมทั้งหมด (`status`, quantities, staff/times, R16 components, versions ฯลฯ).
  - materialized `WH/items/{sku}` เก็บ `whCountOpId`/`whRecheckOpId` เพื่อ trace provenance แต่ parent op ที่ committed ยังเป็น authority.
- Confirm protocol: สร้าง parent `state:'preparing'` → stage immutable result docs เป็น batches ≤400 → อ่าน server ตรวจ `candidateCount`/canonical `candidateHash` → transaction อ่าน session epoch, R01/R16 meta, candidate item/legacy sources และ source fingerprint ซ้ำ → flip parent เป็น `state:'committed'` เพียง write เดียว. ถ้า source/version เปลี่ยนให้ abort ทั้ง operation.
- Rules บังคับ result เป็น create-once (update ไม่ได้) และ parent op update ได้เฉพาะเมื่อ state เดิมเป็น `preparing` ไป `preparing|committed|aborted`; committed/aborted ห้ามย้อน แต่ delete ยังเปิดไว้ให้ cleanup.
- Reader ต้อง ignore `preparing`/`aborted`; committed op ต้องโหลด results ครบและ hash ตรงก่อน overlay ทั้งชุดพร้อมกัน. อ่านขาด/ผิด hash = แสดง error และคง state เดิม ห้าม apply บาง SKU.
- หลัง commit ค่อย materialize results ลง `WH/items/{sku}` และล้าง legacy pending แบบ chunk/idempotent. Crash กลางชุดต้อง resume จาก committed results โดยไม่คำนวณใหม่; committed op ชนะ delayed PDA/legacy writes ใน epoch เดียวกันเสมอ.
- Per-staff operation แตะเฉพาะ source ของพนักงานนั้น. Confirm-All ห้ามแบ่งเป็นหลาย committed operations แบบเงียบ ๆ เพราะ Firestore จำกัด 500 writes/transaction และการแบ่งจะเปลี่ยน all-or-none เป็น partial semantics.
- Marker `audit` starts WH recheck with no `recheckQty`; warehouse scans recheck while status remains `audit`, then Supervisor performs the separate recheck confirmation.
- Recheck confirmation transaction reads the latest `WH_r01` data and compares `recheckQty` with that server `systemQty` directly; it does not trust a stale local `skuMap`.
- If a new R01/R16 meta version arrives while a Supervisor is open, Confirm stays blocked until the complete matching timeline is loaded. Never silently fall back to aggregate totals for WH confirmation.
- Migration กลางรอบ: acquire WH lock + รอทุก PDA `Synced` → backup legacy docs/current-epoch items → stage same-epoch legacy finals เป็น migration ops → server verify count/hash → cutover. เก็บ legacy docs read-only; ห้ามลบเพื่อเพิ่มพื้นที่ และห้าม rollback ไปเขียน legacy final หลังมี post-cutover committed op (recovery ต้อง roll-forward).
- `startNewCount()`/full clear ล้าง legacy inbox/markers, active R16 meta/chunks/cache และต้องลบ `results` ใต้ `confirm_ops` ก่อนลบ op parents เพราะ Firestore ไม่ cascade-delete subcollections. ทุก reader ยังต้องกรอง `countResetAt`.
- `firestore.rules` ต้องมี narrow match แยกสำหรับ op/results และ Publish ก่อน runtime deploy. Rules ต้องคง immutable result + monotonic op state ตามด้านบน และ update `WH/items/{sku}` ใน epoch เดียวกันต้องคง `whCountOpId`/`whRecheckOpId` ที่ติดตั้งแล้ว เพื่อกัน delayed old-client replace ลบ final provenance; branch อื่น, epoch ใหม่, create/delete คง behavior เดิม.
- Scan-hour gate 08:00-21:00 applies only to pharmacy branches; WH scanning is available 24 hours.

## WH Recheck Workflow

**warehouse PDA:**
- สแกนนับปกติ (scanning) → confirm โดย supervisor Desktop
- สแกนรีเช็ค audit → สะสม `recheckQty`, `recheckBy`, status คง `audit`
- ปุ่ม ✕ บนแถว audit → `resetRecheckItem(sku)` ลบ recheckQty/recheckBy, ยกเลิก debounce/queue, นับจาก 0 ใหม่

**supervisor Desktop:**
- **ยืนยันนับทีละคน:** `renderSupervisorCountButtons()` → ปุ่มน้ำเงิน per staff → `confirmCountByStaff(name)` → `evaluatePendingScans(name)`
- **ยืนยันรีเช็คทีละคน:** `renderSupervisorRecheckButtons()` → ปุ่มเขียว per staff → `confirmRecheckByStaff(name)`
- **ยืนยันรีเช็คทั้งหมด:** `confirmAllRecheckSupervisor()` → วน audit ที่มี `recheckQty && !auditor` → pass/stock_adjustment + `auditor=มายด์`

**WH recheck confirmation (workflow v2):**
- `confirmRecheckByStaff` / `confirmAllRecheckSupervisor` ใช้ `kind:'recheck'` operation protocol ชุดเดียวกับ Count; transaction ก่อน commit อ่าน `WH_r01` ล่าสุดจาก server เพื่อเทียบ `recheckQty` กับ `systemQty` และเก็บ `systemQty`/versions ไว้ใน result
- committed Recheck result (`status`, `auditor`, `confirmedAt`, `recheckQty`, `recheckAt`, `countResetAt`, versions) authoritative เหนือ Count audit, item snapshot และ legacy `WH_rechecks`/`WH_recheck_confirmations`
- listener ทุกจุดต้อง re-overlay committed ops หลัง item snapshot; late offline `audit` หรือ legacy backfill ห้ามลด `pass`/`stock_adjustment` กลับเป็น Audit
- transaction/commit ล้ม = local state ไม่เปลี่ยน; materialization ล้มหลัง commit = recover ต่อจาก immutable results และ UI ยังใช้ committed result ได้
- `_applyCloudScanData`: local ที่มี `auditor` ห้ามถูก cloud `audit` ที่ไม่มี auditor ทับ แต่ cloud audit ยังชนะ local unverified state ได้ตาม flow เภสัชเดิม

`canVerify = currentRole === 'pharmacist' || currentRole === 'supervisor'`
(warehouse ไม่มีสิทธิ์ verify — ใช้ช่อง scan หลักแทน)

**Pharmacy Audit Verify — PDA สแกน / Desktop ยืนยัน (July 2026):**
- ที่เก็บยอดรีเช็คคือ `sd.recheckQty`/`recheckBy`/`recheckAt` (sync ผ่าน session doc) — `_avMap` เดิมถูก**ลบแล้ว** เพราะอยู่ใน memory ล้วน ยอดจาก PDA จึงไปไม่ถึง Desktop
- เขียนผ่าน `_addRecheckScanQty(sku,sd,addQty)` ทั้งสองทาง: `processPharmacistAuditScan()` (ช่อง scan หลัก) และ `handleAuditVerifyScan()` (popup) — ตั้ง `manualEditAt` ทุกครั้ง
- `getPharmacistAuditPendingMap()` อ่านจาก `state.scanData` (`status==='audit' && recheckQty != null && !auditor && qty>0`) **ห้ามกลับไปอ่าน `scanListMap.totalQty`** — ค่านั้นเป็น `countedQty` รอบแรกในสาขายา
- ปุ่มยืนยันบน PDA สาขายา disabled (`_isPdaApp()`); `confirmRecheckBtn()` และ `_confirmPharmacyAuditBatched()` มี guard ซ้ำ
- `confirmAllAuditVerify()` = dispatcher — สาขายาไป `_confirmPharmacyAuditBatched()` (branch lock + batch 25 + ตรวจ R01/R16 version + `_sameBranchRecheck` ก่อน apply), WH ใช้ loop local เดิม
- `confirmAuditVerifyItem(sku,silent,deferSync)` — `deferSync=true` ให้ batched flow save/sync ครั้งเดียวตอนจบ
- mirror `recheckQty` จาก cloud ใน `_applyCloudScanData()` และ merge ใน `syncToFirestore()` ถูก gate ด้วย `manualEditAt` + `MANUAL_EDIT_PROTECT_MS` — กันเลขเด้งบนเครื่องที่เพิ่งสแกน/รีเซ็ต
- ก่อน apply Verify ทั้งชุด `_confirmPharmacyAuditBatched()` เขียน final marker; marker final ชนะ Audit backfill และ stale session เสมอ
- `startPharmacyAuditMarkerListener()` overlay marker หลัง session ทุกครั้ง; marker-backed SKU ที่ session ทำหายต้อง re-upload ได้ ส่วน SKU confirmed ที่ไม่มี marker ยังใช้ resurrection guard เดิม
- rollout migration อ่าน `stock_audit_log/{branch}_{date}` ตั้งแต่ `countResetAt` (สูงสุด 14 วัน) ครั้งเดียวต่อ epoch เพื่อกู้ Audit ที่หายก่อนมี marker

**WH supervisor = read-only ในป็อปอัพ Audit Verify (`_isWhSupervisorAuditReadonly()`):**
- flow ปัจจุบัน: warehouse สแกนรีเช็คบน PDA → supervisor ยืนยันบน Desktop เท่านั้น supervisor ไม่รีเช็คเอง
- ป็อปอัพซ่อนแถวสแกน (`#avScanRow`) และ `handleAuditVerifyScan()` return ทันที — ห้ามให้การสแกนของ supervisor เขียนทับ `recheckQty`/`recheckBy` ของพนักงานคลัง (จะทำให้ยอดบวกซ้ำและรายการย้ายปุ่มรายคน)
- `avConfirmAllBtn` ของ supervisor ต้อง dispatch ไป `confirmAllRecheckSupervisor()` (transaction + marker) **ห้าม** ใช้ loop `confirmAuditVerifyItem` แบบ local ล้วน

---

## Audit ข้าม R01 Baseline (สาขายา — flow ใหม่ July 2026, แทน stale-scrub เดิม)

**เปลี่ยนพฤติกรรม:** audit ที่เภสัชยังไม่ verify **อยู่รอดข้ามการอัพ R01** ให้เภสัชสแกนรีเช็ควันถัดไป
(เดิม: `resetUnverifiedAuditForNewR01` + stale-scrub ล้างเป็น pending — คือต้นเหตุเคส "Audit 500+ หาย" 11/07/2026 · ฟังก์ชัน reset ถูก**ลบแล้ว**)

**กลไกปัจจุบัน — `_isPreBaselineItem(sd)`:** item ที่ `timestamp||firstScanAt` เก่ากว่า `_r01BaselineAt` เกิน 5 นาที (`_R01_STALE_TOL_MS`)
- เทียบผ่าน Date object เท่านั้น (`replace(' ','T')` ก่อน — iOS) **ห้ามเทียบ string** (timestamp = local 'YYYY-MM-DD HH:mm:ss', baseline = UTC ISO)
- gate `_isPharmacyBranch() && _r01BaselineAt` → WH + baseline ว่าง (startNewCount) = inert
- **2 จุดที่ใช้:**
  1. `reEvaluateAuditItems` — `continue` (freeze: audit เก่าไม่ flip ตอนอัพ R16 วันใหม่, **pass เก่าที่ไม่มี auditor คง pass ถาวร** — behavior change ที่จงใจ กัน audit ผี pollute คิวเภสัชทุกเย็น)
  2. `getPharmacistAuditEffectiveQty` — คืน `effectiveQty=rawQty` ตรงๆ (sold/inbound/r16103 = 0) — R01 ใหม่รวมยอดขายเก่าแล้ว + กัน `getSoldQtyBefore` fallback คืนยอดรวมบนเครื่องที่ไม่มี rawMap

## timestamp vs firstScanAt — ห้ามสลับกัน (ส.ค. 2026)

`sd.timestamp` = **เวลาล่าสุดของสถานะ ไม่ใช่เวลาสแกน** — ถูกเขียนทับด้วยเวลายืนยันใน `confirmAuditVerifyItem`
`sd.firstScanAt` = เวลาสแกนครั้งแรกจริง เขียนครั้งเดียว ไม่เคยถูกทับ (`if(!sd.firstScanAt)sd.firstScanAt=now`)

| ใช้ที่ไหน | ต้องใช้ field ไหน |
|---|---|
| **แสดงผล / Export ทุกจุด** | `sd.firstScanAt||sd.timestamp` เสมอ |
| **จุดคำนวณ — ห้ามเปลี่ยน** | `sd.timestamp` เท่านั้น |

จุดคำนวณที่ห้ามแตะ: ช่วงชดเชย R16 (`getSoldQtyBefore`/`getInboundQtyBefore`/`getR16103QtyBefore` ใน `reEvaluateAuditItems`, `evaluatePendingScans`, batched confirm), day-rollover (`resetStaleScanningItems`), เช็ควันที่ R16, day guard ของ schema v2 sync, `_isPreBaselineItem`
— ทั้งหมดรันก่อน `timestamp` ถูกทับ ผลจึงถูกอยู่แล้ว การสลับเป็น `firstScanAt` จะเปลี่ยนสูตร/พัง sync

`saveAuditLogToFirestore` เก็บทั้งสอง field (`timestamp` + `firstScanAt`) เพื่อให้ Export ที่ fallback ไปอ่าน Audit Log ได้เวลาสแกนจริง · ข้อมูลเก่าไม่มี `firstScanAt` → fallback `||timestamp` ทุกจุด

## Recheck baseline freeze (สาขายา, ก.ค. 2026)

⚠️ **กฎเหล็ก: `recheckQty` ต้องเทียบกับ `systemQty` ที่ freeze ไว้ตอนสแกนเสมอ — ห้ามใช้ `si.systemQty` สด**

`recheckQty` = การนับ ณ จุดเวลาหนึ่ง แต่ `si.systemQty` ขยับทุกครั้งที่อัพ R01 → ถ้ามีของเข้า/ขายคั่นระหว่าง "สแกนรีเช็ค" กับ "กดยืนยัน" จะเทียบข้ามช่วงเวลา = Stock Adjustment ผิด

- `_freezeRecheckBaseline(sku,sd)` — เขียน `recheckSystemQty` + `recheckR01Version` **ทุกจุดที่ตั้ง `recheckQty`**: `_addRecheckScanQty` (สแกน) และ `updatePharmacyRecheckQty` (แก้มือ) · เพิ่ม path ใหม่ที่ตั้ง recheckQty ต้องเรียกด้วย
- `_recheckBaselineSystemQty(sku,sd)` — ตัวอ่านเดียวที่ใช้ตัดสิน ใช้ใน `confirmAuditVerifyItem` + `_pharmacyAuditMarkerFromFinal` (ทั้งสองต้องได้ผลตรงกันเป๊ะ ไม่งั้น marker กับ local ขัดกัน) · fallback = `si.systemQty` สำหรับรายการเก่าก่อน deploy
- ชดเชย R16 ใช้ `sd.recheckAt||sd.timestamp` (เวลา**รีเช็ค** ไม่ใช่เวลานับรอบแรก)
- **marker ต้องพา `recheckSystemQty` ทุก branch** ใน `_applyPharmacyAuditMarkersToState` + builder ทุกตัว — ถ้าหลุด ยืนยันรอบถัดไป fallback ไปใช้ค่าสดแล้วเพี้ยนซ้ำ
- persist ฟรีทั้ง v1/v2 (`SCAN_ITEM_LOCAL_FIELDS`=`['retries','scans','manualEditAt']` เท่านั้นที่ถูก strip)

**ปุ่ม ↺ เปิดรีเช็คใหม่ (`reopenPharmacyAudit`)** — เภสัช + Desktop (`!_isPdaApp()`) + ออนไลน์ เท่านั้น: ย้อน `pass`/`stock_adjustment` กลับเป็น `audit` ล้างยอดรีเช็คให้สแกนใหม่
- ต้องเขียน marker **ก่อน** แก้ local (authoritative)
- marker พก `reopenedAt` → `_writePharmacyAuditMarkers` มี override ให้ชนะ guard "final ชนะ audit เสมอ" (ไม่งั้นปุ่มไม่ทำงาน snapshot ดึงผลเดิมกลับ) + กัน final ที่มาช้ากว่า reopen ทับ
- `keepDraft` ใน `_applyPharmacyAuditMarkersToState` ต้องข้ามเมื่อ `marker.reopenedAt` ไม่งั้นยอดรีเช็คเดิมเด้งกลับ

**อัพ R01 (สาขายา) ทำอะไร:** `_clearR16ForNewBaseline()` (ล้าง R16 maps + `r16Loaded=false` + ล็อค Confirm) + `syncR16MetaToFirestore()` · เครื่องอื่นล้าง R16 ตามผ่าน `_applyR01BaselineUpdate` (จุด adopt R16 จาก session doc gate `s.r16Loaded===true` — ล้างเองไม่ได้ ต้องพ่วง baseline adoption) · `syncToFirestore` serialize `r16Obj/r16InbObj/r16_103Obj` **หลัง** merge/baseline adoption (ห้ามย้ายกลับขึ้นก่อน fetch — laggard จะพา maps เก่าขึ้น cloud)

**ซาก stale machinery (neutered, ห้ามลบ call sites):** `_isStaleAuditVsBaseline` คืน `false` เสมอ → `scrubStaleLocalAudits` = no-op · call sites 5 จุด (`_applyCloudScanData`, `syncToFirestore` scrub block, `restoreFromFirestore` ×2, `initAfterLogin`) คงไว้เพราะฝังใน merge loop ที่ order-sensitive — inert แต่ revert ง่าย (แก้ 1 บรรทัด)

---

## Cloud Sync — _applyCloudScanData()

Shared function ใช้โดย `pullFromCloud()` และ `startScanSessionListener()`

**Merge rules:**
1. **Epoch guard (ก่อนทุก rule):** `s.countResetAt > _countResetAt` → adopt epoch + `_resetLocalScanDataToPending()` (reset ทุก item รวม scanning + confirmed)
2. ดึงเฉพาะ cloud `pending`/`scanning` — confirmed ข้าม **ยกเว้น propagate path**
3. **Propagate confirmed (`_propagateConfirmed=true`):**
   - local มี `auditor` → เก็บ local
   - local confirmed + cloud ไม่มี auditor → mirror `recheckQty`/`recheckBy` เท่านั้น
   - cloud มี `auditor` หรือ local ยังไม่ confirm → ทับ local
4. local item confirmed → ไม่ overwrite (นอก propagate path)
5. `unknownScans` merge เพิ่มเฉพาะ barcode ที่ยังไม่มี
6. หลัง merge → `invalidatePopupRowsCache()` **ก่อน** `renderTable()` เสมอ

**WH recheckQty mirror guard (`currentRole !== 'warehouse'`):**
รัน mirror เฉพาะ supervisor Desktop ไม่รัน warehouse PDA (กัน snapshot เก่าทับค่าที่เพิ่งสแกน)

---

## Cloud Sync — syncToFirestore(overwrite=false)

เรียกอัตโนมัติ 3 วินาทีหลัง `saveSession()`

**Merge rules (overwrite=false):**
1. **Epoch guard:** cloud `countResetAt > local` → adopt + reset + return ทันที (ไม่เขียนทับ)
2. ดึง cloud state มา merge ก่อน แล้ว overwrite ด้วย local
3. local `pending` ไม่ overwrite cloud item ที่มี status อื่น
4. local `scanning`/`pending` ที่ไม่มีใน cloud → ไม่ re-upload
5. local `pass`/`audit`/`stock_adjustment` ที่ไม่มีใน cloud → ไม่ re-upload ยกเว้น Pharmacy SKU ที่มี same-epoch Audit marker (ใช้ซ่อม session ที่ทำรายการหาย)
6. cloud มี `auditor` แต่ local ยังไม่มี → ไม่ overwrite cloud (guard WH recheck race)

**Day-rollover guard (July 2026):**
เครื่องเปิดค้างข้ามคืนไม่ login ใหม่ → `resetStaleScanningItems` (ผูกกับ login) ไม่ทำงาน → sync พาของค้าง `scanning` เมื่อวาน resurrect ขึ้น cloud → เครื่องอื่นเห็น "รอยืนยัน" โผล่
- `runStaleGuard()` (gate วันละครั้งผ่าน `_staleGuardDay`): เรียกต้น `syncToFirestore` ทุกครั้ง + `visibilitychange` resume (push ผ่าน merge — **ห้าม overwrite=true** local ที่หลับมาทั้งคืนอาจเก่ากว่า cloud)
- scrub `mergedSd` ก่อนเขียน: cloud-side `scanning` ที่ timestamp ข้ามวัน → reset เป็น pending ใน payload (จำเป็น — rule 3 ทำให้ local pending ไม่ทับ cloud scanning ของค้างจะไม่หายเอง)

---

## Cloud Sync — startScanSessionListener() (onSnapshot)

เริ่มหลัง login (`initAfterLogin`) — ฟัง `stock_sessions/${branch}`
- เมื่อ snapshot fires → debounce 3s → `_applyCloudScanData()` → `rebuildScanListMap(true)` → render
- ไม่เรียก `saveSession()` ใน handler (กัน sync loop)
- ไม่ทำงานใน admin mode

---

## startNewCount() — ลำดับสำคัญ

**ต้องเรียก `syncToFirestore(true)` ก่อน `rebuildMaps()`** — ขณะที่ scanData ยังว่าง
ถ้าสลับ: `rebuildMaps()` จะ broadcast `pending` ทั้ง catalog ขึ้น cloud ก่อน → ด่านกัน resurrection เสีย

ต้องลบ master doc `${branch}_r01` ด้วย (ไม่ลบ `_r05`):
```js
await db.doc(getSessionId()+'_r01').delete(); // หลัง syncToFirestore(true)
```

**R01 cross-device sync ตอนเริ่มนับใหม่ (แก้แล้ว มิ.ย. 2026):** `startNewCount()` ล้าง `state.r01Data`+badge+timestamp **เฉพาะเครื่องที่กดปุ่ม** เครื่องอื่นรอผ่าน `_r01BaselineAt` (`startNewCount` เซ็ตเป็น `''` ไม่ใช่ timestamp ใหม่กว่า → เครื่องอื่นเทียบ `>` แล้วเห็นว่า "ไม่ใหม่กว่า" เลยไม่ sync ตาม) — เกาะ `_resetLocalR01ToEmpty()` เข้ากับ epoch `countResetAt` (ตัวเดียวกับที่รีเซ็ต scanData) แทน เพราะเดินหน้าทางเดียวจริงเสมอ เรียกคู่กับ `_resetLocalScanDataToPending()` ทุกจุด (`syncToFirestore`, `_applyCloudScanData`, `restoreFromFirestore`)

---

## Known Pitfalls

**Cascade bug June 2026 (commit 58d9d2f→90f4bb8→6fefac9):**
1. แก้ `_applyCloudScanData` → scanning หายจาก RESULT 1-2 วิ
2. แก้ `syncToFirestore` → cloud มีแค่ scanning ไม่มี pending
3. listener delete loop → `state.scanData.get(sku)` undefined → สแกน "ไม่ติด" silent

**drainQueue render bug (มิ.ย. 2026):**
`size>prevSize || _pendingPatches.size>0` → full render ทุกสแกน → กระพริบ โดยเฉพาะ WH inline input
Fix: patch-first logic (ดู drainQueue section)

**เครื่องอื่นไม่เห็น PASS/AUDIT หลัง F5:**
1. Admin Mode ค้าง → `syncToFirestore` return ทุก call
2. `restoreFromFirestore()` early return (แก้ถาวรแล้ว commit 3baa421)
3. มีใครกด "เริ่มนับใหม่" บนเครื่องนั้น
4. `syncToFirestore` merge guard เช็ค `status!=='audit'` เฉยๆ โดยไม่เช็ค `_confirmedSet` ก่อน
   → cloud ที่ยังเป็น scanning (ยังไม่ confirm) ก็เข้าเงื่อนไข "cloud ชนะ" ผิดๆ ด้วย
   → block ไม่ให้ audit สดจาก Confirm ขึ้น cloud ถาวร (แก้แล้ว commit d7768a5)
   → **กฎ:** เพิ่ม guard ใหม่ใน syncToFirestore/_applyCloudScanData ต้องเช็ค `_confirmedSet.has(...)` เสมอ ห้ามใช้ `!==` เทียบ status เดี่ยวๆ

`pullFromCloud()` / `_applyCloudScanData()` ไม่ช่วยกรณีนี้ — merge เฉพาะ `pending`/`scanning` เท่านั้น

**เคส Audit 500+ รายการหาย (11 ก.ค. 2026):**
`resetUnverifiedAuditForNewR01` + stale-scrub ออกแบบเป็น "อัพ R01 = ล้าง audit บังคับนับใหม่" แต่ flow งานจริงคือ "อัพ R01 → เภสัชรีเช็ค audit เมื่อวาน" — audit ที่หมดอายุตั้งแต่อัพ R01 เช้าวันก่อน ค้างบน PDA ที่ไม่ sync จนตัว trigger `visibilitychange→syncToFirestore` (เพิ่ง deploy) บังคับ scrub ตอนเช้า → หายพร้อมกัน 500+ ทุกเครื่อง
- **บทเรียน 1:** logic scrub/reset ใน payload ของ `syncToFirestore` จะระเบิดพร้อมกันทั้ง fleet ตอนเช้าหลัง deploy trigger ใหม่ (ทุกเครื่อง resume ไล่เลี่ยกัน) — เพิ่ม trigger sync ใหม่ต้องนึกถึง scrub ทุกตัวที่พ่วงมาด้วย
- **บทเรียน 2:** ก่อนเขียน logic "ล้างข้อมูลอัตโนมัติ" ต้องยืนยัน workflow จริงของหน้างานก่อน — แก้แล้ว (July 2026): audit อยู่รอดข้าม baseline, stale-scrub neutered

**เคส SKU 200379 (SSS, 7 ส.ค. 2026) — "ของครบแต่ขึ้น DIFF" · ต้นเหตุ: R16 export เร็วเกินไป:**
R01 เช้า 08:10 = 2 · **R16 ที่ใช้ Confirm ครอบถึงแค่ 13:26** · ขาย 1 ตอน 15:22 (ORCM) · ผู้ช่วยนับ 1 ตอน 15:46 (ถูกต้อง) · เภสัชรีเช็ค 1 ตอน 17:04 (ถูกต้อง) · ยืนยัน 17:08 → `soldQty=0` เพราะรายการขายไม่อยู่ในไฟล์ → `1+0=1 ≠ 2` → Stock Adjustment ทั้งที่ไม่มีของหาย
- **บทเรียน 1:** ตัวเช็ค "วันที่ R16 vs วันที่สแกน" เดิมจับไม่ได้ — วันตรงกัน ต่างแค่เวลา · เงื่อนไขยังหลวม (เหลื่อมกันวันเดียวก็ผ่าน) รอบนับที่กินหลายวันยิ่งผ่านง่าย → เพิ่มตัวเตือนระดับ**เวลา** (max TRANDATE vs เวลานับล่าสุด) + แสดงช่วงข้อมูลบนการ์ด
- **บทเรียน 2:** กระทบ**ทุก SKU ที่ขายหลังช่วงข้อมูลแล้วนับทีหลัง** ไม่ใช่ตัวเดียว — เอกสารปรับสต็อกทั้งไฟล์เชื่อไม่ได้ ต้องเช็คก่อนส่ง ERP
- **บทเรียน 3:** ไม่มีทางย้อน `stock_adjustment` กลับเป็น `audit` เลย ผู้ใช้แก้เองไม่ได้ต้องรอ dev — feature ที่ "ยืนยันแล้วจบ" ควรมีทางถอยตั้งแต่แรก (แก้แล้วด้วยปุ่ม ↺)
- ⚠️ `recheckSystemQty` freeze **ไม่ได้แก้เคสนี้** (`r01Version` ไม่ขยับทั้งวัน) — เป็นการกันคนละสถานการณ์ อย่าสับสน

**`getSoldQtyBefore` fallback ไม่กรองเวลา (กับดักข้ามเครื่อง):**
`if(!state.r16RawMap.size||!scanTimestamp)return state.r16SalesMap.get(sku)||0;` — เครื่องที่**รับ R16 ผ่าน cloud sync ไม่มี rawMap** (sync เฉพาะ salesMap/inboundMap) → fallback คืน**ยอดรวมทั้งก้อนไม่กรอง TRANDATE** ขณะที่เครื่องอัพไฟล์เองกรองตาม timestamp ได้ → การคำนวณ effectiveQty **ให้ผลต่างกันตามเครื่อง** สำหรับ item timestamp เก่า (เจอตอนออกแบบ recheck ข้าม baseline — กันด้วย `_isPreBaselineItem` guard ใน `getPharmacistAuditEffectiveQty`) — logic ใหม่ที่พึ่ง `getSoldQtyBefore/getInboundQtyBefore/getR16103QtyBefore` ต้องเช็คเคสเครื่องไม่มี rawMap เสมอ

WH Supervisor แก้ข้อจำกัดนี้แล้วด้วย R16 versioned chunks + meta; ข้อควรระวัง fallback ด้านบนยังมีผลกับสาขายา/legacy path ที่ไม่ได้โหลด raw timeline chunks.
