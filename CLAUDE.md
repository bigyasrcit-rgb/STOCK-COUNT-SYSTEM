# CLAUDE.md — Anin Stock Count

อ่าน `AGENTS.md` เป็นไฟล์แรกก่อนเริ่มงานทุกครั้ง แล้วจึงอ่านไฟล์นี้และ skill ที่เกี่ยวข้อง

Single-file PWA (`index.html`, ~6,600+ บรรทัดรวม HTML/CSS/JS) + Android WebView wrapper (`android-app/`).
No build system. No framework.

**Current baseline:** `30c57ca` (`Move pharmacy confirmation to desktop`) · APK `1.11` (`versionCode 12`, tag `v1.11`)
ระบบผ่าน technical verification เบื้องต้นแล้ว แต่ยังรอ User Acceptance Test (UAT) จากผู้ใช้งานจริง ห้ามเปลี่ยน business flow จากการคาดเดา

---

## ⚠️ กฎ 1 — ห้ามแก้ scan-related โดยไม่แจ้ง

ฟังก์ชัน / logic ต่อไปนี้ถือเป็น **scan-related** — ต้องอธิบาย change + impact ให้ user approve ก่อนทุกครั้ง:

`receiveBarcode`, `handleScanInput`, `handleScanKey`, `processScan`, `processPharmacistAuditScan`, `submitScanManual`,
`handleBarcode`, `parseScanLine`, `drainQueue`, `scanQueue`,
`evaluatePendingScans`, `_buildPendingScanEvaluation`, `validateAndProcess`, `_confirmPharmacyBatched`,
`appendScanRow`, `removeScanItem`, `resetRecheckItem`, `clearScanList`, `rebuildScanListMap`, `renderScanList`, `patchScanRow`,
`_applyCloudScanData`, `syncToFirestore` (scan data), `pullFromCloud`, `startScanSessionListener`, `restoreFromFirestore`,
`confirmScanGap`, `showScanGapModal` (dead code ก.ค. 2026 — gap 2 นาทีถูกถอด แต่ `_scanGapHold` ยังเป็น hold-guard ทุกจุด ห้ามลบ), `confirmNoStock` (flag `noStock` — ดู SKILL-scan-engine),
`showZeroSysModal`, `confirmZeroSys` (dead code ก.ค. 2026 — modal ถูกถอด แทนด้วย `_zeroSysFirstScan` แต่ `_zeroSysHold` ยังเป็น hold-guard ทุกจุด ห้ามลบ),
`handleAuditVerifyScan`, `confirmAuditVerifyItem`, `confirmAllAuditVerify`, `confirmRecheckBtn`, `confirmAllRecheckSupervisor`,
`_confirmWhCountItems`, `confirmCountByStaff`, `confirmRecheckByStaff`, WH Count/Recheck inbox + confirmation listeners,
branch confirm lock (`_acquireBranchConfirmLock`, `_releaseBranchConfirmLock`, lock listener และ scan guards),
`PDA_KEYSTROKE_THRESHOLD_MS`, `SCAN_DEBOUNCE_MS`, `_pdaMode`, `_lastKeystrokeTime`,
time gates ใน scan, role check ใน `rebuildScanListMap`

**เหตุผล:** scan เป็น critical path มี state + debounce + Firestore sync + listener ซ้อนกันหลายชั้น
debug บน PDA ยาก (ไม่มี native console) — cascade bug เคยเกิดแล้ว (June 2026, commit 58d9d2f→90f4bb8→6fefac9)

---

## ⚠️ กฎ 2 — Bump APK เฉพาะแก้ native Android

APK เป็นแค่ WebView wrapper — แก้ `index.html` → Vercel auto-deploy → PWA Service Worker push ให้ PDA เอง

**Bump versionCode + push tag `v*` เฉพาะเมื่อแก้:**
- `android-app/app/src/**` (Kotlin/Java)
- `android-app/app/src/main/AndroidManifest.xml`
- `android-app/app/build.gradle`
- `android-app/app/src/main/res/**`
- `.github/workflows/build-apk.yml`

**ไม่ bump เมื่อแก้:** `index.html`, `sw.js`, `libs/**`, docs (CLAUDE.md, README.md ฯลฯ)

**ขั้นตอน bump:**
1. bump `versionCode` (+1) และ `versionName` ใน `build.gradle`
2. sync `version.json` (versionCode, versionName, releaseNotes ภาษาไทย)
3. commit → `git tag v<X.Y>` → `git push origin main --tags`

**Current native policy (APK 1.11):** ใช้ `FLAG_KEEP_SCREEN_ON` เฉพาะช่วงใช้งานและปล่อยหลัง idle 2 นาที ห้ามนำ `SCREEN_BRIGHT_WAKE_LOCK`, `ON_AFTER_RELEASE` หรือ permission `WAKE_LOCK` กลับมา

---

## ⚠️ กฎ 3 — Cloud confirmation เป็น authoritative

- WH Supervisor ใช้ Cloud เป็น source of truth; localStorage เป็น cache เท่านั้น
- Precedence ต้องคงเป็น R01/R16 master → session base → Count marker → `WH_counts` → Recheck marker → `WH_rechecks`
- marker ใน `countResetAt` เดียวกันต้องชนะ session/PDA snapshot เก่า และ Recheck marker ต้องชนะ Count marker ที่ยังเป็น `audit`
- Count/Recheck Confirm ต้องอ่าน server ล่าสุดและเขียน marker + ลบ pending ใน Firestore transaction เดียว เปลี่ยน local state หลัง transaction สำเร็จเท่านั้น
- generic `audit` ที่ไม่มี `auditor` ห้ามทับ `pass`/`stock_adjustment` ที่ Supervisor ยืนยันแล้ว
- ห้าม simplify `_applyCloudScanData()`/`syncToFirestore()` หรือเปลี่ยน merge order โดยไม่ทดสอบ stale snapshot, delayed PDA write, offline และสอง Desktop พร้อมกัน
- Pharmacy Confirm ต้องทำบน Desktop ผ่าน branch lock + batch processing PDA ห้ามเรียก Confirm โดยตรง

---

## Architecture

```
AGENTS.md           ← entrypoint + ข้อห้าม/invariant/bug ledger สำหรับผู้ดูแลและ AI agent
CLAUDE.md           ← architecture + กฎ critical path (ไฟล์นี้)
index.html          ← runtime เว็บทั้งหมด (HTML + CSS + JS รวมไฟล์เดียว ~6,600+ บรรทัด)
sw.js               ← Service Worker (cache-first static, network-first HTML)
libs/
  papaparse.min.js  ← CSV parsing
  xlsx.full.min.js  ← Excel read/write
android-app/        ← WebView wrapper (Kotlin)
version.json        ← APK self-update manifest
firestore.rules     ← สำเนา rules; deploy จริงต้อง Publish ผ่าน Firebase Console
auto-r01/           ← R01 auto import สำหรับ SRC/KKL/SSS (Windows Task Scheduler)
api/ip.js           ← Vercel function สำหรับ login log IP
```

**Stack:** Vanilla JS/CSS, Firebase Firestore v10.12.0 (compat CDN), no bundler
**Hosting:** Vercel → `https://anin-stock-count.vercel.app/`
**Branches:** SRC, KKL, SSS (ร้านยา) + WH (คลังกลาง)

**Auto-refresh (July 2026):** `_updateHeartbeat` ใน DOMContentLoaded closure — HEAD เทียบ ETag ทุก 15 นาที + ตอนเปิดจอ → deploy ใหม่ = reload ไม่หลุด login (stash `_autoUpdate`); ข้ามวันหลัง 04:00 + idle 10 นาที = reload บังคับ login ใหม่ ทั้งสอง path flush save ก่อน (race 8s — ห้ามรอ syncToFirestore เพียวๆ offline จะค้างถาวร)
- **แก้ `sw.js` ต้อง bump `CACHE = 'stock-count-vN'`** ไม่งั้น cache เก่าไม่ purge
- URL ที่มี `_vchk=` ต้องผ่าน SW ตรงเสมอ (ห้าม cache) — guard อยู่ต้น fetch handler

### State Object (สรุป)

```js
state = {
  productMasterData, productMasterMap,   // Product catalog
  r01Data, r01Version,                   // Inventory qty + cloud master version (R01.102)
  r05Data,                               // Barcode mapping (R05.106)
  r16Data, r16SalesMap, r16RawMap,       // Sales during count (R16.104)
  r16InboundMap, r16InboundRawMap,       // Inbound during count (R16.104)
  r16DetailVersion,                      // active R16.104 generation/version
  r16DateMismatch,                       // true = R16 TRANDATE ไม่ overlap scan dates
  r16_103Map, r16_103RawMap,             // WH only: รับเข้ายังไม่ขึ้นชั้น (R16.103)
  r16_103DetailVersion,                  // active R16.103 generation/version
  skuMap,       // SKU → { productName, unitPrice, systemQty, barcodes[], isDel, isP }
  barcodeMap,   // barcode → SKU
  skuDirectMap, // SKU → { barcode, unitName }
  scanData,     // Map<SKU, { countedQty, status, timestamp, scannedBy, auditor,
                //             countAt, recheckQty, recheckBy, recheckAt,
                //             initialStatus, firstScanAt, noStock, ... }>
  unknownScans,
  locationMap,  // WH only: Map<SKU, string> e.g. "A1-01"
  zoneStaffMap  // WH only: Map<zone, staff> e.g. "A" → "มุก"
}
```

### กฎราคาและสิทธิ์กรอกจำนวน (ย้ายมาที่ R05.106 Col B — ก.ค. 2026)

**ราคาผูกกับ "บาร์โค้ด" ไม่ใช่ SKU** — อ่านจาก R05.106 คอลัมน์ B (ราคาต่อหน่วยของบาร์โค้ดนั้น) ผ่าน `_parseProductMasterPrice()` เดิม
เดิมใช้ ProductMaster คอลัมน์ J ต่อ SKU · **ProductMaster คอลัมน์ J ยังอ่านอยู่แต่ไม่ใช่ตัวตัดสินกฎราคาแล้ว** (`rebuildMaps` เขียนทับ `skuMap.unitPrice` ด้วยค่าจาก R05)

- **สแกน `barcode,qty`** ใช้ราคาของ**บาร์โค้ดที่ยิงจริง** (`_canEnterCountQtyPrice(scanPrice)` ใน `handleBarcode`) → บาร์โค้ดกล่องแพงถูกบล็อกได้ แม้บาร์โค้ดเม็ดของ SKU เดียวกันจะกรอกได้ · สแกน SKU ตรง (`skuDirectMap`) ใช้ราคาหน่วยเล็กสุด
- **ช่อง QTY ใน RESULT row / stock popup** ผูกกับรายการไม่ใช่บาร์โค้ด → ใช้ `skuMap.unitPrice` ที่ `_baseUnitPrice()` derive มาจาก **บาร์โค้ดตัวคูณต่ำสุด**; ตัวคูณเท่ากันหลายอันเลือกราคาสูงสุด และถ้ามีตัวใดไม่มีราคา → `null` (บังคับสแกนทีละชิ้น)
- `< 1000` เท่านั้นที่แสดงและยอมรับช่อง QTY แบบยอดรวมหน่วยย่อย (absolute); `>= 1000`, ค่าว่าง/อ่านไม่ได้, Unknown, หรือบาร์โค้ดที่ไม่มีใน R05 ต้องสแกนทีละชิ้น
- **DEL กรอกได้แล้วถ้าบาร์โค้ดมีราคา < 1000** (เปลี่ยนจากเดิมที่บล็อกทุกกรณี — `_canEnterCountQty` ไม่เช็ค `isDel` อีกต่อไป)
- กฎราคาต้องครอบทั้ง RESULT row, stock popup, `barcode,qty` และฟังก์ชันแก้จำนวน — **จุดที่ตัดสินใจว่า "แสดงช่อง input หรือไม่" (`renderScanList`, `patchScanRow`) ต้องใช้กฎเดียวกับจุดที่ตรวจ** ไม่งั้นช่องจะโผล่ให้พิมพ์แล้วค่อยเด้งปฏิเสธ; ห้ามนำ threshold จาก `systemQty` กลับมา
- กฎนี้ไม่ใช้กับ Audit/Recheck และไม่เปลี่ยน `unitMultiplier` ของการสแกน Barcode ปกติ
- **หลัง deploy ต้องอัปโหลด R05.106 ใหม่หนึ่งครั้ง** เพื่อเติม `unitPrice` ให้ `global_r05` (ไฟล์กลางใช้ร่วมทุกสาขา อัปครั้งเดียวจบ) — ก่อนอัป ทุกบาร์โค้ดจะไม่มีราคา = สแกนทีละชิ้นทั้งระบบ (fail-safe โดยตั้งใจ)
- `global_r05` แบกราคาต่อบาร์โค้ดเพิ่มและมีเพดาน 1 MiB เหมือน doc อื่น → toast ตอนอัปโหลดโชว์ขนาดจริงทุกครั้ง และเตือนเมื่อ ≥ 800 KB

`_countResetAt` — module-level ISO timestamp, reset epoch (monotonic). ใช้ `>` เปรียบเทียบ lexicographic
`_r01BaselineAt` — module-level ISO timestamp, อัพ R01 ล่าสุดบน**สาขายา**เท่านั้น (`_isPharmacyBranch()`) — ตัวตัดสิน `_isPreBaselineItem` (freeze audit/pass ที่นับก่อน baseline — audit อยู่รอดข้ามการอัพ R01 ให้เภสัชรีเช็ค) + trigger ล้าง R16 ข้ามเครื่อง ดู [[SKILL-data-files]] R01 Daily Baseline

WH R16 raw timeline เก็บ cache ใน IndexedDB (`stock-count-cache` / `r16Snapshots`) แต่ Cloud meta/chunks เป็น source of truth เครื่อง Supervisor ต้องโหลด generation ที่ตรงกับ R01 และ `countResetAt` ก่อน Confirm

### Status Lifecycle

```
pending → scanning → pass
                   → audit → (verify pass)  → pass
                           → (verify fail)  → stock_adjustment
                   → stock_adjustment  (สาขายา: negSys — ระบบติดลบ clamp เป็น 0, ข้ามเภสัช verify)
```

`unknown` = barcode ไม่พบในระบบ (parallel track)
`audit_check` = legacy, ยังอยู่ใน codebase แต่ไม่ถูกผลิตใหม่แล้ว
`negSys` = สาขายาเท่านั้น: systemQty < 0 ใน R01 → skuMap เก็บ 0 + flag (ดู SKILL-scan-engine)
สาขายา สแกนสินค้า `negSys || systemQty===0` **ครั้งแรก** = บันทึกนับ 0 (สแกนป้ายชั้น = เช็คแล้วไม่มีของ) ครั้งที่ 2+ บวกปกติ —
`zeroSysModal` ถูกถอด (ก.ค. 2026) เหลือเป็น dead code แต่ `_zeroSysHold` ยังเป็น hold-guard ทุกจุด ห้ามลบ · systemQty=0 ที่นับเจอของยังไป `audit` ให้เภสัชรีเช็คเสมอ
`noStock` = สาขายาเท่านั้น: ระบบมี stock แต่ผู้ช่วยยืนยันว่าไม่มีของจริง → Confirm เป็น `stock_adjustment` ตามกติกาปัจจุบัน

สูตร Confirm รอบแรกห้ามเปลี่ยนโดยพลการ:

```text
effectiveQty = countedQty + soldQty + r16103Qty - inboundQty
```

WH Recheck รอบสองเปรียบเทียบ `recheckQty` กับ `systemQty` จาก `WH_r01` ล่าสุดโดยตรง ไม่ใช้ local `skuMap` ที่อาจค้าง

### Roles & Branches

| Role | Branch | สิทธิ์หลัก |
|---|---|---|
| assistant | SRC/KKL/SSS | สแกนนับ |
| pharmacist | SRC/KKL/SSS | Audit Verify (scan + ยืนยัน) |
| supervisor | WH | ยืนยันนับ + ยืนยันรีเช็ค (Desktop only) |
| warehouse | WH | สแกนนับ + สแกนรีเช็ค (PDA) |

สาขายา (`SRC`/`KKL`/`SSS`) ใช้ Confirm รอบแรกบน Desktop เท่านั้น ปุ่มถูกซ่อนและ guard ด้วย User-Agent `StockCountPDA` โดยตรง ไม่อิง viewport
Audit Verify ของเภสัชก็เช่นกัน — สแกนรีเช็คบน PDA ได้ แต่ปุ่มยืนยันถูก disable และ guard ด้วย `_isPdaApp()`

### Firestore Workflow Documents (ปัจจุบัน)

| Document ใน `stock_sessions` | หน้าที่ |
|---|---|
| `{branch}` | session หลัก — `schemaVersion:2` = metadata อย่างเดียว (ไม่มี `scanData`/`scanListMap`) |
| `{branch}/items/{sku}` | **schema v2:** 1 document ต่อ SKU ต่อรอบนับ (subcollection) |
| `{branch}_r01` | R01 master/version + R16 upload metadata |
| `global_pm`, `global_r05` | shared Product/Barcode master |
| `WH_counts`, `WH_count_confirmations` | Count inbox + authoritative confirmation markers |
| `WH_rechecks`, `WH_recheck_confirmations` | Recheck inbox + authoritative confirmation markers |
| `WH_r16_104_meta`, `WH_r16_103_meta` | active timeline generation/version |
| `WH_r16_{kind}_{generation}_{index}` | R16 chunk เป้าหมายไม่เกินประมาณ 650 KB |
| `{branch}_confirm_lock` | Pharmacy Desktop Confirm lock (SRC/KKL/SSS) |
| `{branch}_pharmacy_audit_markers` | authoritative Pharmacy Audit worklist/final result (SRC/KKL/SSS) |
| `WH_location` | location + zone/staff mapping |

### Scan data schema v2 (ก.ค. 2026) — 1 document ต่อ SKU

เดิม `scanData` ทั้งชุดถูก serialize ลง `session_data_json` ก้อนเดียว ทำให้ชนเพดาน 1 MiB ของ Firestore
เมื่อนับครบทั้งสาขา (~5,400 SKU × ~305 B ≈ 1.6 MB) และบังคับให้ต้องเขียน merge เองทุกกรณี

- `_schemaVersion===2` (อ่านจาก field `schemaVersion` ใน session doc) = สาขานี้ cutover แล้ว ค่าอื่น = เดิน blob path เดิมทั้งหมด
- **rollback = ตั้ง `schemaVersion` กลับเป็น 1 พร้อมคืน blob จาก `{branch}_v1_backup`** โค้ด blob เดิมยังอยู่ครบ ห้ามลบจนกว่าจะผ่านรอบนับจริงอย่างน้อย 2 รอบ
  หลัง Publish schema guard แล้ว Browser/PDA ทำ rollback เองไม่ได้: ต้องหยุด client ทุกเครื่องและใช้สิทธิ์ผู้ดูแล หรือผ่อน Rules ชั่วคราวใน maintenance window แล้ว Publish guard กลับทันที
- cutover ทำได้ 2 ทาง: `startNewCount()` (ตอน `scanData` ว่าง) หรือ `migrateSessionToSchemaV2()` (ระหว่างรอบนับ) — **ห้าม dual-write blob+items**
- **SRC และ WH cutover เป็น v2 แล้ว (24 ก.ค. 2026)** ด้วย live migration · KKL/SSS ยังเป็น v1 จะ cutover ตอน `startNewCount()` ครั้งถัดไป
- ระหว่าง migrate ต้องหยุดสแกนสาขานั้น — เครื่องที่ยังเป็น v1 เขียน session doc ด้วย `ref.set()` แบบไม่ merge
  ถ้าเขียนหลัง cutover จะลบ field `schemaVersion` ทิ้งแล้วทุกเครื่องหลุดกลับ v1 พร้อมกัน
- ไม่เขียน doc สำหรับ `pending` — ไม่มี doc = `pending` (ตรงกับพฤติกรรม cloud เดิมที่ merge rule กัน pending ไม่ให้ขึ้น)
- เขียนผ่าน dirty queue: `_markSkuDirty(sku)` → `_flushDirtySkus()` debounce 800 ms → `writeBatch` 450 ops/ชุด
- `scanning` เขียนด้วย `runTransaction` ต่อ item + **delta** (`countedQty` ปัจจุบัน ลบค่าที่ sync แล้วใน `_scanItemSynced`)
  ห้ามกลับไปใช้ "เลือก `countedQty` ที่สูงกว่า" — สอง PDA สแกน SKU เดียวกันจะทำยอดหาย
- `_writeScanningItem()` ต้อง freeze `startQty`/payload ก่อน `await transaction`; หลัง commit ให้บวกเฉพาะ scan ที่เกิดระหว่างรอเข้ากับยอด commit
  และตั้ง `_scanItemSynced` จาก payload ที่ commit จริงเท่านั้น — ห้ามนำผล transaction เก่าทับ local ล่าสุด (เคยทำให้ WH เด้ง 13→11, 15→13)
- WH PDA scan queue ใช้ `scheduleStatsAfterScan()` รวม full stats refresh หลังหยุดยิง 1 วินาที; scan row/qty และ Cloud sync ต้องยังทำทันที
  ห้ามกลับไปเรียก `updateStats()`/`scheduleStats()` ทุก scan เพราะหนึ่ง refresh กวาด catalog หลายรอบและทำให้ PDA หน่วง
- `manualEditAt` สด = เขียนทับตรงๆ (absolute) ไม่ใช่ delta — ผู้ใช้สั่ง "ให้เป็นเลขนี้"
- listener ข้าม `snapshot.metadata.hasPendingWrites` และข้าม SKU ที่อยู่ใน `_dirtySkus`/`_scanItemInFlight`
  **ห้ามลบ guard นี้** — echo ของ write ตัวก่อนจะดึงยอดกลับไปค่าเก่าหลังผู้ใช้สแกนเพิ่ม
- `_scanItemToLocal()` ต้องคง `scans`/`retries`/`manualEditAt` ของเครื่องเดิมไว้ — `scans` ถูกอ่านโดย `_zeroSysFirstScan`
  ถ้าล้างทิ้ง สินค้า `negSys`/`systemQty===0` จะถูกมองว่า "สแกนครั้งแรก" ซ้ำแล้วบันทึก 0 อีกรอบ
- `_reconcileScanItems()` (ทุก 60 วิ + ก่อน sync metadata) เป็น safety net หา SKU ที่ mutation site ลืม mark
- Confirm อ่านเฉพาะ status ที่ต้องใช้ (`scanning` / `audit`) และตรวจ "เปลี่ยนกลางงาน" ด้วย `rev`
- **`firestore.rules` ต้องแยก parent `stock_sessions/{document}` ออกจาก `stock_sessions/{branch}/items/{sku}`**
  และห้ามมี recursive broad allow `{document=**}` ซ้อนอยู่ เพราะ allow ใช้แบบ OR แล้วจะข้าม schema guard
  - parent ที่ยังเป็น v1 อัปเดตและ cutover เป็น v2 ได้ตามเดิม
  - เมื่อค่าเดิม `schemaVersion>=2`, ค่าใหม่ต้องเป็นตัวเลขและห้ามต่ำลง; v1 `ref.set()` ที่ทำ field หายจึงถูกปฏิเสธ
  - delete parent ยังอนุญาตเพื่อคง `clearAllData()`; Rules นี้เป็น data-integrity guard ไม่ใช่ authentication/security เต็มรูปแบบ
  ต้อง copy Rules ไป Publish ใน Firebase Console ด้วย — แก้ไฟล์ใน Git อย่างเดียวไม่มีผลกับระบบจริง
- composite index `countResetAt` + `status` ต้องสร้างใน Console ก่อน cutover

Stage 0 safety net (blob path): `_checkSessionBlobSize()` เตือนที่ 800 KB — **เตือนอย่างเดียว ห้าม block การเขียน**
ถ้า block เอง จะทำให้ payload ที่ Firestore ยังรับได้เขียนไม่ผ่าน = regression กับรอบนับที่กำลังทำอยู่ และทำให้ branch lock ค้าง
ปล่อยให้ Firestore ตัดสิน แล้ว `_reportSyncError()` แยกกรณี "เอกสารใหญ่เกิน" ออกมารายงานให้ชัดแทนการ throw เงียบ

**Live migration (ก.ค. 2026):** `migrateSessionToSchemaV2()` / `rollbackSessionToSchemaV1()` เรียกจาก Console บน Desktop
ใช้เมื่อ session doc ใกล้เพดานระหว่างรอบนับจนรอ cutover ที่ `startNewCount()` ไม่ได้ — ย้ายโดยไม่ทิ้งของที่นับไว้
ลำดับห้ามสลับ: อ่าน server → สำรองลง `{branch}_v1_backup` → เขียน items ครบ → **อ่านกลับมานับให้ครบ** → ค่อยเขียน session doc เป็น metadata-only
ถ้าล้มก่อนขั้นสุดท้าย ระบบยังเป็น v1 เต็มรูปแบบ รันซ้ำได้ · `{dryRun:true}` ตรวจได้โดยไม่เขียน

#### ⏳ schema v2 — สิ่งที่ยังค้าง (อ่านก่อนทำงานต่อกับ scan/sync)

Schema v2 deploy จริงครั้งแรก 24 ก.ค. 2026 (commit `6ccdf69`) **ยังไม่ผ่าน field test ครบ** — งานที่ค้างเรียงตามความสำคัญ:

1. **3 เคสเสี่ยงผ่าน automated test แล้ว (ก.ค. 2026) แต่ยังไม่ผ่านสนามจริง** — ผ่าน emulator ไม่ได้แปลว่าผ่าน PDA จริง (Intent scanner, จังหวะ keystroke, เน็ตสาขา):
   - **สอง PDA สแกน SKU เดียวกันพร้อมกัน → ยอดต้องรวม ไม่ใช่ทับ** (จุดเสี่ยงสูงสุด — `_writeScanningItem` delta/transaction) · `tests/specs/e2e/concurrent-scan.spec.js`
   - Confirm รอบแรก + Audit Verify บน v2 (query `scanning`/`audit` + `rev` check + `writeBatch`) · `confirm-count.spec.js`, `audit-verify.spec.js`
   - offline PDA สแกนค้างแล้วกลับ online → `_reconcileScanItems` push ครบ ไม่ทับของเครื่องอื่น · `offline-reconcile.spec.js`
2. **composite index `countResetAt` + `status`** — ยังไม่ยืนยันว่าสร้างใน Console แล้ว ถ้า Confirm error พร้อมลิงก์สร้าง index = ยังไม่มี ให้กดลิงก์สร้าง · **automated test จับเคสนี้ไม่ได้** เพราะ emulator ไม่บังคับ index
3. **KKL/SSS ยังเป็น v1** — จะ cutover เองตอน `startNewCount()` ครั้งถัดไป (ไม่ต้อง migrate เพราะ session เล็ก ~1 KB)
4. **blob ก้อนอื่นยังไม่ย้าย (Stage 1b)** — `WH_counts`, `WH_rechecks`, `WH_count_confirmations`, `WH_recheck_confirmations`, `{branch}_pharmacy_audit_markers` ยังเป็น `items:{}` map ก้อนเดียว มีเพดาน 1 MiB เดียวกัน ปัจจุบันเล็ก (`WH_recheck_confirmations` ~46 KB สูงสุด) ยังไม่เร่งด่วนแต่ต้องเฝ้า
5. **Confirm ยังคำนวณฝั่ง client → กฎ Desktop-only ยังอยู่ (Stage 2)** — ปลดได้เมื่อย้ายสูตร `effectiveQty` ไป Cloud Function
6. **มี automated test แล้ว (`tests/`) แต่ไม่แทนการทดสอบมือ** — ดู §Automated Tests ด้านล่าง; PDA จริง, composite index และ WH inbox flow ยังไม่ครอบ
7. **เก็บกวาดหลังเสถียร:** เมื่อผ่านรอบนับจริง ≥2 รอบ ค่อยลบ blob path เดิม (`_applyCloudScanData` merge guard, blob branch ใน `syncToFirestore`/`restoreFromFirestore`) และลบ `{branch}_v1_backup` — **ห้ามลบก่อนหน้านั้น** เพราะ rollback พึ่งพาอยู่

`{branch}_v1_backup` = สำเนา blob ก่อน migrate (SRC/WH) เก็บไว้จน confirm ว่า v2 เสถียร

**ทุก reader ที่อ่าน `scanData` จาก session blob ต้องมี v2 branch ที่อ่านจาก items แทน** — จุดที่มีแล้ว: `syncToFirestore`, `_applyCloudScanData`/listener, `restoreFromFirestore`, `pullFromCloud`, `_removeSkuFromFirestore`, `_readBranchConfirmCloudState`, **`buildDashboardData`** (Dashboard ข้ามสาขา — เคยลืม ทำให้ SRC/WH ขึ้น 0 ขณะ SSS v1 ปกติ, แก้ ก.ค. 2026 ให้ดึง items เมื่อ `schemaVersion===2`) · ถ้าเพิ่ม reader ใหม่ที่ parse `session_data_json.scanData` ต้องเติม v2 path ด้วยเสมอ
- Dashboard ของ schema v2 ต้อง query `items` ด้วย `countResetAt` ของ session ปัจจุบันและอ่านจาก server โดยตรง ห้ามอ่านทั้ง subcollection แบบไม่กรอง epoch; ถ้าอ่าน session/items ล้มเหลวต้องแสดง error ไม่ย้อนใช้ metadata-only blob แล้วแสดงยอด 0/ยอดบางส่วน
- Dashboard จำกัด `stock_audit_log` ย้อนหลัง 60 วันด้วยช่วง documentId (`{branch}_{YYYY-MM-DD}` → sentinel `{branch}_9999-99-99`) และมี cooldown 60 วิ (`DASH_REFRESH_COOLDOWN_MS` — ภายใน cooldown แสดงข้อมูลเดิม ไม่ยิง server) — ห้ามกลับไป `where('branch','==',b)` ทั้ง collection เพราะอ่านทุกวันสะสมไม่จำกัดและเป็นสาเหตุ read quota เต็ม (ก.ค. 2026)
- การกู้รายการที่ขาดจาก local backup ให้ใช้ `tools/recover-src-local-backup.js`: ตรวจ SHA-256 + branch + `countResetAt`, บังคับ dry-run, ดาวน์โหลดสำรอง session/items จาก Cloud ก่อนเขียน และใช้ transaction เขียนเฉพาะ SKU ที่ไม่มี document อยู่ในทุก epoch เท่านั้น ห้าม overwrite item เดิมทุกกรณี
- ถ้า `schemaVersion` ของ session หายแต่ items รอบปัจจุบันครบแล้ว ห้าม migrate/recover ซ้ำ: ใช้ `repairSrcSchemaVersion()` ตรวจจำนวน+status+hash, สำรอง Cloud แล้ว transaction merge เฉพาะ `{schemaVersion:2}`; `session_data_json` และ items ต้อง hash เท่าเดิมหลังซ่อม
- ก่อน schema-only repair ต้องพัก background sync/listener ของหน้า v1, ตั้ง local `_schemaVersion=2`, รอ `waitForPendingWrites()` และตรวจ server ซ้ำก่อน transaction มิฉะนั้น `syncToFirestore()` v1 ที่ตั้งเวลาไว้จะ `set()` session ทั้ง document แล้วลบ field `schemaVersion` ที่เพิ่ง merge; หลังซ่อมให้คงหน้านั้นในโหมดพักจนรีโหลด

### Pharmacy Desktop Confirm

- `_confirmPharmacyBatched()` ต้องออนไลน์และ acquire `{branch}_confirm_lock` ก่อนเริ่ม
- lock เก็บ token/owner/`countResetAt`/เวลาเริ่ม/หมดอายุ 5 นาที และปลดด้วย token เจ้าของเท่านั้น
- PDA ออนไลน์ฟัง lock แล้วบล็อก Intent barcode, queue, input และการแก้จำนวนชั่วคราว
- Desktop รอ PDA sync แล้ว snapshot เฉพาะ `scanning`; คำนวณ batch ละ 25 ผ่าน event loop พร้อม progress
- ก่อน apply อ่าน server ซ้ำและตรวจ `countResetAt`, R01/R16 version, `countedQty`, `timestamp`, `scannedBy`; เปลี่ยนกลางงาน = abort ทั้งชุด
- ถ้า cloud sync หลัง apply ล้มเหลว ผล local ยังคงอยู่และ lock อยู่จน retry สำเร็จหรือ TTL หมด เพื่อกันกดซ้ำ
- รายการที่คำนวณเป็น Audit ต้องเขียน `{branch}_pharmacy_audit_markers` ก่อน apply local; marker ใน epoch เดียวกันชนะ session/local ที่ stale และซ่อม SKU ที่หายกลับเข้า session
- `syncToFirestore(true)` สงวนไว้สำหรับ `startNewCount()` เท่านั้น; login stale reset และออก Admin Mode ต้อง merge

### Pharmacy Audit Verify (ก.ค. 2026)

- เภสัชสแกนรีเช็คบน PDA ได้ แต่กด "✓ ยืนยัน Audit" ได้เฉพาะ Desktop — guard ด้วย `_isPdaApp()` (User-Agent) ไม่อิง viewport
- ยอดที่สแกนเก็บใน `sd.recheckQty`/`recheckBy`/`recheckAt` (sync ผ่าน session doc) ห้ามกลับไปใช้ map ใน memory ที่ไม่ persist
- เภสัชแก้จำนวนรีเช็คในแถว RESULT ได้ทั้ง PDA + Desktop ผ่าน `updatePharmacyRecheckQty()` (ก.ค. 2026) — เขียนทับแบบ SET + ตั้ง `manualEditAt` + `_markSkuDirty` เหมือนเส้นทางสแกน ห้ามเรียก inbox `WH_rechecks`; ขั้นต่ำ 1 — ยอด 0 ไม่รองรับตามกติกา pending>0 (ให้ใช้ ✕ รีเซ็ตรีเช็คแทน) และไม่ใช้กฎราคากับช่องนี้ (กฎราคาครอบเฉพาะ Count รอบแรก)
- `getPharmacistAuditPendingMap()` ต้องอ่านจาก `state.scanData` เท่านั้น — `scanListMap.totalQty` เป็น countedQty รอบแรกในสาขายา ใช้ตัดสินไม่ได้
- `_confirmPharmacyAuditBatched()` ใช้ branch lock / แบตช์ 25 / ตรวจ R01+R16 version ชุดเดียวกับ Confirm รอบแรก และ abort ทั้งชุดถ้า `recheckQty`/`recheckBy`/`recheckAt` เปลี่ยนกลางงาน
- ก่อน apply Verify ต้องเขียน final marker; ยืนยันทีละชุดจึงเปลี่ยนเฉพาะ SKU ที่มี `recheckQty` และ Audit ที่เหลือยังอยู่ใน marker
- ทุก pharmacy client ฟัง marker และ overlay หลัง session snapshot; rollout ครั้งแรก backfill จาก Audit Log ตาม `countResetAt` เพื่อกู้รายการที่ session รุ่นเก่าทำหาย
- candidate = `status==='audit'` + มี `recheckQty` + ยังไม่มี `auditor`; audit ที่ยังไม่ได้สแกนคงสถานะเดิมรอรอบถัดไป
- เหตุผลที่ต้องเป็น Desktop: `getSoldQtyBefore()`/`getInboundQtyBefore()` fallback เป็นยอดรวมทั้งช่วงถ้าเครื่องไม่มี R16 raw timeline (`r16RawMap`) → PDA ตัดสิน pass/stock_adjustment ผิดได้
- เครื่องที่กำลังสแกน/กด ✕ เอง ต้องไม่ถูก cloud snapshot เก่า mirror ทับ — ใช้ `manualEditAt` + `MANUAL_EDIT_PROTECT_MS` ทั้งใน `_applyCloudScanData()` และ merge ของ `syncToFirestore()`

### WH Count/Recheck

- WH R01/R16 master และ raw timeline ถูก sync ผ่าน Firestore เพื่อให้ Supervisor หลายเครื่องเห็นข้อมูลชุดเดียวกัน; localStorage/IndexedDB เป็น cache ที่ต้อง version ตรงเท่านั้น
- ปุ่ม R01.102 แสดงเวลาอัปโหลดล่าสุดจาก Cloud เพื่อให้เครื่องอื่นรู้ว่า master ถูกอัปแล้ว
- warehouse PDA เขียน live Count ไป `WH_counts` และ live Recheck ไป `WH_rechecks`
- Supervisor Confirm รายคน/ทั้งหมดผ่าน transaction; pending ของคนอื่นห้ามถูกแตะในการ Confirm รายคน
- Supervisor ไม่รีเช็คเอง — ป็อปอัพ Audit Verify เป็น read-only (`_isWhSupervisorAuditReadonly()`) ซ่อนช่องสแกน และปุ่มยืนยันในป็อปอัพต้อง dispatch ไป `confirmAllRecheckSupervisor()` (transaction) ห้ามยืนยันแบบ local ล้วน
- Count marker `audit` เปิดงาน Recheck โดยเริ่ม `recheckQty` ว่าง/0 ตาม UI; warehouse สแกนแล้ว status ยังเป็น `audit` จน Supervisor Confirm รอบสอง
- listener ทั้ง Supervisor/PDA ต้อง apply marker ก่อน inbox เก่า และ backfill/write ต้องข้าม SKU ที่มี marker ใน epoch เดียวกัน
- เริ่มนับใหม่/ล้างข้อมูลต้องล้าง inbox, markers, WH R16 meta/chunks และ cache ของรอบเก่า

### PDA power/audio/toast policy

- Native Android ใช้ screen-on idle timer 2 นาที ไม่ใช้ bright WakeLock และไม่ปลุกจอเองหลังดับ
- Web Audio บน PDA suspend หลังเสียงจบประมาณ 1.5 วินาทีและ resume ก่อนเสียงถัดไป เสียงสแกนและเสียงกรอกจำนวนต้องคงอยู่
- `body.pda-power-save` ปิดเฉพาะ decorative animation ห้ามลด Firestore realtime listeners เพื่อประหยัดแบต
- Toast บน PDA ย่อผ่าน `_toastMessageForDevice()`; Desktop ใช้ข้อความเต็ม และ action toast ต้องใช้ callback/`textContent` ไม่ประกอบ input ด้วย unsafe `innerHTML`

### Known limitations / rollout assumptions

- PDA ที่ออฟไลน์รับ branch lock ไม่ได้ทันที รายการใหม่จะ sync ภายหลังและรอ Confirm รอบถัดไป
- Pharmacy Desktop ต้องออนไลน์ระหว่าง Confirm และระหว่างยืนยัน Audit Verify
- เภสัชที่สแกนรีเช็คบน PDA ออฟไลน์ ยอดจะขึ้น Cloud ตอนกลับมาออนไลน์ Desktop จึงจะยืนยันได้
- Audit Verify บางเส้นทางยังไม่รองรับ pending quantity 0 เพราะ pending map กรอง `> 0` ห้ามแก้โดยไม่มี business rule ที่อนุมัติ
- Firestore rules ปัจจุบันเปิด read/write ให้ collections ที่แอปใช้ การ tighten rules เป็น security/migration แยกและต้องทดสอบทุก client
- สาขายาที่รับ R16 ผ่าน legacy session sync อาจมีเฉพาะ aggregate maps ไม่มี raw TRANDATE timeline; ห้ามสมมติว่าป้ายวันที่ R16 ตรงกันแล้ว derived result ทุกเครื่องจะตรงโดยอัตโนมัติ
- **Firestore quota (ก.ค. 2026):** Spark 50K reads/วันเคยเต็มช่วงรอบนับ (ประเมิน ~178K reads/วันนับทั้งระบบ) — ทางแก้หลักคืออยู่บนแผน Blaze (โควต้าฟรีรายวันยังได้เท่าเดิม + budget alert) จุดกิน read ใหญ่ที่ยังไม่แก้และเป็น backlog (ทุกข้อแตะ scan-related ต้องขอ approve กฎ 1 + field test): login สาขา v2 อ่าน items ซ้ำ 2 รอบ (`_loadScanItemsFromCloud` + listener initial ≈ 2×N/reload), ไม่ได้เปิด Firestore offline persistence, Pharmacy Confirm อ่าน server 3 รอบ (integrity check — ห้ามลดโดยพลการ), `WH_counts` เขียนทุกสแกนไม่ debounce (echo 1 read/สแกนไป Supervisor) · `startNewCount` สาขา v2 กิน ~N deletes + ~N reads ต่อครั้ง อย่ารันสองสาขาวันเดียวกันบน Spark

---

## Running the App

```bash
npx serve .
# or
python -m http.server 8080
```

ไม่มี build step — เปิด `index.html` ใน browser ได้เลย

---

## Automated Tests (`tests/` — ก.ค. 2026)

Playwright + Firestore Emulator **แยกขาดจาก production 100%** รันได้แม้ขณะพนักงานกำลังสแกน (ไม่แตะข้อมูลจริง ไม่กินโควต้า) — รายละเอียดเต็มใน `tests/README.md`

```powershell
cd tests
npm install && npm run setup && npm run preflight   # ครั้งแรกเท่านั้น (ต้องมี Java 11+ สำหรับ emulator)
npm run test:logic   # ~7 วิ ไม่ใช้ emulator — inner loop ตอนแก้สูตร/merge
npm test             # ทั้งหมด (logic + e2e ผ่าน emulator)
```

**ห้ามพังหลักการเหล่านี้เวลาเพิ่ม/แก้เทส:**
- **ห้ามแก้ไฟล์ production เพื่อให้เทสผ่าน** — redirect ไป emulator ทำโดย inject script ตอนเสิร์ฟ (`tests/lib/static-server.mjs` + `routes.js`) `index.html` ต้องไม่มีโค้ดรู้จักเทสเลย
- inject ต้องทำที่ static server **ไม่ใช่ `route.fulfill`** — document ที่ fulfill ผ่าน Playwright เสีย address space แล้ว Chromium บล็อก fetch ข้ามพอร์ตไป emulator (ERR_FAILED)
- ทุกเทสปิดด้วย `closeApp()` ซึ่ง assert ว่าไม่มี request ออกนอก `127.0.0.1` — ถ้าลบ assert นี้ isolation หายทันที
- ห้าม sleep: ใช้ `waitForFunction(..., {polling:100})` + `waitForDoc()` · บังคับ flush ด้วย `_flushDirtySkus()` · offline ต้องปลด `_scanItemBackoffUntil` ก่อน flush
- fixture ต้องสังเคราะห์เท่านั้น (`tests/lib/fixtures.js`) — ห้ามนำ CSV ข้อมูลจริงเข้า repo (root `.gitignore` กัน `*.csv` ไว้แล้ว)

**เทสแทนการทดสอบมือไม่ได้ในเรื่องเหล่านี้:** PDA จริง (Intent scanner/keystroke/WebView/เสียง/APK), composite index บน production (emulator ไม่บังคับ), KKL/SSS v1 blob path เต็มรูปแบบ, WH Count/Recheck inbox flow

---

## Skills (โหลดเมื่อ task เกี่ยวข้อง)

- **Scan Engine:** `.claude/skills/SKILL-scan-engine.md`
  → PDA detection, debounce, scan formats, drainQueue/patchScanRow, role filter, Firestore sync, cloud sync rules

- **Data Files:** `.claude/skills/SKILL-data-files.md`
  → R01/R05/R16.104/R16.103 columns, OTFI direction, DEL/P items, exports, persistence layers

## เมื่องานเสร็จ
หลังทำ feature หรือ fix bug เสร็จ ให้ propose การอัพเดท CLAUDE.md
หรือ SKILL file ที่เกี่ยวข้อง โดยเพิ่มเฉพาะ context ที่ถ้าไม่มีแล้วจะทำผิดพลาด
ถ้าเป็น invariant, ข้อห้าม, deployment rule หรือ bug regression สำคัญ ให้ update `AGENTS.md` ด้วย

ก่อนส่งงานอย่างน้อยต้องตรวจ inline JavaScript syntax (ถ้าแก้ `index.html`), `git diff --check`, regression ของ branch/role ที่แชร์ฟังก์ชัน และ `git status --short` ว่าไม่มีไฟล์ unrelated ถูกแก้หรือ stage

---

## คู่มือผู้ใช้

| ไฟล์ | กลุ่มเป้าหมาย |
|---|---|
| `คู่มือการใช้งาน.html` | ทุก role |
| `คู่มือ-สาขา.html` | assistant + pharmacist (SRC/KKL/SSS) |
| `คู่มือ-คลัง.html` | warehouse + supervisor (WH) |

ไฟล์คู่มือเป็น standalone HTML — แก้ได้อิสระ ไม่กระทบ `index.html` ไม่ต้อง bump APK
