# SKILL: Data Files & Persistence

โหลดไฟล์นี้เมื่อแก้ไขหรือ debug งานที่เกี่ยวกับ: อัพโหลดไฟล์ R01/R05/R16, column mapping,
DEL/P items, Export Excel, Firestore persistence layers, หรือ Location master

---

## Data Flow

```
1. Upload R01.102 + R05.106 + Product Branch Master (`{branch}_pm` — ต่อสาขา)
   → loadR01() / loadR05() / loadProductMaster()
   → rebuildMaps() → skuMap, barcodeMap, skuDirectMap
   → init scanData (pending) สำหรับทุก SKU ที่รู้จัก

2. Scan → handleBarcode() → accumulate countedQty

3. Upload R16.104 → loadR16()
   → r16SalesMap + r16RawMap (sales: ORCM/OCTM) — WH ข้าม
   → r16InboundMap + r16InboundRawMap (inbound: OTFB/ORTS/OTFI)
   → auto reEvaluateAuditItems() ถ้า matched > 0
   → R16 Date Mismatch warning ถ้าวันไม่ overlap

4. Upload R16.103 (WH only) → loadR16_103()
   → r16_103Map + r16_103RawMap (รับเข้ายังไม่ขึ้นชั้น)

5. Confirm → evaluatePendingScans()
   effectiveCnt = countedQty
               + getSoldQtyBefore(sku, timestamp)      [สาขา]
               + getR16103QtyBefore(sku, timestamp)    [WH]
               - getInboundQtyBefore(sku, timestamp)
   เทียบกับ systemQty → pass / audit
```

---

## Column Mappings (zero-indexed, skip row 0 header)

### R01.102
| Col | Index | Field |
|---|---|---|
| E | 4 | SKU |
| F | 5 | ProductName |
| G | 6 | SystemQty |
| P | 15 | หมวดสินค้า → ใช้ตัดสิน "ต้องนับไหม" (เก็บเป็นธง `nc` ไม่เก็บข้อความ) |

- ข้ามเฉพาะแถวที่ qty ว่าง/ไม่ใช่ตัวเลข
- **qty ≤ 0 (ติดลบ/0) เก็บไว้ด้วยค่าจริง** ไม่ clamp — เพื่อให้ DEL ที่ระบบติดลบแต่มีของจริงบนชั้นนับได้
- **G = 0 ไม่ได้แปลว่า "ไม่ต้องนับ" เสมอไปแล้ว (ส.ค. 2026)** — `_countableSkus` = `G ≠ 0` **หรือ** PBM Col D ∈ `{A,B,C}`
  ยังต้องมีแถวใน R01 ถึงจะนับ · หมวด Col P ตัดออกได้เสมอ · **G ติดลบยังนับ** (คือการขายของขาด)
  G ยังเป็นตัวตัดสิน **pass/audit** ในสูตร Confirm ตามเดิมทุกอย่าง — เปลี่ยนแค่ "ต้องเดินไปนับไหม"
  ⚠️ อ่าน G จาก `state.r01Data` ค่าดิบเท่านั้น — `skuMap.systemQty` ของสาขายา clamp `negSys` เป็น 0 ไปแล้ว แยก "G=0 จริง" กับ "G ติดลบ" ไม่ออก
- **คอลัมน์ P = หมวดที่ไม่ใช่สินค้าคงคลัง → ไม่ต้องนับ (ส.ค. 2026)** — `_isNonCountR01Category()` ติดธง `nc:1` ตอน `loadR01`
  - ตัด: ขึ้นต้นด้วย **`11.`** (`R01_NON_COUNT_PREFIXES`) หรือมีคำว่า **`DELETE`** (`R01_NON_COUNT_KEYWORDS`) — เพิ่มหมวดใหม่เติม 2 array นี้ที่เดียว
  - เทียบเลขหมวดนำหน้า/คำสำคัญ **ไม่เทียบข้อความเต็ม** — ชื่อหมวดในไฟล์จริงมีช่องว่าง/วรรคตอนไม่คงที่
  - ⚠️ **เก็บแค่ธง `nc` ห้ามเก็บข้อความหมวดลง `r01Data`** — doc `{branch}_r01` มีเพดาน 1 MiB · ข้อความไทย ~45 ตัวอักษร × 5,400 แถว ≈ 750 KB ชนเพดานทันที
  - ตัดออกเฉพาะจาก `_countableSkus` เท่านั้น — SKU ยังอยู่ครบ: สแกนได้ · Confirm ได้ผลถูกต้อง · เห็นในรายการสินค้า
  - ⚠️ `auto-r01/auto_r01_import.py` ยังไม่เขียนธง `nc` — ถ้าเปิดใช้ auto import ต้องเพิ่ม logic เดียวกัน ไม่งั้น SKU หมวดพวกนี้จะกลับมานับ
- Re-upload: `state.r01Data = []` ก่อน → `rebuildMaps()` — scanData ของ SKU เดิมไม่ถูกรีเซ็ต
- ⚠️ WH: อย่า re-upload R01 กลางรอบ / ในวันรีเช็ค (cross-day) — baseline จะเลื่อน
- **สาขายา (SRC/KKL/SSS): re-upload R01 ทุกวันได้ตั้งใจ** (baseline หลัง restock) — ดู "R01 Daily Reset" ด้านล่าง

### R01 Daily Baseline (สาขายา เท่านั้น — เปลี่ยนพฤติกรรม July 2026)

Re-upload R01 บน**สาขายา** (`_isPharmacyBranch()` → SRC/KKL/SSS):
- **audit ที่เภสัชยังไม่ verify อยู่รอด** (ไม่รีเซ็ต — `resetUnverifiedAuditForNewR01` ถูกลบแล้ว) เภสัชสแกนรีเช็คเทียบ systemQty ใหม่ได้เลย
- **ล้าง R16 เมื่อวานทันที** ผ่าน `_clearR16ForNewBaseline()` (maps + `r16Loaded=false` + badge + `updateConfirmBtn()`) — ปุ่ม Confirm ผู้ช่วยล็อคจนอัพ R16 วันใหม่ · เหตุผล: systemQty ใหม่รวมยอดขายเมื่อวานแล้ว บวก R16 เก่าซ้ำ = ผิด
- item ที่นับก่อน baseline (`_isPreBaselineItem` — timestamp เก่ากว่า `_r01BaselineAt` เกิน `_R01_STALE_TOL_MS` 5 นาที) ถูก **freeze**: `reEvaluateAuditItems` ข้าม (audit ไม่ flip, pass เก่าคง pass ถาวร) และ `getPharmacistAuditEffectiveQty` คืน recheckQty ตรงๆ ไม่บวก R16
- ไม่แตะ item ที่มี `auditor` (เภสัชยืนยันแล้ว = final) — เหมือนเดิม
- **WH ไม่มีพฤติกรรมนี้** — ทุกจุด gate `_isPharmacyBranch()`

**Cross-device sync:** `_r01BaselineAt` (module-level, ไม่ใช่ใน state) persist ใน `r01BaselineAt` field — ทุกเครื่องเช็ค `cloud.r01BaselineAt > local._r01BaselineAt` ใน `startScanSessionListener`/`syncToFirestore`/`pullFromCloud`/`restoreFromFirestore` → ถ้าใหม่กว่า เรียก `_applyR01BaselineUpdate()` โหลด R01 จาก `${branch}_r01` master doc + `_clearR16ForNewBaseline()` (นี่คือกลไกล้าง R16 ข้ามเครื่อง — จุด adopt R16 จาก session doc ทั้งหมด gate ด้วย `s.r16Loaded===true` เครื่องอื่นจึงไม่มีทาง "ล้างตาม" เอง) · เครื่องอัพ R01 เรียก `syncR16MetaToFirestore()` เขียน `r16Loaded:false` ลง `_r01` doc ด้วย

**Workflow รายวัน:**
| วัน | ขั้นตอน |
|---|---|
| Day 1 | อัพ R01 → ผู้ช่วยสแกน → อัพ R16 เย็น → Confirm → ไม่ตรง = Audit |
| Day 2 | อัพ R01 ใหม่ (Audit ค้าง**คงอยู่** · R16 ถูกล้าง) → เภสัชสแกนรีเช็ค Audit เทียบ systemQty ใหม่ → ยืนยัน (ตรง=pass / ไม่ตรง=stock_adjustment) · ผู้ช่วยสแกนนับวันใหม่คู่ขนาน → อัพ R16 เย็น → Confirm |

⚠️ ของที่รอรีเช็คแล้วถูก**ขายระหว่างวัน**ก่อนเภสัชสแกน จะไม่ถูกชดเชย R16 (by design — เทียบตรง) → แนะนำรีเช็คให้เสร็จก่อนอัพ R16 เย็น

### R05.106
| Col | Index | Field |
|---|---|---|
| A | 0 | Barcode |
| **B** | **1** | **unitPrice — ราคาต่อหน่วยของบาร์โค้ดนั้น (ตัวตัดสินกฎกรอกจำนวน ตั้งแต่ ก.ค. 2026)** |
| E | 4 | SKU |
| G | 6 | unitName |
| H | 7 | unitMultiplier |

⚠️ อย่าสับสนกับ **R05.105** ซึ่งเป็นไฟล์ราคาคนละตัว (ใช้แนบในใบปรับปรุงสต็อก: ColB=SKU, ColE=หน่วย, ColH=ราคา, กรอง ColF===4)

- ราคาว่าง/อ่านไม่ออก → `null` = ต้องสแกนทีละชิ้น (fail-safe) · แถวที่ไม่มี Barcode หรือ SKU ถูกข้ามเหมือนเดิม
- `rebuildMaps()` เก็บราคาไว้ทั้งสองระดับ: ต่อบาร์โค้ดใน `skuMap.barcodes[].unitPrice` (ใช้ตอนสแกน) และต่อรายการใน `skuMap.unitPrice` ที่ `_baseUnitPrice()` เลือกจากบาร์โค้ดตัวคูณต่ำสุด (ใช้คุมช่อง QTY)
- `global_r05` เป็น doc กลางใช้ร่วมทุกสาขา มีเพดาน 1 MiB — toast ตอนอัปโหลดโชว์ขนาดจริงและเตือนที่ 800 KB
- **เก็บบน cloud เป็น array-of-arrays** `[[barcode,SKU,unitName,mult,price],...]` (`format:'r05a1'`) — object form ที่ 10,619 บาร์โค้ด = 1,069 KB **เกินเพดานจริง** เขียน/อ่านผ่าน `_serializeR05()` / `_parseR05Json()` เท่านั้น (parser ยังรองรับ object form เดิม)

### R16.104 — Document Types (Col C)

> ไฟล์ R16 export รวมทุกสาขา + WH ในไฟล์เดียว → Col C prefix เป็น filter หลัก

| Col C prefix | ประเภท | ผลต่อ effectiveCnt | WH |
|---|---|---|---|
| ORCM, OCTM | ยอดขาย | **บวกกลับ** → `r16SalesMap` | **ข้าม** |
| OTFB, ORTS | รับเข้าคลัง | **หักออก** → `r16InboundMap`. **SRC เท่านั้น:** OTFB ใช้ Col A เหมือน OTFI — Col A=`0`/ว่าง (คลังส่ง) → **ข้าม**; Col A=`1` (สาขาส่ง) → **บวกกลับ**. KKL/SSS: OTFB ทุกแถวเป็น inbound ตามปกติ | ใช้ |
| OTFI | ดูด้านล่าง | branch-aware | ดูด้านล่าง |

⚠️ **SRC ("อนิน สาขาแยกชากค้อ")** สาขา+คลังรวมกันใน POS แยกไม่ได้ → ต้องใช้ Col A บอกทิศของ OTFB เหมือน OTFI (`isSrcOtfb` ใน `loadR16`, ตัวแปร `R16_INBOUND_PREFIXES`/`R16_OUTBOUND_PREFIXES`) สาขาอื่น (KKL/SSS) ไม่มี carve-out นี้

**OTFI — ทิศสองทาง (สาขายา SRC/KKL/SSS):**
- Col A (index 0) = `'1'` → สาขา→คลัง (โอนออก) → **บวกกลับ** (`r16SalesMap`)
- Col A = `'0'` หรือว่าง → คลัง→สาขา (รับเข้า) → **หักออก** (`r16InboundMap`)

**OTFI (WH):** ไม่อ่าน Col A → **หักออกเสมอ** (คลังเป็นฝั่งรับโอน)

logic: `isOutbound = !isWhBranch && match(OTFI) && colA==='1'`

**Columns อื่น R16.104:**
- Col O (14) = Barcode
- Col R (17) = BASEQUANTITY (แปลงเป็นหน่วยเล็กสุดแล้ว)
- Col X (23) = SKU
- TRANDATE = auto-detect จาก header row (case-insensitive match `TRANDATE`)

**Upload date sync (cross-device):** `loadR16()` เขียน `r16UploadedAt`+`r16Loaded` ลง master doc `${branch}_r01` ผ่าน `syncR16MetaToFirestore()` (merge, ไม่ใช่ session doc) — อ่านกลับทุก login ผ่าน `_applyR16MetaFromDoc()` ใน `restoreMasterFromFirestore()` เหมือน pattern ของ R01 ดู Known Pitfalls ด้านล่าง

### R16.103 (WH only) — Document Types

| Col C prefix | ประเภท | ผลต่อ effectiveCnt |
|---|---|---|
| IRNC, IRVC, IRNM, ICSM, ITFB, ITFW, IPOS, IRCN | รับเข้ายังไม่ขึ้นชั้น | **บวกกลับ** → `r16_103Map` |

อยู่ใน systemQty แต่พนักงานไม่ได้นับ → ต้องบวกกลับ
ปุ่มแสดงเฉพาะ Desktop WH (`window.innerWidth > 600 && currentBranch === 'WH'`)

---

## R16 TRANDATE Filter

`getSoldQtyBefore(sku, scanTimestamp)`:
- `TRANDATE <= scanTimestamp` → include (ขายก่อน/ระหว่างนับ)
- `TRANDATE > scanTimestamp` → exclude
- TRANDATE ว่าง/parse ไม่ได้ → exclude (conservative)

`parseTranDate()` รองรับ:
- `DD/MM/YYYY H:mm[:ss] [AM/PM]`
- `DD-MM-YY H:mm[:ss] [AM/PM]` (เช่น `25-04-26 8:07`)
- `DD-MM-YYYY H:mm[:ss] [AM/PM]`
- `YYYY-MM-DD HH:mm:ss`

`r16RawMap` ไม่ persist (in-memory only) — หลัง refresh ใช้ `r16SalesMap` (no time filter)
Debug: `console.log('[R16] TRANDATE col index:')` ใน browser Console

---

## R16 Date Mismatch Warning

หลังโหลด R16: เปรียบเทียบ TRANDATE กับ scan dates (รวม +1 วันสำหรับ cross-night / อัพ R16 เช้าก่อนสแกน)
⚠️ การคำนวณ +1 วัน**ห้ามใช้ `toISOString()`** — UTC ถอย 7 ชม. ทำให้วัน+1 กลายเป็นวันเดิม (บั๊กเดิม แก้แล้ว ก.ค. 2026 — ใช้ local format)
ถ้าไม่ overlap:
1. Toast warn 7 วินาที
2. Badge เปลี่ยน "Ready" → "⚠️ ตรวจสอบวันที่" (class `upload-file-badge-warn`)
3. `state.r16DateMismatch = true`

กด Confirm ขณะ `r16DateMismatch === true` → `r16MismatchModal` ต้อง confirm ก่อน

---

## Product Branch Master — Col D (ส.ค. 2026)

Col D ทำ **2 หน้าที่แยกกัน** อย่าสับสน:

**1) Filter — `D` / `P` / `REVIEW` → ข้ามแถวทิ้งทั้งหมด · อื่น → เก็บ** (เดิมข้ามเฉพาะ `REVIEW` แล้วติดแท็ก `A`/`P`)
- **ไม่มี field `isP` ใน `skuMap` แล้ว** — โหมด Progress CatA, ปุ่มกรอง `CAT[A]` / `P` และแท็ก `P` ถูกถอดออกหมด

**2) การจัดชั้นตามยอดขาย — `A` = ขายดีมาก · `B` = ปานกลาง · `C` = ขายได้เรื่อยๆ**
- `loadProductMaster()` เก็บตัวอักษรไว้เป็น field **`cat` เฉพาะแถว A/B/C** (`_isAbcColD()` เทียบเป๊ะ trim+uppercase)
- **ดึง SKU เข้า `_countableSkus` แม้ R01 จะขึ้นสต็อก 0** — สินค้าขายดีต้องเดินไปดูของบนชั้นจริงเสมอ
- ⚠️ เป็นเงื่อนไข **OR** กับ `G ≠ 0` เท่านั้น (มีแต่เพิ่ม ไม่มีตัด) — ค่าอื่นที่รอด filter (ว่าง, `N`, `E`, …) ยังนับได้ตามปกติถ้ามีสต็อก
  ผลพลอยได้: PBM ไฟล์เก่าที่ไม่มี `cat` ให้ผลเท่ากติกาเดิมเป๊ะ **จึงไม่ต้องมี feature flag / migration**
- ⚠️ **ห้ามเก็บ `cat` ให้ทุกแถว** — `{branch}_pm` มีเพดาน 1 MiB เหมือน `global_r05` ที่เคยชนแล้วเงียบ
- doc เก็บ `cat_coded:true` เป็น **marker สำหรับดูบน Firebase Console เท่านั้น** ว่าสาขาไหนอัปไฟล์รุ่นใหม่แล้ว — ไม่มีโค้ดอ่าน อย่าเอาไปทำ logic
- toast ตอนอัปโชว์จำนวน A/B/C เสมอ · **เป็น 0 = ไฟล์ไม่มี Col D** ให้ตรวจไฟล์ก่อนใช้งานต่อ

## DEL Items

SKU อยู่ใน R01 แต่ไม่อยู่ใน Product Branch Master → `isDel: true` ใน `skuMap`
- ครอบทั้ง SKU ที่ **ไม่มีในไฟล์เลย** และ SKU ที่ **ถูกกรองออกด้วย Col D = D/P** → หลัง ส.ค. 2026 จำนวน DEL เพิ่มขึ้นมาก (ตั้งใจ)
- นับ + evaluate ปกติ · เข้าใบปรับสต็อก/Export ครบ · **ยังนับใน Total SKU / Progress** ถ้ามีสต็อก (`G ≠ 0`)
- ⚠️ `isDel` = "ไม่อยู่ใน PBM" **ไม่ใช่** "ไม่ต้องนับ" — สองเรื่องนี้แยกกันคนละแกน
- **badge แดง `DEL` ขึ้นทุกตัวที่ `isDel`** (`renderPopupTable`) แต่ **ปุ่ม filter 🗑️ DEL กรองด้วย `_countableSkus` ด้วย** (ส.ค. 2026)
  เจตนา: ปุ่มนี้คือ "งานที่ต้องเดินไปหา" ไม่ใช่รายงานสินค้านอกแคตตาล็อกทั้งหมด → DEL ที่ของหมดแล้วหรืออยู่ในหมวด `11.`/`DELETE` ไม่โผล่
  แก้ที่ `getFilteredPopupRows()` จุดเดียว จึงมีผลกับ **Export Excel ของ filter นี้ด้วย** (ตั้งใจ — filter chain ร่วมกัน)
- **filter `'pending'` (ปุ่ม ⏳ "เหลือ") = "ส่วนที่ยังไม่เข้าตัวเศษ Progress"** (ส.ค. 2026) —
  `_countableSkus.has(sku) && (status==='pending' || status==='scanning')`
  ⚠️ **ต้องตรงกับเงื่อนไข skip ใน `updateStats()` เป๊ะ** (ข้าม `pending`/`scanning`) เพื่อให้ **จำนวนแถว = ตัวหาร − ตัวเศษ** เสมอ
  - **ห้ามตัด `scanning` ออก** ไม่งั้นเกิดอาการ "สแกนจนรายการหมดแล้วแต่ Progress ไม่ถึง 100%" (ของที่รอ Confirm หายจากรายการแต่ยังไม่นับเป็นตัวเศษ)
  - **ห้ามถอด `_countableSkus`** ไม่งั้นรายการจะยาวกว่าที่เหลือจริง พนักงานเดินไปหาของที่ไม่ต้องนับ
  - label ปุ่มเป็น **"เหลือ"** ไม่ใช่ "รอนับ" เพราะรวมของที่สแกนแล้วรอ Confirm ด้วย · key ภายในยังเป็น `pending` (ชื่อไฟล์ Export `stock_pending` จึงไม่เปลี่ยน)
  - DEL ที่ยังต้องนับยังโผล่ในรายการนี้พร้อม badge ตามเดิม (July 2026 — เดิม exclude); ปุ่ม **🗑️ DEL** ใช้กรองดูเฉพาะ DEL

---

## Export Excel (3 ปุ่ม)

### 1. exportExcel() — popup toolbar
เนื้อหา: **ตรงกับปุ่ม filter ที่เลือกอยู่ในป็อปอัพเสมอ** (ใช้ `getFilteredPopupRows()` ตัวเดียวกับที่ตารางแสดงผล — รวม status filter + staff filter + คำค้นหา) ไม่ใช่ audit/stock_adj ตายตัวแบบเดิม
คอลัมน์: SKU, Barcode, ProductName, SystemQty, CountedQty, Status, Timestamp, Audit Status
ไฟล์: `audit_${date}.xlsx` เมื่อ filter เป็น Audit, อื่นๆ เป็น `stock_<filter>_${date}.xlsx` (เช่น `stock_p_${date}.xlsx`, `stock_del_${date}.xlsx`)

### 2. exportStockAdjExcel() — History Stats tab 🔴 Stock Adj
Layout เดียวกันทั้งสาขา/WH (10 คอลัมน์):
A=Location / B=SKU / C=Barcode / D=ProductName / E=หน่วย /
F=จำนวนคงเหลือ / G=จำนวนปรับปรุง / H=Diff (sysQty−recheckQty; บวก=ขาด) /
I=พนักงานที่สแกน / J=เวลาที่นับ
ไฟล์: `stockadj_${branch}_${date}.xlsx`

### 3. exportHsCountExcel() — History Stats tab 👥 / 🧑‍⚕️
คอลัมน์: Location, SKU, Barcode, NAME, Unit, CountQty, SystemQty, Diff, ชื่อพนักงาน, เวลา

ชื่อพนักงาน:
- นับครั้งแรก: `scannedBy` (header WH "ชื่อผู้สแกน" / สาขา "ชื่อผู้ช่วย")
- รีเช็ค WH: **`recheckBy`** (ไม่ใช่ `auditor` ซึ่งเป็นหัวหน้าที่กดยืนยัน)
- รีเช็ค สาขา: `auditor` (เภสัชสแกนและยืนยันเอง)

ไฟล์: `count_` / `recheck_${branch}_${date}.xlsx`

### exportCountReportExcel() — History Stats tab 📋 (WH supervisor)

12 คอลัมน์ สร้างจาก `_buildCountReportRows()`:
A=วันที่สแกน (`firstScanAt` || `timestamp`) / B=Location / C=SKU / D=Barcode / E=Name /
F=SystemQty / G=หน่วย / H=Count / I=DIFF (countedQty−systemQty; บวก=เกิน) /
J=Recheck / K=DIFF Recheck / L=Check By

ไฟล์: `count_report_${branch}_${date}.xlsx`

---

## ปรับปรุงลดสินค้า — ORDS/IRPS popup (เภสัช + WH supervisor)

Panel-card `#adjustDocPanel` + popup `#adjustDocPopupOverlay` — แสดงเฉพาะ role ที่ยืนยัน
(`currentRole==='pharmacist' || 'supervisor'`) อยู่ใน `.left-panel` → **desktop-only** อัตโนมัติ (PDA ซ่อนทั้งคอลัมน์)

**รายการที่แสดง:** เฉพาะ `status==='stock_adjustment'` แยก 2 แท็บด้วยทิศของ diff (`_buildAdjustDocRows(dir)`):
- **ORDS** = ขาด (count < systemQty) → ตัวเลขแดง
- **IRPS** = เกิน (count > systemQty) → ตัวเลขเขียว

⚠️ **diff convention ต้องตรงกับ `exportStockAdjExcel()`:** count = `recheckQty ?? countedQty`, diff = `count − systemQty`,
จำนวนที่แสดง = `Math.abs(diff)` — ถ้าแก้ convention ที่ `exportStockAdjExcel` **ต้องแก้ที่นี่ด้วย** ไม่งั้นตัวเลข 2 ที่ไม่ตรงกัน

**คอลัมน์:** ลำดับ / รหัสสินค้า(SKU) / ชื่อสินค้า / หน่วย(`skuDirectMap`) / จำนวน / ราคา / LOT / EXP / รวมเงิน
→ ราคา + รวมเงิน จาก R05.105 · **EXP จาก R14.102 (ของ LOT ที่เลือก)** · ช่องที่ยังไม่แนบไฟล์ = `—`

**ปุ่ม 📂 แนบไฟล์ LOT/EXP R14.102 (`handleAdjLotFile`):**
- ไฟล์ **ColJ=SKU, ColL=LOT, ColB=EXP** (ไม่ skip header — ค่า SKU ในแถว header ไม่ตรง adjustment set เลยถูกกรองทิ้งเอง)
- อ่านผ่าน `parseFile` กรอง **เฉพาะ SKU ที่ `stock_adjustment` ตอนอ่าน** → `_lotMap: Map<SKU, [{lot, exp}]>` (ไฟล์ใหญ่เหลือหลักสิบ–ร้อย)
- คอลัมน์ LOT = `<select>` ต่อ SKU (1 SKU หลาย LOT), เลือกแล้วเก็บใน `_lotSelected` + **คอลัมน์ EXP โชว์ `exp` ของ LOT ที่เลือก** (`onAdjLotSelect` สั่ง re-render)
- render normalize format เก่า (`_lotMap` เคยเก็บ string) → `_adjlot` doc ที่ sync ไว้ก่อนเปลี่ยนยังโหลดได้ไม่ crash

**ปุ่ม 💵 แนบไฟล์ราคา R05.105 (`handleAdjPriceFile`):**
- **ColB=SKU, ColE=หน่วย, ColH=ราคา, กรองเฉพาะแถว `ColF===4`** → `_priceMap: Map<SKU, {unit, price}>` (กรองเฉพาะ SKU ที่ปรับ เหมือน LOT)
- หน่วยใช้ R05.105 ก่อน fallback `skuDirectMap`; ราคา raw (ไม่ใส่ comma); รวมเงิน = ราคา × จำนวน

**ปุ่ม 💾 บันทึก LOT (`saveAdjustDocToCloud`) — Sync ข้ามเครื่อง:**
- เขียน `_lotMap`+`_lotSelected`+`_priceMap` (JSON strings) ลง doc แยก **`${branch}_adjlot`** — **เขียนตอนกดบันทึกเท่านั้น** (ไม่ใช่ทุก 3 วิ)
- เครื่องอื่นเปิด popup → `openAdjustDocPopup` (async) เรียก `loadAdjustDocFromCloud` **เฉพาะเมื่อ local ว่าง** (กันทับงานที่กำลังแนบค้างในเครื่องตัวเอง)
- ⚠️ sync ได้เพราะ **กรองเหลือเฉพาะ SKU ที่ปรับ = เล็ก** — **ไฟล์ raw 200k ห้ามขึ้น cloud** (ดู Known Pitfalls)
- ล้าง local ตอน logout (`updateAdjustDocPanel`) · ล้าง local + ลบ cloud doc ตอน `startNewCount`

**ปุ่ม ⬇️ Export Text (`exportAdjustDocText`):** ตามแท็บที่เลือก · format `SKU⇥จำนวน⇥ราคา⇥⇥⇥⇥⇥⇥LOT⇥EXP` (1,1,6,1 TAB) · CRLF · ไฟล์ `stockadj_<ords|irps>_<date>.txt`
- EXP = ของ LOT ที่เลือก แปลงเป็น `DD/MM/YYYY` ปี **พ.ศ.** (`_toBeDMY`, +543 จากปี ค.ศ. ที่ `parseTranDate` parse ได้) — ว่างถ้ายังไม่เลือก LOT หรือ parse วันที่ไม่ได้

---

## Persistence Layers

| Layer | Key/Path | เมื่อไหร่เขียน |
|---|---|---|
| localStorage | `stockCountSession_${branch}` | ทุก `saveSession()` debounce 400ms |
| Firestore `stock_sessions/${branch}` | scan data | 3s หลัง localStorage |
| Firestore `stock_sessions/${branch}_r01` | R01 master + R16 upload metadata | หลัง upload R01; R16: `r16UploadedAt`/`r16Loaded` merge เข้า `_r01` doc ทุกครั้ง `loadR16()` |
| Firestore `stock_sessions/${branch}_adjlot` | LOT+ราคา ใบปรับปรุง (เฉพาะ SKU ที่ปรับ) | **กดปุ่ม 💾 บันทึก LOT เท่านั้น**; อ่านตอนเปิด popup ถ้า local ว่าง |
| Firestore `stock_sessions/${branch}_pm` | **Product Branch Master** — catalog ต่อสาขา รวม WH (ส.ค. 2026 — เดิม `global_pm` ใช้ร่วมกัน) | หลัง PM upload; real-time listener · **ไม่ persist localStorage** ทุก reload ดึงจาก cloud |
| Firestore `stock_sessions/global_r05` | R05 Barcode mapping (ใช้ร่วมทุกสาขา ก.ค. 2026 —เดิม `${branch}_r05`) | หลัง R05 upload (`loadR05`); real-time listener (`startR05Listener`, mirror PM) |
| Firestore `stock_sessions/WH_location` | Location + zone-staff | หลัง Save ใน Location popup |
| Firestore `stock_audit_log/${branch}_${date}` | Audit log | หลัง evaluatePendingScans + verify + recheck confirm |

**Persisted scan fields:** `scannedBy`, `auditor`, `recheckQty`, `recheckBy`, `initialStatus`, `firstScanAt`
Strip เฉพาะ: `retries`, `scans`

⚠️ **ไม่มี history snapshot** — Export Excel ก่อนกด "เริ่มนับใหม่"
⚠️ `startNewCount()` ลบ `${branch}_r01` (ล้าง `r16UploadedAt`/`r16Loaded` อัตโนมัติ) **+ `${branch}_adjlot`** (LOT/ราคารอบเก่า) + ล้าง `_lotMap`/`_lotSelected`/`_priceMap` local — ไม่ลบ `global_r05` (shared ทุกสาขา)
⚠️ `clearAllData()` (admin PIN) ก็**ไม่ลบ** `global_r05` และ `${branch}_pm` — ล้างแค่ local state, resync กลับจาก cloud ตอน reload
⚠️ `global_pm` เดิมเป็น **legacy read-only** ไม่มีโค้ดอ่าน/เขียนแล้ว **ห้ามลบบน cloud** (เส้นชีวิตของ rollback) และ **ห้ามใส่ fallback กลับไปอ่าน** — สาขาที่ยังไม่อัป PBM ต้องเห็น badge "ยังไม่โหลด"
⚠️ ลำดับ: `syncToFirestore(true)` → `rebuildMaps()` (scanData ว่างก่อน)
⚠️ **ไฟล์ raw LOT/ราคา (200k แถว) ห้ามขึ้น cloud** — sync เฉพาะ "ผลกรอง" (`_lotMap`/`_lotSelected`/`_priceMap` ของ SKU ที่ปรับ = เล็ก) ผ่านปุ่ม 💾 บันทึก → `${branch}_adjlot` ดู Known Pitfalls

---

## Known Pitfalls

**R16 upload date ไม่ตรงกันข้ามเครื่อง (มิ.ย. 2026, แก้แล้ว):**
- **อาการ:** เครื่อง A อัพ R16 วันนี้ badge ขึ้นวันที่ใหม่ แต่เครื่อง B สาขาเดียวกันยังเห็นวันที่เก่าเป็นเดือน
- **สาเหตุ:** `r16UploadedAt` เดิมเก็บใน session doc (`stock_sessions/${branch}`) ใบเดียวกับ scanData — ทุกเครื่องที่สแกนแล้ว trigger `syncToFirestore()` (ทุก ~3s) ดันค่า `r16UploadedAt` ของตัวเอง (อาจเก่าค้าง) ทับ cloud แบบ last-write-wins ไม่เทียบว่าใหม่กว่าใคร + `restoreFromFirestore()` รีเฟรช badge จาก cloud แค่ครั้งเดียวตอน `r16Loaded` เปลี่ยน false→true เครื่องที่เคยโหลด R16 แล้วจะไม่เช็ค cloud ซ้ำอีกเลย
- **แก้:** ย้าย `r16UploadedAt`/`r16Loaded` ไปเก็บใน master doc เดียวกับ R01 (`${branch}_r01`) เขียนผ่าน `syncR16MetaToFirestore()` (เรียกจาก `loadR16()` เท่านั้น ไม่ถูก sync รอบสแกนแตะ) + อ่านกลับทุก login ผ่าน `_applyR16MetaFromDoc()` ใน `restoreMasterFromFirestore()` — pattern เดียวกับที่ R01 ใช้อยู่แล้ว
- **ผลข้างเคียงที่ต้องรู้:** `syncMasterToFirestore()` เปลี่ยนเป็น `.set(...,{merge:true})` ไม่งั้น R01 re-upload จะลบ field r16 ที่เพิ่งเขียนทิ้งไปด้วย
- **Transitional:** สาขาที่ยังไม่มีใครอัพ R16 ใหม่หลัง deploy fix นี้ — `_r01` doc จะยังไม่มี field `r16UploadedAt` → `_applyR16MetaFromDoc` guard (`r16UploadedAt===undefined`) ข้ามไปเฉยๆ ไม่เด้ง badge ผิด จะ sync ถูกต้องทันทีที่มีคนอัพ R16 ครั้งต่อไปของสาขานั้น

**ไฟล์ LOT 200k+ แถว — ห้ามยัดเข้า pattern sync เดิม (ก.ค. 2026):**
- ไฟล์ LOT จริงมี **200,000+ แถว** (ทุก LOT ทั้งระบบ)
- master file เดิม (R01/R05) เก็บเป็น JSON string ก้อนเดียวใน 1 Firestore doc (`data_json`) — Firestore จำกัด **1 MB/doc ตายตัว**, localStorage ~5–10 MB
- 200k แถวเป็น JSON ~10–40 MB → `.set()` **throw ทั้งก้อน** / `QuotaExceededError` + stringify ทุก `saveSession` = แอปค้าง
- **วิธีที่ใช้:** ใบปรับปรุงมีแค่ item `stock_adjustment` (หลักสิบ–ร้อย) → `handleAdjLotFile()` กรองเฉพาะ SKU เหล่านั้น**ตอนอ่าน** เก็บ `_lotMap` in-memory เท่านั้น ไม่ sync ไม่ persist
- **Cross-device sync (ทำแล้ว ก.ค. 2026):** ปุ่ม 💾 บันทึก LOT → `saveAdjustDocToCloud()` เก็บ **เฉพาะผลกรอง** (`_lotMap`/`_lotSelected`/`_priceMap` ของ SKU ที่ปรับ ~ร้อยแถว) ลง doc เดียว `${branch}_adjlot` (JSON strings) เขียนตอนกดเท่านั้น + อ่านตอนเปิด popup ถ้า local ว่าง — **ยังคงห้ามเอาไฟล์ raw ทั้งก้อนขึ้น cloud**

**Audit count ไม่ตรงข้ามเครื่อง — badge R16 sync แต่การคำนวณไม่ sync (ก.ค. 2026, แก้บางส่วน):**
- **อาการ:** เภสัชเปิดหลาย browser/เครื่อง เห็นจำนวน Audit ไม่เท่ากัน (เช่น 36 / 19 / 19) ทั้งที่ badge วันที่ R16 ตรงกันหมด
- **สาเหตุ:** audit/pass เป็น **derived state คิด local ต่อเครื่อง** ผ่าน `reEvaluateAuditItems()` จาก `r16SalesMap` ของเครื่องนั้น — แต่ที่ sync ข้ามเครื่องคือ **แค่ป้ายวันที่** (`_applyR16MetaFromDoc` เขียน badge + `_setR16Ts` เท่านั้น ไม่โหลดยอด ไม่ re-evaluate). ⚠️ **วันที่บน badge ไม่ได้แปลว่าเครื่องนั้นคิด audit ด้วย R16 นั้นแล้ว**
- **ทำไมค้าง:** (1) guard `!state.r16Loaded` ใน `restoreFromFirestore` บล็อกไม่ให้เครื่องที่ `r16Loaded=true` รับ R16 ใหม่ (2) listener `_applyCloudScanData` ไม่แตะ R16 เลย (3) merge เป็น **one-way** — cloud audit ดัน local เป็น audit ได้ แต่ cloud pass/pending ไม่เคยดึง local audit กลับ (+ guard `5f8649d` กัน local audit ทับ cloud pass) → เครื่องที่คิด audit เกินไว้ไม่มีทางกลับ
- **แก้ (ขอบเขต "ข้อ 2" เท่านั้น):** ใน `restoreFromFirestore` early-return path **เฉพาะสาขายา (`_isPharmacyBranch`)** → refresh `r16SalesMap`/`r16InboundMap` จาก cloud แม้ `r16Loaded` แล้ว + เรียก `reEvaluateAuditItems({silent:true})` (ข้าม item ที่มี `auditor` → ไม่ revert งาน verify) — เครื่องแก้เองตอน **login/reload** (deploy ครั้งถัดไป PWA reload → หายรอบแรก)
- **ข้อจำกัดที่ยังเหลือ:** (1) **ไม่ live** — ถ้าอัป R16 ใหม่กลางวันตอนเภสัชเปิดจอค้าง จอนั้นหายต่อเมื่อ reload (2) ใช้ **ยอดรวม** ไม่กรอง TRANDATE เพราะ `r16RawMap` ไม่ sync (in-memory) → เครื่องที่รับ R16 ผ่าน sync คิดจากยอดขายรวม ส่วนเครื่องที่อัปไฟล์เองกรองเวลา (ถ้าต้องเป๊ะทุกเครื่องต้อง sync `r16RawMap` ผ่าน master doc — "ข้อ 3")
- **WH ไม่แตะ** — gate `_isPharmacyBranch()` ทั้งหมด flow ยืนยัน/รีเช็ค WH เหมือนเดิม

---

## CSV/Excel Parsing

`parseFile()` รองรับ `.csv` และ `.xlsx`/`.xls`
CSV encoding auto-detect: UTF-8 BOM → UTF-8 → Windows-874 (Thai Excel default)

---

## Location Master (WH only)

Firestore: `stock_sessions/WH_location` — `{locationData:{SKU:loc}, zoneStaff:{zone:staff}, updatedAt}`

**CSV Import format:**
| Col | Index | เนื้อหา |
|---|---|---|
| A | 0 | SKU หรือ Barcode |
| E | 4 | **Location** |

Header auto-detect (ข้ามแถวที่ col A = `sku`, `barcode`, `รหัสสินค้า`, `location`)
SKU lookup: `productMasterMap` → `barcodeMap` → `skuMap`

Zone: A–O (15 โซน), Staff: มุก/ตั๋ง/แล็ค
`_LOCATION_ZONES = ['A'...'O']`

---

## Firebase Config

Project: `stock-count-1d6e7`
`FIREBASE_CONFIG` hardcoded ใน `index.html`
ใช้แค่ Firestore (ไม่มี Auth, Storage, Functions)
