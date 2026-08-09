# ⚠️ auto-r01 ยังห้ามเปิดใช้ — ต้องแก้ 4 จุดก่อน

**สถานะ (9 ส.ค. 2026):** สคริปต์เขียนเสร็จแล้วแต่ **ไม่เคยเปิดใช้งาน** · ตรวจโค้ดแล้วพบว่า **ถ้าเปิด Task Scheduler ตอนนี้จะพัง** เพราะรูปแบบที่สคริปต์เขียนไม่ตรงกับที่ `index.html` คาดหวัง

> ไม่เกี่ยวกับเคส SKU 200379 (7 ส.ค.) — วันนั้น `r01Version` เป็น ISO จริงซึ่งผลิตได้จาก `loadR01()` เท่านั้น = อัพมือผ่านเว็บ · ต้นเหตุเคสนั้นคือ R16 export ครอบถึงแค่ 13:26

---

## บั๊ก latent 4 ข้อ (ยืนยันจากโค้ดแล้ว)

| # | ปัญหา | หลักฐาน |
|---|---|---|
| 1 | PATCH ทั้ง document → **ลบ `r01Version`, `r16UploadedAt`, `r16Loaded`, `r16DetailVersion`, `r16_103*` ทิ้งทุกครั้ง** | `write_branch()` ไม่ส่ง `updateMask` · ฝั่งเว็บ `syncMasterToFirestore()` ใช้ `merge:true` พร้อมคอมเมนต์เตือนเรื่องนี้ตรงๆ |
| 2 | ไม่เขียน `r01Version` | แอปใช้ field นี้ตรวจก่อน Confirm (`_branchConfirmVersions()`) |
| 3 | ไม่แตะ session doc → `r01BaselineAt` ไม่ขยับ → `_clearR16ForNewBaseline()` ไม่ทำงาน | ทั้ง 5 จุดที่เรียก `_applyR01BaselineUpdate()` อ่าน `s.r01BaselineAt` จาก **session doc** |
| 4 | **เครื่องที่มี R01 ค้างอยู่ ไม่โหลด R01 ใหม่เลย** — badge ขึ้น `Ready` + เวลาวันนี้ แต่ `skuMap` ยังเป็นของเมื่อวาน | `restoreMasterFromFirestore()` มี else-branch *"มี local data แล้ว — อ่านแค่ timestamp (ไม่โหลด data_json)"* · listener ของสาขาอัปเดตแค่ badge |

**ผลรวมถ้าเปิดใช้:** `_branchConfirmVersions()` อ่าน meta จาก master doc ที่เพิ่งถูกลบ → เทียบกับ local ไม่ตรง → **`BRANCH_CONFIRM_VERSION_MISMATCH` ทุกวัน** · และถ้าเลี่ยงได้ ก็ยังคำนวณด้วย `systemQty` ของเมื่อวาน

> README เดิมเขียนสมมติฐานว่า *"ปกติแต่ละเช้าเป็นรอบนับใหม่จึงไม่ค่อยเป็นปัญหา"* — **ไม่จริงแล้ว** รอบนับปัจจุบัน `countResetAt` = 5 ส.ค. กินหลายวัน เครื่อง login ค้างข้ามวัน

---

## สิ่งที่ต้องแก้

### 1. สคริปต์ `auto_r01_import.py` → `write_branch()`

**1a. ใส่ `updateMask` ใน query string** — ไม่งั้น PATCH = replace ทั้ง document
```
?updateMask.fieldPaths=data_json&updateMask.fieldPaths=r01UploadedAt
&updateMask.fieldPaths=r01Version&updateMask.fieldPaths=r01BaselineAt
&updateMask.fieldPaths=updated_at&key=…
```

**1b. เขียน `r01Version` + `r01BaselineAt` เพิ่ม** — ISO UTC มิลลิวินาที ให้ตรงรูปแบบกับ `new Date().toISOString()` ที่ `loadR01()` ใช้:
```python
iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
# ใช้ค่าเดียวกันทั้ง r01Version และ r01BaselineAt
```

**1c. ❌ ห้ามแตะ session doc** — `r01BaselineAt` ของเดิมฝังอยู่ใน `session_data_json` ซึ่งมี `scanData` ปนอยู่ในก้อนเดียวกัน · การอ่าน-แก้-เขียนกลับจากสคริปต์เสี่ยงทับยอดสแกนของพนักงาน → จึงพา baseline ผ่าน **master doc** แทน (คู่กับข้อ 2a)

### 2. แอป `index.html` ⚠️ scan-related — ต้องขอ approve ตามกฎ 1 ก่อนแก้

**2a. listener ของสาขา adopt baseline จาก master doc**
จุดที่ตอนนี้อัปเดตแค่ badge (บล็อก `if(currentBranch!=='WH'){…onSnapshot…}` ใน `startWhMasterListeners`):
```js
// เพิ่ม: ถ้า data.r01BaselineAt ใหม่กว่า _r01BaselineAt → _applyR01BaselineUpdate(data.r01BaselineAt)
```
ใช้ `_applyR01BaselineUpdate()` ที่มีอยู่แล้ว — โหลด R01 จาก `{branch}_r01` + `rebuildMaps()` + `_clearR16ForNewBaseline()` + toast ครบในตัว **ไม่ต้องเขียน logic ใหม่**

- field `r01BaselineAt` ไม่มีในเอกสารที่เว็บเขียน → `undefined` → no-op → **ปลอดภัยแม้ยังไม่เปิดสคริปต์**
- หลัง adopt แล้ว `syncToFirestore()` จะพา `_r01BaselineAt` ลง session doc เอง → เครื่องอื่นได้ต่อผ่านเส้นทางเดิม

**2b. `restoreMasterFromFirestore()` else-branch โหลด R01 ใหม่เมื่อ version ต่าง**
ปัจจุบันข้าม `data_json` เสมอเมื่อ local มีข้อมูล → login ใหม่ก็ยังได้ R01 เก่า
เงื่อนไข: `r01Doc.data().r01Version` มีค่า **และต่างจาก** `state.r01Version` → โหลด `data_json` + `rebuildMaps()`

### 3. เอกสาร
- `README.md` ในโฟลเดอร์นี้ — ลบสมมติฐาน *"แต่ละเช้าเป็นรอบนับใหม่"* · ระบุว่าสคริปต์เขียน `r01Version`/`r01BaselineAt` และแอปใช้ตัวไหน trigger reload
- `.claude/skills/SKILL-data-files.md` § R01 Daily Baseline — เพิ่มว่ามี **2 เส้นทาง**: อัพมือ → session `r01BaselineAt` · ออโต้ → master doc `r01BaselineAt` · ทั้งคู่ลงเอยที่ `_applyR01BaselineUpdate()`

---

## ลำดับ rollout (ห้ามสลับ)

1. **แก้ + deploy แอปก่อน** (2a/2b) — ไม่มีผลอะไรจนกว่าสคริปต์จะเขียน field ใหม่
2. แก้สคริปต์ (1a/1b) → `--dry-run` → รันจริง → **เปิด Firestore Console เช็คว่า field R16 ยังอยู่ครบ**
3. **ค่อยเปิด Task Scheduler** — เปิดวันที่ไม่มีการนับ เพื่อดูผลก่อน

## Verification

**ขั้น 1 — สคริปต์ไม่ลบ meta**
1. บนเว็บ อัพ R16 ปกติ → ยืนยันใน Console ว่า `{branch}_r01` มี `r16Loaded`, `r16DetailVersion`, `r16UploadedAt`
2. `python auto_r01_import.py --dry-run` → ตรวจยอดต่อสาขา
3. รันจริง → **field R16 ทั้งชุดต้องยังอยู่** + มี `r01Version`/`r01BaselineAt` ใหม่
   - ถ้า field R16 หาย = `updateMask` ยังไม่ถูก **ห้ามไปต่อ**

**ขั้น 2 — แอป adopt baseline**
4. เปิดแอป 2 เครื่อง login สาขาทดสอบ ค้างไว้
5. รันสคริปต์ → ทั้งสองเครื่องต้อง: โหลด R01 ใหม่ (เช็ค `state.skuMap.get(sku).systemQty`), badge R16 = `ยังไม่โหลด`, ปุ่ม Confirm ถูกล็อก, มี toast แจ้ง
6. อัพ R16 ใหม่ → Confirm → **ต้องไม่เจอ `BRANCH_CONFIRM_VERSION_MISMATCH`**

**ขั้น 3 — Regression**
7. อัพ R01 **ด้วยมือ** ผ่านเว็บ → ทำงานเหมือนเดิมทุกประการ (เส้นทาง session ไม่ถูกแตะ)
8. WH ไม่กระทบ (สคริปต์ข้าม Warehouse อยู่แล้ว · 2a gate เฉพาะ non-WH)
9. เครื่องที่ยังไม่ deploy โค้ดใหม่ → มองข้าม `r01BaselineAt` ไม่ error
10. syntax check inline JS + `git diff --check`

---

## หมายเหตุเรื่องเครื่อง

- แก้ `index.html` (ข้อ 2) — ทำที่เครื่องไหนก็ได้
- แก้สคริปต์ + ทดสอบ (ข้อ 1) — **ต้องทำที่เครื่อง `BigYa-spare`** เพราะไฟล์ `Allstock*.csv` จริง, Task Scheduler และ `auto_r01.log` อยู่ที่นั่น
