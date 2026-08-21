# AGENTS.md — คู่มือดูแล Anin Stock Count

เอกสารนี้เป็นจุดเริ่มต้นสำหรับผู้พัฒนาและ AI agent ที่เข้ามาทำงานใน repository นี้
ระบบผ่านการตรวจสอบเชิงเทคนิคเบื้องต้นแล้วและทำงานเป็นที่น่าพอใจ แต่ยังอยู่ระหว่างให้ผู้ใช้งานจริงทำ User Acceptance Test (UAT)
ดังนั้นอย่าเปลี่ยนพฤติกรรมงานนับสินค้าโดยอาศัยการคาดเดา หากพบอาการใหม่ให้เก็บหลักฐานและวิเคราะห์ flow ก่อนแก้

## 1. สิ่งที่ต้องอ่านก่อนเริ่มงาน

1. อ่าน `CLAUDE.md` ทุกครั้งก่อนแก้โค้ด
2. ถ้างานเกี่ยวกับการสแกน, PDA, Firestore sync, role filter, Count/Recheck หรือ Confirm ให้อ่าน `.claude/skills/SKILL-scan-engine.md` ทั้งไฟล์
3. ถ้างานเกี่ยวกับ R01/R05/R16, CSV/Excel, TRANDATE, DEL/P หรือ export ให้อ่าน `.claude/skills/SKILL-data-files.md` ทั้งไฟล์
4. ตรวจ `git status --short`, branch ปัจจุบัน และ commit ล่าสุดก่อนแก้ ห้ามถือว่า working tree สะอาด
5. อ่านโค้ดจริงและประวัติ commit ที่เกี่ยวข้องก่อนสรุปสาเหตุ ห้ามอาศัยชื่อฟังก์ชันหรือเอกสารเพียงอย่างเดียว

### งานค้างที่ต้องรู้ก่อนแตะของที่เกี่ยวข้อง

- **`auto-r01/` ยังห้ามเปิดใช้** — สคริปต์เสร็จแล้วแต่ไม่เคยเปิด และมีบั๊ก latent 4 ข้อที่จะทำให้ Confirm พังทุกวัน (เขียนทับ document ลบ R16 meta, ไม่เขียน `r01Version`/`r01BaselineAt`, เครื่องที่ login ค้างไม่โหลด R01 ใหม่) → **อ่าน `auto-r01/TODO-safe-enable.md` ก่อนแก้หรือเปิด Task Scheduler**
  แก้สคริปต์ + ทดสอบต้องทำที่เครื่อง `BigYa-spare` (ไฟล์ CSV จริง + Task Scheduler อยู่ที่นั่น) ส่วน `index.html` ทำที่เครื่องไหนก็ได้

## 2. โครงสร้างระบบ

โปรแกรมหลักเป็น single-file PWA ไม่มี framework และไม่มี build step สำหรับเว็บ

| Path | หน้าที่ | ข้อควรระวัง |
|---|---|---|
| `index.html` | HTML, CSS และ JavaScript ของระบบเกือบทั้งหมด | เป็น critical path; การแก้จุดเดียวอาจกระทบทุก branch/role |
| `sw.js` | Service Worker: network-first สำหรับ HTML และ cache-first สำหรับ static assets | ถ้าแก้ต้อง bump `CACHE`; `_vchk=` ต้องผ่าน network เสมอ |
| `manifest.json`, icons, fonts | PWA metadata และ assets | แก้เฉพาะเมื่อคำขอเกี่ยวข้องโดยตรง |
| `libs/` | PapaParse และ SheetJS แบบ vendored | ห้ามแก้ source โดยพลการ |
| `android-app/` | Android WebView wrapper สำหรับ PDA (`StockCountPDA` User-Agent) | แก้ native แล้วต้องออก APK version ใหม่ |
| `version.json` | manifest สำหรับ APK self-update | ต้องตรงกับ `android-app/app/build.gradle` |
| `firestore.rules` | สำเนา rules เพื่อ track ใน Git | แก้ไฟล์นี้ไม่ใช่การ deploy; ต้อง Publish ใน Firebase Console |
| `auto-r01/` | import R01 ของ SRC/KKL/SSS อัตโนมัติ | ทดสอบด้วย `--dry-run` ก่อนเขียน Firestore จริง |
| `คู่มือการใช้งาน.html` | คู่มือรวมทุก role | เป็น standalone HTML |
| `คู่มือ-สาขา.html` | คู่มือ assistant/pharmacist | ไม่กระทบ runtime หลัก |
| `คู่มือ-คลัง.html` | คู่มือ warehouse/supervisor | ไม่กระทบ runtime หลัก |
| `api/ip.js` | อ่าน IP สำหรับ login log บน Vercel | อย่าเปลี่ยน contract โดยไม่ตรวจ caller |

Hosting ปัจจุบันใช้ Vercel และ Firestore compat SDK จาก CDN เว็บที่แก้ใน `index.html` deploy ได้โดยไม่ต้องออก APK ใหม่

## 3. Branch, role และ lifecycle

| Branch | Role | งานหลัก |
|---|---|---|
| `SRC`, `KKL`, `SSS` | `assistant` | สแกนนับสินค้าด้วย PDA |
| `SRC`, `KKL`, `SSS` | `pharmacist` | Audit Verify |
| `WH` | `warehouse` | สแกนนับและสแกน Recheck ด้วย PDA |
| `WH` | `supervisor` | Confirm Count และ Confirm Recheck บน Desktop |

Status lifecycle หลัก:

```text
pending → scanning → pass
                   → audit → pass / stock_adjustment หลัง Verify
                   → stock_adjustment ในกติกาที่ข้าม Audit
```

- `unknown` เป็นเส้นทางคู่ขนานสำหรับ barcode ที่ไม่พบ
- `audit_check` เป็น legacy status ยังต้องรองรับ แต่ระบบไม่ควรสร้างรายการใหม่ด้วย status นี้
- สาขายาใช้ Confirm รอบแรกบน Desktop เท่านั้น PDA ที่มี User-Agent `StockCountPDA` ต้องไม่เห็นและเรียก Confirm ไม่ได้
- สาขายา Audit Verify: เภสัชสแกนรีเช็คบน PDA ได้ แต่การกดยืนยัน (ตัดสิน pass/stock_adjustment) เป็น Desktop-only เช่นกัน
- ยอดที่เภสัชสแกนรีเช็คต้องเก็บใน `state.scanData[sku].recheckQty/recheckBy/recheckAt` เท่านั้น ห้ามกลับไปใช้ map ใน memory ที่ไม่ sync
- **`recheckQty` ต้องเทียบกับ `recheckSystemQty` (ยอดระบบที่ freeze ตอนสแกน) เสมอ ห้ามใช้ `si.systemQty` สด** — `si.systemQty` ขยับทุกครั้งที่อัพ R01 ถ้าเทียบข้ามช่วงเวลาจะได้ Stock Adjustment ผิด · ทุกจุดที่ตั้ง `recheckQty` ต้องเรียก `_freezeRecheckBaseline()` และทุกจุดที่ตัดสินต้องใช้ `_recheckBaselineSystemQty()`
- การย้อนผลที่ยืนยันแล้วกลับเป็น `audit` (ปุ่ม ↺ `reopenPharmacyAudit`) ต้องเขียน marker ที่มี `reopenedAt` ก่อนแก้ local และ `_writePharmacyAuditMarkers` ต้องให้ reopen ชนะ guard "final ชนะ audit เสมอ"
- WH ใช้ Count/Recheck confirmation workflow แยกกัน ห้ามนำ flow ของสาขายาไปใช้แทน
- WH supervisor ไม่รีเช็คเอง: ป็อปอัพ Audit Verify เป็น read-only (`_isWhSupervisorAuditReadonly()`) ยืนยันได้อย่างเดียวและต้องผ่าน transaction เสมอ

## 4. สูตรคำนวณที่ห้ามเปลี่ยนโดยพลการ

ผล Confirm รอบแรกคำนวณจาก:

```text
effectiveQty = countedQty + soldQty + r16103Qty - inboundQty
```

- `soldQty` มาจาก R16.104 ที่เกิดก่อน/ตรงเวลาสแกน
- `inboundQty` มาจากรายการรับเข้าที่เกิดก่อน/ตรงเวลาสแกน
- `r16103Qty` ใช้กับ WH สำหรับของรับเข้าแต่ยังไม่ขึ้นชั้น
- `effectiveQty === systemQty` → `pass`
- สาขายา `noStock` ที่เข้าเงื่อนไข → `stock_adjustment`
- **สาขายา `negSys` (ระบบติดลบ) → บังคับเป็น `audit` เสมอไม่ว่านับได้เท่าไร (ส.ค. 2026)**
  ต้องเช็ค `negSys` **ก่อน** `effectiveCnt===sys` เพราะ systemQty ถูก clamp เป็น 0 แล้ว → นับ 0 จะกลายเป็น `pass` เงียบๆ
  เดิมลัดไป `stock_adjustment` โดยไม่ผ่านเภสัช — ห้ามย้อนกลับ
- `systemQty===0` ที่นับเจอของต้องไป `audit` ให้เภสัชรีเช็คเสมอ ห้ามลัดเป็น `stock_adjustment` เอง
- **กฎ "สแกนครั้งแรกนับ 0" ถูกถอดออกหมดแล้ว (ส.ค. 2026)** — ทั้ง G=0 และ G ติดลบสแกนแล้วบวกตามปกติ ห้ามนำกลับมา
- **ยอดรีเช็ค 0 ต้องบันทึกและยืนยันได้** (= "ตรวจแล้วไม่มีของ") ต่างจาก "ยังไม่รีเช็ค" (`recheckQty == null`)
  ถ้ากลับไปกรอง `qty > 0` ใน `getPharmacistAuditPendingMap` หรือบังคับขั้นต่ำ 1 ใน `updatePharmacyRecheckQty` → negSys จะค้าง audit ถาวร
- กรณีอื่น → `audit`
- WH Recheck รอบสองเปรียบเทียบ `recheckQty` กับ `systemQty` จาก R01 ล่าสุดบน Firestore โดยตรง ไม่ใช้ค่า local ที่อาจค้าง

ห้ามแก้เครื่องหมายบวก/ลบ, TRANDATE cutoff, การ clamp `negSys`, เงื่อนไข `noStock`, หรือความหมายของ Pass/Audit/Stock Adjustment โดยไม่ได้รับอนุมัติพร้อมชุดทดสอบข้อมูลจริง

## 5. Firestore documents และ precedence

เอกสารสำคัญใน `stock_sessions`:

| Document | หน้าที่ |
|---|---|
| `{branch}` | session หลักของ branch (schema v2 = metadata เท่านั้น) |
| `{branch}/items/{sku}` | schema v2: 1 document ต่อ SKU ต่อรอบนับ (subcollection) |
| `{branch}_r01` | R01 master/version และ R16 metadata ของสาขา |
| `{branch}_pm` | Product Branch Master — catalog + การจัดชั้น Col D ต่อสาขา (ส.ค. 2026 แทน `global_pm`) · `cat_coded:true` = เก็บ `cat` แล้ว = ใช้กติกา A/B/C ได้ |
| `global_pm` | legacy read-only — ไม่มีโค้ดอ่าน/เขียนแล้ว เก็บไว้เพื่อ rollback ห้ามลบ |
| `global_r05` | Barcode master R05 (ยัง global ใช้ร่วมทุกสาขา) |
| `WH/confirm_ops/{opId}` | WH workflow v2 operation; authoritative เมื่อ `state==='committed'` เท่านั้น |
| `WH/confirm_ops/{opId}/results/{sku}` | ผล Count/Recheck ต่อ SKU ของ operation นั้น |
| `WH_counts`, `WH_rechecks` | legacy inbox ระหว่าง compatibility; live state ใหม่อยู่ที่ `WH/items/{sku}` |
| `WH_count_confirmations`, `WH_recheck_confirmations` | legacy final markers สำหรับ migration/dual-read เท่านั้น ห้ามเพิ่ม final ใหม่ |
| `WH_r16_104_meta`, `WH_r16_103_meta` | active R16 timeline generation/version |
| `WH_r16_{kind}_{generation}_{index}` | versioned R16 timeline chunks |
| `{branch}_confirm_lock` | lock ชั่วคราวระหว่าง Pharmacy Desktop Confirm |
| `{branch}_pharmacy_audit_markers` | authoritative worklist/ผล Audit ของสาขายา แยกจาก session JSON |
| `WH_location` | location/zone mapping ของคลัง |

Precedence ของ WH Supervisor ต้องคงเป็น:

```text
R01/R16 master
→ WH/items base
→ Count final (committed op หรือ legacy marker ระหว่าง compatibility)
→ Count pending เฉพาะเมื่อยังไม่มี final
→ Recheck final (ชนะ Count audit)
→ Recheck pending เฉพาะเมื่อยังไม่มี Recheck final
```

ข้อบังคับ:

- เฉพาะ parent op ที่ `state==='committed'` และมี results ครบตาม `candidateCount`/`candidateHash` เท่านั้นที่เป็น authoritative; `preparing`/`aborted` ต้องไม่มีผลต่อ state
- committed result ใน `countResetAt` เดียวกันชนะ item snapshot และ legacy inbox/marker ที่มาช้าเสมอ
- Rules ต้องกัน same-epoch update ของ `WH/items/{sku}` ไม่ให้ลบ/เปลี่ยน `whCountOpId` หรือ `whRecheckOpId` ที่ materialize แล้ว; branch อื่น, epoch ใหม่, create/delete ไม่เปลี่ยนพฤติกรรม
- สาขายาให้ `{branch}_pharmacy_audit_markers` ชนะ session/local ทุกเครื่อง; Audit ที่อยู่ใน marker ห้ามถูก Pass เก่าหรือ SKU ที่หายจาก session กลบ
- marker ของสาขายาเก็บ Audit ที่รอ verify, ผลที่เภสัชยืนยันแล้ว และ resolution จาก R16 re-calculation; เขียนด้วย transaction และผูก `countResetAt`
- Recheck marker ต้องชนะ Count marker ที่ยังเป็น `audit`
- `audit` เก่าที่ไม่มี `auditor` ห้ามทับผล `pass`/`stock_adjustment` ที่ Supervisor ยืนยันแล้ว
- WH Confirm เขียน results ขณะ op เป็น `preparing`, verify server count/hash แล้ว publish ทั้งชุดด้วย transaction ที่เปลี่ยน parent เป็น `committed` เพียงจุดเดียว; ห้ามให้ reader เห็นผลระหว่างเตรียม
- Rules ต้องบังคับ results เป็น immutable (create-once; update ไม่ได้) และ op update ได้เฉพาะ `preparing → preparing|committed|aborted`; committed/aborted ห้ามย้อน ส่วน delete คงไว้สำหรับ cleanup รอบนับ
- การ materialize ลง `WH/items/{sku}` และล้าง legacy pending หลัง commit ต้อง idempotent และทำต่อจาก committed results ได้ ห้ามคำนวณผลใหม่หรือถือว่าความล้มเหลวกลาง chunk คือ rollback
- ห้ามทำ Firestore delete แบบ fire-and-forget ใน confirmation flow ที่ต้อง atomic; local state เปลี่ยนได้หลัง committed transaction และ full-result verification สำเร็จเท่านั้น
- R01/R16 version ไม่ตรงหรือ Supervisor ออฟไลน์ต้อง abort โดยไม่เปลี่ยนสถานะบางส่วน
- ห้าม simplify `_applyCloudScanData()` หรือ `syncToFirestore()` โดยไม่ตรวจ race ระหว่าง local edit, session listener, inbox และ marker

## 6. Pharmacy Desktop Confirm และ branch lock

- `validateAndProcess()` ต้องบล็อก Confirm บน native PDA และส่งสาขายาไป `_confirmPharmacyBatched()`
- ใช้ `stock_sessions/{branch}_confirm_lock` เก็บ `token`, `owner`, `countResetAt`, `startedAt`, `expiresAt`
- Lock มีอายุ 5 นาที (`BRANCH_CONFIRM_LOCK_MS`) และปลดได้ด้วย token เจ้าของเท่านั้น
- PDA ออนไลน์ทุกเครื่องต้อง disable scan input และ guard ทั้ง Intent barcode, queue, manual quantity และ modal ที่เปลี่ยนยอด
- Confirm ประมวลผลครั้งละ 25 รายการ (`BRANCH_CONFIRM_BATCH_SIZE`) และ yield event loop เพื่อไม่ให้หน้า Desktop ค้าง
- ก่อน apply ต้องอ่าน server ซ้ำและตรวจ `countResetAt`, R01/R16 version, `countedQty`, `timestamp`, `scannedBy`
- ถ้าข้อมูลเปลี่ยนกลางงานต้อง abort ทั้งชุด ห้ามเกิดผลบางส่วน
- ถ้า sync ผลล้มเหลว ให้คง lock จน retry สำเร็จหรือ TTL หมด เพื่อกันกด Confirm ซ้ำทันที
- ก่อน apply ผลรอบแรกต้องเขียนรายการที่เป็น Audit ลง Pharmacy Audit marker; ก่อน apply Audit Verify ต้องเขียนผล final marker เพื่อให้ session sync ล้มเหลวแล้วทุกเครื่องยังเห็นสถานะเดียวกัน
- `syncToFirestore(true)` ใช้ได้เฉพาะ `startNewCount()` เท่านั้น ห้ามใช้ตอน login, stale-day reset หรือออกจาก Admin Mode เพราะ local cache อาจเขียนทับ session ทั้งสาขา
- Audit Verify Confirm ของเภสัชใช้ `_confirmPharmacyAuditBatched()` ซึ่งใช้ lock/แบตช์/การตรวจเวอร์ชันชุดเดียวกัน
  ต่างกันที่ candidate คือ `status==='audit'` ที่มี `recheckQty` และยังไม่มี `auditor` และตรวจว่า `recheckQty/recheckBy/recheckAt` ไม่เปลี่ยนกลางงาน
- เหตุผลที่ Audit Verify ต้อง Desktop-only: `getSoldQtyBefore()`/`getInboundQtyBefore()` fallback เป็นยอดรวมทั้งช่วงเมื่อเครื่องไม่มี R16 raw timeline
  เครื่องที่รับ R16 ผ่าน session sync (PDA) จึงตัดสิน pass/stock_adjustment ผิดได้

## 7. จุดสแกนที่ต้องขออนุมัติก่อนแก้

การแก้รายการต่อไปนี้ถือเป็น scan-related change ต้องอธิบาย change, impact และ test plan ให้ผู้ใช้อนุมัติก่อน:

- Input/detection: `handleScanInput`, `handleScanKey`, `submitScanManual`, `receiveBarcode`, debounce constants และ PDA state
- Queue/core: `processScan`, `processPharmacistAuditScan`, `parseScanLine`, `scanQueue`, `drainQueue`, `handleBarcode`
- Confirm/formula: `validateAndProcess`, `_confirmPharmacyBatched`, `_confirmPharmacyAuditBatched`, `_sameBranchRecheck`, `evaluatePendingScans`, `_buildPendingScanEvaluation`
- Audit Verify: `handleAuditVerifyScan`, `_addRecheckScanQty`, `getPharmacistAuditPendingMap`, `confirmAuditVerifyItem`, `confirmAllAuditVerify`, `confirmRecheckBtn`
- UI/state: `appendScanRow`, `removeScanItem`, `resetRecheckItem`, `rebuildScanListMap`, `renderScanList`, `patchScanRow`
- Cloud: `_applyCloudScanData`, `syncToFirestore`, `pullFromCloud`, session/inbox/marker listeners และ restore/backfill
- Audit/Recheck: Audit Verify, Count Confirm, Recheck Confirm และ role/status filters
- WH workflow v2: `confirm_ops`/`results` reader-listener, prepare/commit/materialize/recovery, legacy dual-read และ migration/cleanup ทุกจุด

อย่าลบ `_scanGapHold` guards หรือ dead gap-modal code แบบแยกส่วน แม้ 2-minute reset ถูกยกเลิกแล้ว เพราะ guards ยังผูกกับ `_zeroSysHold` และ queue runtime

เพิ่มจาก schema v2 (ก.ค. 2026) — ถือเป็น scan-related ทั้งหมด:
`getScanItemsRef`, `_markSkuDirty`, `_flushDirtySkus`, `_writeScanningItem`, `_scanItemPayload`, `_scanItemToLocal`,
`_scanItemFingerprint`, `_scanItemLastQty`, `_reconcileScanItems`, `startScanItemsListener`, `_applyScanItemChange`,
`_applyScanItemRemoved`, `_applyCloudSessionMeta`, `_loadScanItemsFromCloud`, `_deleteScanItemsForEpoch`,
`_applyConfirmItemsToState`, `_writeConfirmedItems`, `_syncSessionMetaToFirestore`, `_schemaVersion` และ constant `SCAN_ITEM_*`

## 8. Bug ที่เพิ่งแก้และ invariant ที่ต้องรักษา

| Commit | ปัญหาที่แก้ | สิ่งที่ห้ามทำให้ย้อนกลับ |
|---|---|---|
| `9c7e507` | แก้จำนวนด้วยมือแล้ว cloud snapshot เก่าทับกลับ | local edit protection ต้องชนะ stale snapshot ชั่วคราว |
| `bb06a0a` | กดลบแถวแล้วรายการเด้งกลับ | intentional local delete ห้ามถูก session เก่า resurrect |
| `1914cd4`, `546cccd` | Recheck ที่สแกนแล้วเรียงผิดและเด้งกลับด้านล่าง | insertion order/การ rebuild list ต้องคงลำดับ Recheck จากบนลงล่าง |
| `04ec420`, `48f5174`, `0ee325d`, `12a4900` | Recheck quantity ไม่ขึ้น Supervisor, ค่า `null` และแก้จำนวนไม่ได้ | ค่า 0 ต้อง valid, `null` ไม่ใช่ Recheck, ใช้ `recheckQty/recheckBy/recheckAt` |
| `c1e2255` | Recheck จาก PDA ไม่เข้าปุ่มยืนยัน Supervisor อย่างเสถียร | `WH_rechecks` inbox และ backfill ต้องยังทำงาน |
| `1556267` | Count รอบแรกจาก PDA ไม่ขึ้นปุ่มรายพนักงาน | `WH_counts` inbox และ realtime per-staff count ต้องยังทำงาน |
| `d11f21a` | Confirm Recheck แล้วปุ่มเด้งวนจาก stale audit | Recheck confirmation marker ต้องชนะ audit เก่า |
| `63946a3` | Count Confirm มี race กับข้อมูล PDA/R16 | transaction ต้องอ่าน server ล่าสุดและเขียน marker+ลบ inbox แบบ atomic |
| `177271b` | WH Supervisor สองเครื่องเห็น R01/R16/สถานะไม่ตรงกัน | Cloud master/versioned chunks เป็น source of truth; localStorage เป็น cache |
| `4ff5a12` | PDA แบตไหล, R01 upload status ข้ามเครื่องไม่ชัด | ห้ามนำ bright wake lock กลับมา; R01 ต้องแสดงข้อมูลอัปโหลดล่าสุด |
| `30c57ca` | Pharmacy PDA Confirm หลายร้อยรายการค้าง/กดซ้ำได้ | Confirm ต้อง Desktop-only, batch processing และ branch lock ต้องคงอยู่ |
| (ก.ค. 2026) | เภสัชสแกนรีเช็คแล้วยอดค้างใน memory (`_avMap`) ไปไม่ถึง Desktop และ pending map ดึง `countedQty` รอบแรกจาก `scanListMap` | ยอดรีเช็คต้องอยู่ใน `sd.recheckQty` เท่านั้น, pending map ต้องอ่านจาก `state.scanData` ไม่ใช่ `scanListMap`, Audit Verify Confirm ต้อง Desktop-only + branch lock |
| (ส.ค. 2026) | SKU 200379 (SSS) ของครบแต่ขึ้น Stock Adj — **R16 ที่ใช้ Confirm export ถึงแค่ 13:26 แต่ขาย 15:22 นับ 15:46** → `soldQty=0` → Audit เกินจริง · ตัวเช็ควันที่เดิมจับไม่ได้ (วันตรงกัน ต่างแค่เวลา) และเงื่อนไขหลวม (เหลื่อมวันเดียวก็ผ่าน) | ต้องเตือนระดับ**เวลา**: เทียบ max TRANDATE กับเวลานับล่าสุด + แสดงช่วงข้อมูลของไฟล์บนการ์ด · ห้ามเชื่อว่า "วันที่ตรง = ข้อมูลครบ" |
| (ส.ค. 2026) | เวลาที่โชว์ในแอปเป็นเวลายืนยัน ไม่ใช่เวลาสแกน (ไล่ไทม์ไลน์ย้อนหลังไม่ได้ ต้องเปิด Firestore) | `sd.timestamp` ถูกทับตอน verify — **แสดงผล/export ต้องใช้ `firstScanAt\|\|timestamp` เสมอ · จุดคำนวณห้ามเปลี่ยน** |
| (ก.ค. 2026) | สาขายา Desktop/PDA คนละเครื่องเห็น SKU เดียวกันเป็น Audit/Pass ไม่ตรงกัน และ Audit อาจหายจาก session | Pharmacy Audit marker ต้องเป็น source of truth, listener ต้อง overlay หลัง session ทุกครั้ง, marker-backed SKU ที่หายต้องซ่อมกลับ session และ rollout migration อ่าน Audit Log ตาม epoch |

| (ก.ค. 2026) | session blob ชนเพดาน 1 MiB ของ Firestore เมื่อนับครบทั้งสาขา (~1.6 MB) แล้ว `ref.set()` throw โดยโชว์แค่ `'Sync Error'` — ข้อมูลนับหายเงียบ | `scanData` ต้องอยู่ใน `{branch}/items/{sku}` (schema v2); `_reportSyncError()` ต้องรายงานกรณีเกินขนาดให้ชัดแทน throw เงียบ; ห้าม dual-write blob+items |
| (ส.ค. 2026) | `WH_count_confirmations` เก็บ SKU เป็น dynamic map จนชนเพดาน 40,000 index entries ที่ 873 markers ทำให้ Supervisor Confirm ต่อไม่ได้ ทั้งที่ document ยังไม่ถึง 1 MiB | ห้ามเพิ่ม final ลง legacy map; ใช้ `WH/confirm_ops/{opId}/results/{sku}` และ atomic committed pointer, เก็บ legacy read-only ระหว่าง migration และ roll-forward หลังมี post-cutover commit |
| (ส.ค. 2026) | Progress มีตัวเศษกับตัวหารมาคนละแหล่ง (ตัวเศษวนจาก `scanData`, ตัวหารนับจาก `r01Data`) → ถ้ากรอง SKU ออกข้างเดียว % ทะลุ 100 ได้ | **ตัวเศษกับตัวหารต้องมาจาก `_countableSkus` ชุดเดียวกันเสมอ** ห้ามแยกแหล่งคำนวณ · **ห้ามใช้ `skuMap.systemQty` แยก "G=0" กับ "G ติดลบ"** เพราะสาขายา clamp `negSys` เป็น 0 แล้ว ต้องอ่าน `state.r01Data` ค่าดิบ |
| (ส.ค. 2026) | Product Master เป็นไฟล์กลางไฟล์เดียวทุกสาขา ทำให้ Total SKU เป็นเลขทั้งบริษัทและต้องมีการ์ด `SKU BRANCH` ซ้อน | PM เป็น `{branch}_pm` ต่อสาขา · **ห้ามใส่ fallback ไป `global_pm`** (สาขาที่ยังไม่อัปต้องเห็น "ยังไม่โหลด" ไม่ใช่ catalog สาขาอื่น) · `restoreMasterFromFirestore` ต้องล้าง PM เมื่อ doc ไม่มี · ห้ามลบ `global_pm` บน cloud (rollback) |
| (ส.ค. 2026) | กติกา "นับเฉพาะ R01 ที่ G ≠ 0" ทำให้สินค้าขายดี (PBM Col D = A/B/C) ที่ระบบขึ้นสต็อก 0 หลุดจากงานนับ ทั้งที่ต้องเดินไปดูของบนชั้นจริงทุกครั้ง | `_countableSkus` = R01 · หมวด Col P นับได้ · **และ ( `G ≠ 0` หรือ PBM Col D ∈ {A,B,C} )** · ⚠️ **ต้องเป็น `หรือ` ห้ามเป็น `และ`** — เงื่อนไข A/B/C มีแต่เพิ่ม ทำให้ PBM ไฟล์เก่าที่ไม่มี `cat` ให้ผลเท่ากติกาเดิมเองโดยไม่ต้องมี feature flag · เปลี่ยนเป็น `และ` = ทุกสาขาที่ยังไม่อัป PBM ได้ Total SKU = 0 ทันที · หมวด R01 ชนะทั้งสองข้อเสมอ · เก็บ `cat` เฉพาะแถว A/B/C — `{branch}_pm` มีเพดาน 1 MiB เหมือน `global_r05` และ `syncProductMasterToFirestore` ต้อง toast error เมื่อเขียนไม่ผ่าน ห้าม catch เงียบ · PBM มีผลกับตัวหารแล้ว ทุกจุดที่ PBM/R01 เปลี่ยนต้องรีคำนวณ **แม้ R05 ยังมาไม่ถึง** |

สถานะปัจจุบันของการแก้ WH: โค้ดรุ่นใหม่ถูก commit/push แล้ว และเขียนผลยืนยันใหม่ผ่าน `WH/confirm_ops/{opId}/results/{sku}` เท่านั้น จึงไม่ควรชนเพดาน dynamic-map เดิมซ้ำในรอบถัดไป เมื่อแก้หรือ deploy ที่เกี่ยวข้อง ต้อง Publish `firestore.rules` ก่อน/พร้อม deploy เว็บ และบังคับให้ Supervisor กับ PDA ทุกเครื่องโหลดรุ่นใหม่ หาก Confirm ยังล้มเหลว ให้ตรวจ Rules/runtime version, R01/R16 readiness/version, confirm lock, network และ quota; ห้ามลบ legacy markers หรือเริ่มรอบใหม่เพื่อแก้เฉพาะหน้า

Schema v2 — invariant ที่ห้ามทำให้ย้อนกลับ (รายละเอียดเต็ม + งานที่ยังค้างอยู่ที่ `CLAUDE.md` §Scan data schema v2):

- **SRC และ WH cutover เป็น v2 แล้ว (24 ก.ค. 2026)** ผ่าน `migrateSessionToSchemaV2()` ระหว่างรอบนับ · KKL/SSS ยังเป็น v1
  WH ชนเพดานจริงก่อน migrate (`session_data_json` 1,182,913 bytes ถูก Firestore ปฏิเสธ = sync ค้างไปหลายชั่วโมง)
- rollback = ตั้ง `schemaVersion` กลับเป็น 1 → **ห้ามลบโค้ด blob path** จนกว่าจะผ่านรอบนับจริงอย่างน้อย 2 รอบ
- `scanning` ต้องเขียนด้วย `runTransaction` + delta (ยอดปัจจุบัน ลบค่าที่ sync แล้ว) ห้ามกลับไปใช้ "เลือก `countedQty` ที่สูงกว่า" ซึ่งทำยอดของอีกเครื่องหาย
- listener ต้องข้าม `hasPendingWrites` และข้าม SKU ที่อยู่ใน `_dirtySkus`/`_scanItemInFlight` ไม่งั้น echo ของ write ตัวก่อนจะดึงยอดกลับหลังผู้ใช้สแกนเพิ่ม
- `_scanItemToLocal()` ต้องคง `scans`/`retries`/`manualEditAt` ของเครื่องเดิม — `scans` ถูกอ่านโดย `_zeroSysFirstScan`
- `manualEditAt` สด = เขียนทับตรงๆ ไม่ใช่ delta
- ไม่เขียน doc สำหรับ `pending` (ไม่มี doc = `pending`)
- `firestore.rules` ต้องแยก parent `stock_sessions/{document}` ออกจาก subcollections (`{branch}/items/{sku}`, `WH/confirm_ops/{opId}`, `results/{sku}`) และห้าม recursive broad allow `{document=**}` เพราะจะข้าม schema guard; ต้อง Publish Rules ก่อน deploy เว็บ และสร้าง composite index `countResetAt`+`status` ก่อน scan schema cutover
- `_checkSessionBlobSize()` **ห้ามกลับไป block การเขียน** — block เองจะทำให้ payload ที่ Firestore ยังรับได้เขียนไม่ผ่าน และทำ branch lock ค้าง
- `migrateSessionToSchemaV2()` ต้องคงลำดับ: สำรอง → เขียน items → **verify จำนวนจาก server** → ค่อยเขียน session doc เป็น metadata-only
  ห้ามเขียน session doc ก่อน verify เด็ดขาด เพราะนั่นคือจุดที่ `scanData` เดิมหายไป
- Dashboard v2 ต้องอ่าน `items` จาก server โดยกรอง `countResetAt` ของ session ปัจจุบัน; ถ้าอ่านล้มเหลวต้องแสดง error ห้าม fallback ไป metadata-only blob แล้วแสดงยอดต่ำกว่าจริง
- การกู้ local backup ระหว่างรอบนับต้องตรวจ hash/branch/`countResetAt`, บังคับ dry-run, สำรอง Cloud ก่อนเขียน และเขียนเฉพาะ SKU ที่ไม่มี document อยู่ในทุก epoch ด้วย transaction ห้ามทับ item เดิมทุกกรณี
- ถ้า session ทำ field `schemaVersion` หายแต่ current-epoch items ครบ ห้าม migrate/recover items ซ้ำ; สำรอง Cloud และใช้ transaction merge เฉพาะ `{schemaVersion:2}` โดยตรวจว่า blob/items hash ไม่เปลี่ยน

Toast บน PDA ต้องกระชับผ่าน `_toastMessageForDevice()` และใช้ `textContent`/callback สำหรับ action ห้ามกลับไปประกอบข้อความผู้ใช้ด้วย unsafe `innerHTML`

## 9. Android และการใช้แบต

- Android wrapper ใช้ `FLAG_KEEP_SCREEN_ON` เฉพาะช่วงใช้งาน และปล่อยหลังไม่มีการแตะหรือรับ barcode 2 นาที
- ห้ามนำ `SCREEN_BRIGHT_WAKE_LOCK`, `ON_AFTER_RELEASE` หรือ permission `WAKE_LOCK` กลับมา
- Web Audio บน PDA suspend หลังเสียงจบประมาณ 1.5 วินาทีและ resume ก่อนเล่นครั้งถัดไป
- ห้ามลด Firestore listener/write frequency เพื่อประหยัดแบตโดยไม่มีการวัดผล เพราะ Realtime ไป Supervisor เป็น requirement
- แก้เฉพาะเว็บ/เอกสารไม่ bump APK
- แก้ `android-app/app/src/**`, AndroidManifest, resources หรือ native build config ต้อง bump `versionCode`/`versionName`, sync `version.json`, build APK, tag `v*` และ push tags

## 10. สิ่งที่ห้ามแตะหากงานไม่ได้ระบุโดยตรง

- `android-app/app/stockcount.keystore`: ห้ามแก้, แทนที่, แสดงเนื้อหา หรือเผยแพร่ข้อมูล signing
- `libs/**`: ห้ามแก้ vendored/minified libraries
- `vercel.json`: เป็น deployment headers; ห้ามรวม dirty change ที่ไม่เกี่ยวข้อง
- `firestore.rules`: ห้ามเปลี่ยนสิทธิ์เงียบ ๆ และต้องแจ้งขั้นตอน Publish หากแก้
- sample CSV, backup, `.windsurf/`, `.claude/settings.local.json` และไฟล์ local อื่น: ห้ามลบหรือ commit เว้นแต่ผู้ใช้สั่งชัดเจน
- คู่มือ/HTML ตัวอย่าง: ห้ามเหมารวมว่าเป็น runtime
- PIN, credential, API secret และ keystore material: ห้ามใส่ในเอกสาร, log หรือคำตอบ

Git safety:

- ห้าม `git reset --hard`, `git checkout --` หรือคำสั่งทำลายงานผู้ใช้โดยไม่มีคำสั่งชัดเจน
- ห้าม `git add .` หรือ broad staging ใน dirty worktree ให้ stage เฉพาะไฟล์ที่งานอนุญาต
- ห้าม amend/rebase/force-push โดยไม่ได้รับอนุมัติ
- ก่อน commit แสดงรายการไฟล์ที่จะเข้า commit และคงไฟล์ unrelated ไว้เหมือนเดิม

## 11. Known limitations และ operational assumptions

- ระบบยังรอ UAT จริงจากพนักงานสาขา, เภสัช, WH warehouse และ WH supervisor
- PDA ที่ออฟไลน์ไม่สามารถรับ branch confirm lock ทันที รายการใหม่ต้อง sync ภายหลังและรอ Confirm รอบถัดไป
- WH PDA เก่าระหว่าง workflow-v2 compatibility อาจยังเขียน `WH_counts`/`WH_rechecks`; reader ใหม่ต้อง dual-read โดยไม่บวกซ้ำกับ `WH/items` และ committed op ต้องชนะ delayed write เสมอ
- rollback WH workflow กลับ legacy ปลอดภัยเฉพาะก่อนมี post-cutover committed op แรก หลังจากนั้น legacy confirmation doc รับ final ใหม่ไม่ได้แล้วและ recovery ต้อง roll-forward จาก op results
- Pharmacy Desktop ต้องออนไลน์ระหว่าง Confirm เพื่ออ่าน server และ acquire lock
- Audit Verify รองรับ pending quantity 0 แล้ว (ส.ค. 2026) = "ตรวจแล้วไม่มีของ" ต่างจาก "ยังไม่รีเช็ค" (`recheckQty == null`) — ห้ามกลับไปกรองค่ามากกว่า 0
- Firestore rules ปัจจุบันอนุญาต read/write collections ที่ใช้โดยแอป การ tighten rules เป็นงาน security/migration แยกต่างหากและต้องทดสอบทุก client
- การอัป R01 ของสาขายาเป็น daily baseline แต่ไม่ควรล้าง Audit/Pass เก่าที่ตั้งใจ freeze โดยพลการ
- WH สแกนได้ 24 ชั่วโมง ส่วนสาขายายังคง time gate ตามเวลาทำการ

## 12. การตรวจสอบก่อนส่งงาน

สำหรับการแก้เว็บ/Scan Engine อย่างน้อยต้องทำ:

1. ตรวจ inline JavaScript syntax ใน `index.html`
2. รัน `git diff --check`
3. ตรวจ `git diff` และ `git status --short` ว่าไม่มีไฟล์ unrelated ถูกแก้/stage
4. ทดสอบ flow ที่แก้และ regression ของ branch/role ที่แชร์ฟังก์ชันเดียวกัน
5. งาน sync/confirm ต้องทดสอบ stale snapshot, offline/transaction failure, สองเครื่องพร้อมกัน และ `countResetAt` เปลี่ยนกลางงาน
6. งาน ordering ต้องทดสอบหลัง listener snapshot และหลัง rebuild/reload ไม่ใช่เฉพาะทันทีหลังสแกน
7. งาน native Android ต้อง build APK และทดสอบ Intent barcode, foreground/background, screen timeout และเสียง

มี automated test suite ใน `tests/` (Playwright + Firestore Emulator, แยกขาดจาก production — รันได้แม้พนักงานกำลังสแกน)
งานที่แตะ scan/sync **ต้องรัน `cd tests && npm test` ให้เขียวก่อนส่ง** และยังต้องมี manual scenario ตาม flow จริงเพิ่มด้วย
เทสครอบ: สอง PDA ชน SKU เดียวกัน (ยอดต้องรวม), Confirm/Audit Verify บน schema v2 รวม mid-work abort, offline reconcile, สูตร effectiveQty, กฎราคา, merge rules, firestore.rules schema guard
เทส **ไม่ครอบ**: PDA จริง (Intent scanner/keystroke/WebView/APK), composite index บน production (emulator ไม่บังคับ index), WH Count/Recheck inbox flow — สามข้อนี้ยังต้องทดสอบมือทุกครั้ง
**ห้ามแก้ `index.html` หรือไฟล์ production เพื่อให้เทสผ่าน** — harness ต้อง adapt เข้าหาแอป ไม่ใช่ทางกลับกัน

## 13. การ deploy

- เว็บ: commit/push ไป `main` แล้ว Vercel deploy; ไม่ต้องออก APK
- Service Worker: bump `CACHE` ใน `sw.js` เมื่อแก้ assets/cache behavior
- Firestore Rules: copy และ Publish ผ่าน Firebase Console หลัง review; ถ้า runtime เพิ่ม subcollection ใหม่ต้อง Publish Rules ที่รองรับก่อน deploy เว็บ มิฉะนั้น client ทุกเครื่องจะได้ `permission-denied`
- Android: bump version, update `version.json`, commit, tag release และ push tags
- **Product Branch Master ต้องอัปทีละสาขา 4 รอบ** (SRC/KKL/SSS/WH) — สลับสาขาก่อนอัปทุกครั้งและตรวจชื่อสาขาบนหัวจอ
  ไฟล์ลงที่ `{branch}_pm` ของ**สาขาที่เลือกอยู่ตอนนั้น** อัปผิดสาขา = catalog **และตัวหาร Progress** ของสาขานั้นผิดทันทีผ่าน listener
  ตั้งแต่ ส.ค. 2026 การอัป PBM **เปลี่ยนตัวหาร Progress ทุกเครื่องของสาขานั้นทันที** (PBM Col D ∈ A/B/C เป็นตัวตัดสิน) — คำนวณเลขที่คาดหวังใน Excel ไว้ก่อน, ตรวจ toast ว่าจำนวน `A/B/C` ไม่เป็น 0 และแจ้งหน้างานล่วงหน้า ไม่งั้นจะถูกรายงานว่า "ระบบพัง"
- หลังแก้ behavior ให้ update `CLAUDE.md` หรือ skill ที่เกี่ยวข้อง เพื่อไม่ให้ agent รอบถัดไปย้อน Bug เดิม

Baseline ขณะเขียนเอกสารนี้คือ `30c57ca` (`Move pharmacy confirmation to desktop`) ให้ตรวจ commit ล่าสุดทุกครั้ง เพราะเอกสารนี้อาจตามหลังโค้ดในอนาคต
