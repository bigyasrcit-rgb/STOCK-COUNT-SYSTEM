# auto-r01 — สถานะและวิธีปิดฉุกเฉิน

**สถานะ (26 ส.ค. 2026):** บั๊ก latent ทั้งหมดแก้แล้ว · สคริปต์ครอบ **4 branch (WH/SRC/KKL/SSS)**
เหลือขั้นตอนที่ต้องทำที่เครื่อง `BigYa-spare` เอง: ทดสอบรันจริง + `Register-ScheduledTask` (ดู `README.md`)

---

## ⛔ ปิดฉุกเฉิน

```powershell
Disable-ScheduledTask -TaskName "AutoR01Import"
```
ปิดเฉพาะบาง branch: เอาชื่อออกจาก `AUTO_BRANCHES` ในหัวไฟล์ `auto_r01_import.py` (ไม่ต้องแตะโค้ดอื่น)

**อาการที่ควรปิดทันที:** Confirm ขึ้น `R01/R16 ในเครื่องไม่ตรงกับ Cloud` ซ้ำๆ ทุกเครื่อง ·
`{branch}_r01` มี field หายไปหลังสคริปต์รัน · ยอด `systemQty` บนเว็บไม่ตรงกับ POS

---

## บั๊ก 4 ข้อที่แก้ไปแล้ว (เก็บไว้กันทำพลาดซ้ำ)

| # | ปัญหาเดิม | แก้ที่ |
|---|---|---|
| 1 | PATCH ทั้ง document → ลบ `r01Version`, `r16UploadedAt`, `r16Loaded`, `r16DetailVersion`, `r16_103*` ทิ้งทุกครั้ง | `write_branch()` ส่ง `updateMask` จาก `WRITE_FIELDS` แล้ว |
| 2 | ไม่เขียน `r01Version` → `_branchConfirmVersions()` ไม่ตรง → `BRANCH_CONFIRM_VERSION_MISMATCH` ทุกวัน | เขียน `r01Version` + `r01BaselineAt` เป็น ISO UTC ms |
| 3 | ไม่แตะ session doc → `r01BaselineAt` ไม่ขยับ → `_clearR16ForNewBaseline()` ไม่ทำงาน | พา baseline ผ่าน **master doc** แทน + listener ฝั่งสาขายา adopt (`index.html` `startWhMasterListeners`) · **ยังห้ามแตะ session doc** เพราะ `scanData` ฝังอยู่ในก้อนเดียวกัน (schema v1) |
| 4 | เครื่องที่มี R01 ค้างอยู่ไม่โหลด R01 ใหม่ — badge ขึ้น `Ready` + เวลาวันนี้ แต่ `skuMap` เป็นของเมื่อวาน | `restoreMasterFromFirestore()` else-branch โหลด `data_json` เมื่อ `r01Version` ต่าง |

### บั๊กข้อ 5 ที่เจอเพิ่มตอนแก้ (ไม่ได้อยู่ในลิสต์เดิม และหนักที่สุด)

`parse_file()` เดิมมี `if qty <= 0: continue` ซึ่งขัดกับ `SKILL-data-files.md` (*"qty ≤ 0 เก็บไว้ด้วยค่าจริง ไม่ clamp"*)
และกติกา ส.ค. 2026 ที่ `_countableSkus` = `G ≠ 0` **หรือ** PBM Col D ∈ `{A,B,C,REVIEW}`

วัดจากไฟล์จริง จะทิ้ง **WH 4,322 · SRC 2,353 · KKL 1,411 · SSS 356 แถว** = ของที่ต้องเดินไปนับหายเกือบครึ่ง
และ `negSys` (G ติดลบ = ขายของขาด) หายหมด → เภสัชไม่มีวันได้ตรวจ

⛔ **ห้ามใส่กติกากรอง qty กลับเข้าไปทุกกรณี** — `parse_qty()` คืน `None` เฉพาะค่าว่าง/ไม่ใช่ตัวเลข เท่านั้น

---

## Parity กับ `loadR01()` — ตรวจแล้ว 26 ส.ค. 2026

สคริปต์ต้องให้ผล **เท่ากับ `loadR01()` ใน `index.html` ทุกไบต์** วิธีตรวจคือดึงโค้ดจริง 3 ก้อนออกมาจาก `index.html`
(`R01_NON_COUNT_PREFIXES`/`KEYWORDS`, `_isNonCountR01Category()`, ลูป `for(let i=1;...)` ใน `loadR01`)
รันด้วย `new Function()` บน Node แล้วเทียบ `JSON.stringify()` กับผลของ `parse_file()`

ผลล่าสุด — ตรงกันทุกไบต์ทั้ง 4 branch (WH 6,653 · SRC 5,348 · KKL 3,912 · SSS 3,138)
และ edge case 17 แบบ (qty ว่าง/ติดลบ/0/ทศนิยม/มีคอมม่า/`1e2`/SKU ว่าง/หมวด `DELETE` ตัวเล็ก-ใหญ่/หมวดว่าง)

**ถ้าแก้กติกา parse ฝั่งใดฝั่งหนึ่ง ต้องแก้อีกฝั่งพร้อมกันเสมอ** จุดที่ผูกกัน:
`R01_NON_COUNT_PREFIXES` / `R01_NON_COUNT_KEYWORDS` / index คอลัมน์ / กติกา `parse_qty`

> ⚠️ หมวด `อุปกรณ์สำนักงาน / ค่าใช้จ่าย / ขนส่ง` (275 แถว) **ไม่มีเลข `11.` นำหน้า** จึงไม่ติดธง `nc`
> ทั้งในเว็บและในสคริปต์ — เป็นพฤติกรรมเดิมของระบบ ไม่ใช่ของใหม่ ถ้าจะให้จับต้องแก้ทั้งสองฝั่งพร้อมกัน

---

## หมายเหตุเรื่องเครื่อง

- แก้ `index.html` — ทำที่เครื่องไหนก็ได้
- ทดสอบสคริปต์ + ตั้ง Task Scheduler — ทำที่เครื่องไหนก็ได้ที่มีไฟล์ `Allstock*.csv` จริง
  โฟลเดอร์ CSV **ไม่ฮาร์ดโค้ดชื่อผู้ใช้แล้ว** (ส.ค. 2026) — หาจาก `%USERPROFILE%\Desktop\run-upload-stock`
  หรือ override ด้วย `AUTO_R01_WATCH_FOLDER` / `--folder` ดู `README.md` §ติดตั้งบนเครื่องอื่น
- ⚠️ **ให้มีเครื่องเดียวที่ `Enable` Task ไว้** — สคริปต์ไม่มี lock ระหว่างเครื่อง สองเครื่องรันเช้าเดียวกัน
  = เขียนทับกัน 2 รอบ + ทุกเครื่องที่เปิดเว็บโดนล้าง R16 สองครั้ง

## ⚠️ `run_auto_r01.bat` ต้องเป็น ASCII ล้วน

ห้ามใส่ภาษาไทยลงไฟล์ `.bat` เด็ดขาด — cmd.exe อ่านไฟล์แบบนับ byte offset ตัวอักษร multi-byte
ทำให้ parser หลุด แล้วบรรทัดถูกฉีกเป็นคำสั่งขยะ (เจอจริง ส.ค. 2026: รุ่นที่มี REM ภาษาไทยรันไม่ผ่านเลย
ซึ่งอธิบายว่าทำไม `auto_r01.log` ไม่เคยถูกสร้างมาก่อน) · คำอธิบายภาษาไทยอยู่ใน `README.md` แทน

กับดักที่สองในไฟล์เดียวกัน: **ห้ามเขียน `echo ... %VAR%>> "%LOG%"`**
ถ้าค่าลงท้ายด้วยตัวเลข cmd จะอ่าน `0>>` เป็น redirect ของ file descriptor แล้วข้อความหลุดออกคอนโซลแทนที่จะลง log
ให้วาง redirect ไว้หน้าแทน: `>>"%LOG%" echo ...`
