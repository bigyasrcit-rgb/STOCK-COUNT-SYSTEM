# Auto R01.102 Import → Firestore

ดึงไฟล์ `Allstock.CSV` (R01.102 รวมทุก branch) ที่ POS export มาวางในโฟลเดอร์
แล้วแยกตาม **Col D (`CF_WNAME`)** เป็น 4 branch เขียนเข้า Firestore โดยอัตโนมัติทุกวัน **08:10**
— ไม่ต้องเปิดเว็บ ไม่ต้องอัปไฟล์เอง

| Col D ในไฟล์ | → Firestore doc | แถวจริง (มิ.ย. 2026) |
|---|---|---|
| `Warehouse` | `stock_sessions/WH_r01` | 6,653 |
| `Front Store` | `stock_sessions/SRC_r01` | 5,348 |
| `Main KKL` | `stock_sessions/KKL_r01` | 3,912 |
| `Main SSS` | `stock_sessions/SSS_r01` | 3,138 |

⚠️ **ต้องแยกไฟล์ก่อนเขียนเสมอ** — ในไฟล์เดียวมี SKU unique 6,687 ตัว และ **5,373 ตัวโผล่ใน ≥2 branch**
ถ้าอัป `Allstock.CSV` ทั้งไฟล์ผ่านหน้าเว็บ `qtyMap.set()` ใน `_rebuildCountableSkus()` เป็น last-wins
→ ทุกสาขาจะได้ยอดของ branch ที่อยู่ท้ายไฟล์ **ห้ามอัปไฟล์รวมผ่าน UI**

---

## ไฟล์ในโฟลเดอร์นี้

| ไฟล์ | หน้าที่ |
|---|---|
| `auto_r01_import.py` | สคริปต์หลัก (Python stdlib ล้วน — ไม่ต้องลง pip) |
| `run_auto_r01.bat` | ตัวเรียกสำหรับ Task Scheduler + เก็บ log (หมุนไฟล์ที่ 2 MB) |
| `auto_r01.log` | log การรัน (สร้างอัตโนมัติ) · รุ่นก่อนหน้าอยู่ที่ `auto_r01.log.1` |
| `TODO-safe-enable.md` | ประวัติบั๊กที่แก้ไปแล้ว + วิธีปิดฉุกเฉิน |

---

## ⚙️ ค่าที่ตั้งไว้ (แก้ได้ในหัวไฟล์ `auto_r01_import.py`)

```python
FILE_GLOB           = "Allstock*.csv"          # เลือกไฟล์ใหม่สุดที่ตรงรูปแบบ
AUTO_BRANCHES       = {"WH", "SRC", "KKL", "SSS"}   # ปิด branch ไหนก็เอาออกจาก set นี้
MIN_ROWS_PER_BRANCH = 500                      # น้อยกว่านี้ = ไฟล์ผิดปกติ ยกเลิกทั้งงาน
MAX_DOC_KB          = 950                      # เพดาน Firestore 1 MiB
```

**โฟลเดอร์ CSV ไม่ต้องแก้โค้ด** — หาอัตโนมัติตามลำดับ:

| ลำดับ | ที่มา | ใช้เมื่อ |
|---|---|---|
| 1 | `--folder "<path>"` | ทดสอบครั้งเดียว |
| 2 | ตัวแปรระบบ `AUTO_R01_WATCH_FOLDER` | เครื่องที่วางไฟล์ไว้ที่อื่น |
| 3 | `%USERPROFILE%\Desktop\run-upload-stock` | **ค่าปกติ** |

ข้อ 3 ทำให้ไฟล์ชุดเดียวใช้ได้ทุกเครื่อง เพราะทุกเครื่องวางไฟล์ที่ `Desktop\run-upload-stock` เหมือนกัน
ต่างกันแค่ชื่อผู้ใช้ (`BigYa-spare` / `AninMainPC` / …) · บรรทัดแรกของ log บอกเสมอว่ารอบนั้นใช้โฟลเดอร์ไหนและมาจากที่มาใด

---

## 🖥️ ติดตั้งบนเครื่องอื่น (เช่น `AninMainPC`)

> ⚠️ **อ่าน "รันหลายเครื่องพร้อมกัน" ท้ายหัวข้อนี้ก่อน** — ปกติควรมีเครื่องเดียวที่เปิด Task ไว้

**1. ก๊อปโฟลเดอร์ `auto-r01` ทั้งโฟลเดอร์** ไม่ใช่แค่ `.bat`
`run_auto_r01.bat` เรียก `auto_r01_import.py` ที่อยู่ข้างๆ กัน (`%~dp0`) — ขาดตัวใดตัวหนึ่งไม่ทำงาน
วางที่ไหนก็ได้ เช่น `C:\Users\AninMainPC\Desktop\auto-r01\`
(ถ้าเครื่องนั้นมี repo อยู่แล้วให้ `git pull` แทน จะได้อัปเดตตามได้)

**2. ตรวจว่ามี Python** — `.bat` หาให้เองจาก `C:\Program Files\Python311/312/313`, `PATH` แล้ว `py` launcher
ถ้าไม่มีจะเขียน `ERROR: Python not found` ลง log แล้วออกด้วย exit 9
ติดตั้งจาก <https://www.python.org/downloads/> แล้ว **ติ๊ก "Add python.exe to PATH"** · ไม่ต้องลง pip อะไรเพิ่ม

**3. ตรวจว่าไฟล์อยู่ถูกที่** — ถ้าเป็น `C:\Users\AninMainPC\Desktop\run-upload-stock\Allstock.CSV` ไม่ต้องตั้งอะไรเลย
ถ้าอยู่ที่อื่น ตั้งครั้งเดียว (แล้วเปิด CMD ใหม่):
```powershell
setx AUTO_R01_WATCH_FOLDER "D:\path\to\run-upload-stock"
```

**4. ทดสอบก่อน** (ไม่เขียน Firestore) — `--force` ใช้ข้าม guard "ไฟล์ต้องเป็นของวันนี้" ตอนทดสอบเท่านั้น
```powershell
cd "C:\Users\AninMainPC\Desktop\auto-r01"
.\run_auto_r01.bat --dry-run --force
Get-Content .\auto_r01.log -Tail 20
```
ต้องเห็นโฟลเดอร์ที่ถูกต้อง, `Col D ที่ map ไม่ได้` ไม่โผล่, และยอดครบ 4 branch

**5. ตั้ง Task Scheduler** ตาม §⏰ ด้านล่าง แก้แค่ path ใน `-Execute`

### รันหลายเครื่องพร้อมกัน

**ไม่แนะนำ** — สคริปต์ไม่มี lock ระหว่างเครื่อง ถ้าสองเครื่องรันเช้าเดียวกันจะเกิด:
- เขียน `{branch}_r01` ซ้อนกัน 2 รอบ ด้วย `r01Version`/`r01BaselineAt` คนละค่า
- ทุกเครื่องที่เปิดเว็บอยู่จะโหลด R01 ใหม่ **2 ครั้ง** และโดนล้าง R16 **2 ครั้ง** พร้อม toast ซ้ำ
- ถ้าเครื่องหนึ่งมี CSV เก่ากว่า → guard "ไฟล์เก่า" จะกันไว้ให้ แต่ถ้าทั้งคู่ไฟล์ของวันนี้แต่คนละเวลา export ยอดจะเป็นของเครื่องที่เขียนทีหลัง

**ให้เลือกเครื่องเดียวเป็นเจ้าภาพ** — ควรเป็นเครื่องที่เปิดตลอดเช้าและเป็นที่ที่ POS export ไฟล์ลงจริง
ย้ายเจ้าภาพ = ตั้ง Task บนเครื่องใหม่ แล้ว **ปิดของเครื่องเก่า**:
```powershell
Disable-ScheduledTask -TaskName "AutoR01Import"     # รันบนเครื่องเก่า
```
เครื่องสำรองติดตั้งไว้ได้แต่ให้ `Disable` ไว้ พอเครื่องหลักเสียค่อย `Enable-ScheduledTask`

---

## สิ่งที่สคริปต์เขียนลง `{branch}_r01`

เขียนแบบ **PATCH + `updateMask`** เท่านั้น (ระบุ field ที่แตะทุกตัวใน `WRITE_FIELDS`)
PATCH ที่ไม่มี `updateMask` = replace ทั้ง document → จะลบ field ที่เว็บเขียนไว้ทิ้ง

| field | ค่า | ใครใช้ |
|---|---|---|
| `data_json` | `[{colE,productName,systemQty[,nc]}]` ของ branch นั้น | `restoreMasterFromFirestore()`, `_applyWhR01Doc()` |
| `r01UploadedAt` | `HH:MM น. DD/MM/YYYY` | ป้ายเวลาใต้ปุ่ม R01 |
| `r01Version` | ISO UTC มิลลิวินาที (เช่น `2026-08-26T01:10:00.123Z`) | `_branchConfirmVersions()` ตรวจก่อน Confirm · `_applyWhR01Doc()` ใช้ตัดสินว่าจะ adopt ไหม |
| `r01BaselineAt` | **ค่าเดียวกับ `r01Version`** | trigger ให้ listener ของสาขายาเรียก `_applyR01BaselineUpdate()` |
| `r16Loaded`, `r16UploadedAt`, `r16DetailVersion` | `false`, `""`, `""` | ล้าง R16 เมื่อวาน — ตรงกับที่ `syncR16MetaToFirestore()` เขียนตอนอัพด้วยมือ |
| `r16_103*` | `false`, `""`, `""` | คู่ขนานสำหรับ WH |
| `updated_at` | timestamp | — |

**❌ สคริปต์ไม่แตะ session doc (`stock_sessions/{branch}`) เด็ดขาด** — `r01BaselineAt` เดิมฝังรวมกับ `scanData`
ในก้อน `session_data_json` (schema v1) การอ่าน-แก้-เขียนกลับเสี่ยงทับยอดสแกนของพนักงาน
จึงพา baseline ผ่าน master doc แทน แล้วให้ `syncToFirestore()` ของเครื่องที่ adopt แล้วพาลง session เอง

### แอปรับต่อยังไง

| branch | เส้นทาง |
|---|---|
| SRC/KKL/SSS | listener ของ `{branch}_r01` เห็น `r01BaselineAt` ใหม่ → `_applyR01BaselineUpdate(mb, data)` → โหลด R01 + `rebuildMaps()` + `_clearR16ForNewBaseline()` + toast |
| WH | `_applyWhR01Doc()` เห็น `r01Version` ใหม่กว่า → adopt `data_json` + `rebuildMaps()` · Supervisor เรียก `_loadWhR16CloudTimelines()` ต่อ ซึ่งเช็ค `meta.r01Version !== state.r01Version` แล้ว **ล้าง R16 ให้เอง** |
| ทุก branch ตอน reload หน้า | `restoreMasterFromFirestore()` โหลด `data_json` ใหม่เมื่อ `r01Version` บน cloud ต่างจากในเครื่อง |

---

## 🛡️ Guard 4 ชั้น

| guard | เงื่อนไข | ผล |
|---|---|---|
| ไฟล์เก่า | `mtime` ไม่ใช่วันนี้ | **ยกเลิกทั้งงาน** exit 4 · ข้ามด้วย `--force` (ทดสอบเท่านั้น) |
| Col D ใหม่ | `norm(Col D)` ไม่อยู่ใน `BRANCH_MAP` | **ยกเลิกทั้งงาน** exit 4 — POS เปลี่ยนชื่อคลัง/เพิ่มสาขา ต้องมีคนมาดูก่อน |
| branch แถวน้อย | แถว < `MIN_ROWS_PER_BRANCH` | **ยกเลิกทั้งงาน** exit 4 (ตรวจครบทุก branch **ก่อน** เขียนตัวแรก) |
| doc ใหญ่ | > `MAX_DOC_KB` | ข้าม **เฉพาะ branch นั้น** + exit 1 — branch อื่นยังได้ข้อมูลวันนี้ (ปัญหาการโต ไม่ใช่ไฟล์เพี้ยน) |

> guard "ไฟล์เก่า" สำคัญเป็นพิเศษเพราะ Task Scheduler ตั้ง `StartWhenAvailable` = รันชดเชยข้ามวันได้
> ถ้าไม่มี guard นี้ การเปิดเครื่องวันถัดไปจะเขียนข้อมูลเก่าทับแล้วล้าง R16 ของทุกเครื่องฟรี

**exit code:** `0` สำเร็จ · `1` เขียนบาง branch ไม่ผ่าน · `2` ไม่พบไฟล์ · `3` ไม่มีรายการที่ใช้ได้ · `4` guard ไม่ผ่าน

---

## ✅ ทดสอบก่อนใช้จริง (ไม่เขียน Firestore)

```powershell
python "C:\Users\BigYa-spare\Desktop\Stock-Count\auto-r01\auto_r01_import.py" --dry-run
```

ควรเห็นยอดใกล้เคียงตารางด้านบน และ **ไม่มีบรรทัด "Col D ที่ map ไม่ได้"**

## ▶️ รันจริง (เขียน Firestore)

```powershell
python "C:\Users\BigYa-spare\Desktop\Stock-Count\auto-r01\auto_r01_import.py"
```

---

## ⏰ ตั้งเวลา 08:10 ทุกวัน (Windows Task Scheduler)

ใช้ PowerShell — `schtasks` ตั้ง `StartWhenAvailable` (รันชดเชยเมื่อเครื่องปิด) ไม่ได้

### ขั้น 0 — ดูก่อนว่า POS export ไฟล์เสร็จกี่โมงจริงๆ

**สำคัญที่สุดและคนมักข้าม** — guard "ไฟล์ต้องเป็นของวันนี้" จะยกเลิกทั้งงานถ้าสคริปต์รันก่อน POS เขียนไฟล์เสร็จ
เช็คสัก 2–3 วันก่อนตั้งเวลา:

```powershell
(Get-Item "$env:USERPROFILE\Desktop\run-upload-stock\Allstock.CSV").LastWriteTime
```

ตั้งเวลา Task **หลังเวลานั้นอย่างน้อย 15 นาที** ถ้า POS เขียนเสร็จ 08:20 ก็ต้องเลื่อนไป 08:40 ไม่ใช่ 08:10

### ขั้น 1 — ทดสอบด้วยมือให้ผ่านก่อน

```powershell
cd "$env:USERPROFILE\Desktop\auto-r01"      # หรือ path ที่วางโฟลเดอร์ไว้จริง
.\run_auto_r01.bat --dry-run --force
Get-Content .\auto_r01.log -Tail 25 -Encoding UTF8
```

ต้องเห็นครบ 4 branch และไม่มีบรรทัด `Col D ที่ map ไม่ได้` — **ถ้าขั้นนี้ไม่ผ่าน อย่าเพิ่งตั้ง Task**

### ขั้น 2 — ลงทะเบียน Task

แก้ `$Root` บรรทัดแรกให้ตรงกับที่วางโฟลเดอร์จริง แล้ววางทั้งก้อนใน PowerShell:

```powershell
$Root = "$env:USERPROFILE\Desktop\auto-r01"          # <-- แก้บรรทัดนี้บรรทัดเดียว
$Bat  = Join-Path $Root "run_auto_r01.bat"
if (-not (Test-Path $Bat)) { throw "ไม่พบ $Bat" }

$A = New-ScheduledTaskAction -Execute $Bat -WorkingDirectory $Root
$T = New-ScheduledTaskTrigger -Daily -At 08:10
$S = New-ScheduledTaskSettingsSet `
       -StartWhenAvailable `
       -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
       -MultipleInstances IgnoreNew `
       -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
       -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 20)

Register-ScheduledTask -TaskName "AutoR01Import" -Action $A -Trigger $T -Settings $S `
       -Description "อัป R01.102 จาก Allstock.CSV ขึ้น Firestore ทุกเช้า (WH/SRC/KKL/SSS)" -Force
```

| ค่า | ทำไมต้องมี |
|---|---|
| `-StartWhenAvailable` | เครื่องปิดตอน 08:10 → รันชดเชยทันทีที่เปิด · guard "ไฟล์เก่า" กันไม่ให้เขียนข้อมูลข้ามวัน |
| `-RestartCount 3 -RestartInterval 20m` | POS export ช้า/เน็ตหลุด → ลองใหม่อีก 3 ครั้งห่างกัน 20 นาที (จบใน ~1 ชม.) แทนที่จะข้ามทั้งวัน |
| `-MultipleInstances IgnoreNew` | กันซ้อนถ้ารอบก่อนยังค้าง |
| `-ExecutionTimeLimit 15m` | ไฟล์ 5 MB + เขียน 4 doc ใช้ไม่ถึง 1 นาที ถ้าเกิน 15 นาที = ค้าง ให้ฆ่าทิ้ง |
| `-WorkingDirectory` | สุขอนามัย · ตัวสคริปต์อ้าง path ด้วย `%~dp0` อยู่แล้วจึงไม่พึ่งค่านี้ |

### ขั้น 3 — ทดสอบ Task จริง

```powershell
Start-ScheduledTask -TaskName "AutoR01Import"
Start-Sleep -Seconds 20
Get-ScheduledTask -TaskName "AutoR01Import" | Get-ScheduledTaskInfo |
  Select-Object LastRunTime, LastTaskResult, NextRunTime
Get-Content "$Root\auto_r01.log" -Tail 25 -Encoding UTF8
```

`LastTaskResult` คือ exit code ของสคริปต์ตรงๆ: `0` สำเร็จ · `1` เขียนบาง branch ไม่ผ่าน · `2` ไม่พบไฟล์/โฟลเดอร์ · `4` guard ไม่ผ่าน · `9` ไม่พบ Python
**ครั้งแรกจะได้ `4`** ถ้าไฟล์ยังไม่ใช่ของวันนี้ — ถูกต้องแล้ว ไม่ใช่ error

> ⚠️ ขั้นนี้ **เขียน Firestore จริง** (ไม่ใช่ dry-run) จะดัน R01 ใหม่ให้ทุกเครื่องและล้าง R16
> ทำในวันที่ไม่มีการนับ หรือแจ้งทีมก่อน

### ตัวเลือกเรื่องบัญชีผู้ใช้

**ค่าเริ่มต้น (แนะนำ) — "รันเฉพาะตอน login อยู่"**
เหมาะกับเครื่องหลักที่เปิดและ login ค้างตลอด · มีหน้าต่างดำแวบขึ้นตอน 08:10 สั้นๆ
`%USERPROFILE%` ชี้ถูกเสมอ ไม่ต้องตั้งอะไรเพิ่ม

**ถ้าต้องรันตอนล็อกหน้าจอ/ไม่ได้ login** — เพิ่มก่อน `Register-ScheduledTask` (ต้องเปิด PowerShell แบบ Run as administrator):
```powershell
$P = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
# แล้วเพิ่ม  -Principal $P  ใน Register-ScheduledTask
```
`S4U` ไม่ต้องเก็บรหัสผ่าน และไม่มีหน้าต่างเด้ง

> ⛔ **ห้ามตั้งให้รันด้วย `SYSTEM`** — `%USERPROFILE%` จะกลายเป็น `C:\Windows\system32\config\systemprofile`
> สคริปต์จะหาโฟลเดอร์ CSV ไม่เจอแล้วออกด้วย exit 2 · ถ้าจำเป็นต้องใช้ SYSTEM จริงๆ ต้องตั้ง
> `AUTO_R01_WATCH_FOLDER` แบบ system-wide (`setx /M`) ให้ชี้ path เต็ม

### คำสั่งจัดการ

```powershell
Get-ScheduledTask     -TaskName "AutoR01Import" | Get-ScheduledTaskInfo   # ดูผลรันล่าสุด
Start-ScheduledTask   -TaskName "AutoR01Import"                           # สั่งรันทันที
Disable-ScheduledTask -TaskName "AutoR01Import"                           # ⛔ ปิดฉุกเฉิน
Enable-ScheduledTask  -TaskName "AutoR01Import"                           # เปิดกลับ
Unregister-ScheduledTask -TaskName "AutoR01Import" -Confirm:$false        # ลบทิ้ง
```

เปลี่ยนเวลาโดยไม่ต้องลงทะเบียนใหม่:
```powershell
Set-ScheduledTask -TaskName "AutoR01Import" -Trigger (New-ScheduledTaskTrigger -Daily -At 08:40)
```

### แก้ปัญหา

| อาการ | สาเหตุ / ทางแก้ |
|---|---|
| `LastTaskResult = 2` | โฟลเดอร์/ไฟล์ไม่เจอ — ดู log บรรทัด `โฟลเดอร์:` ว่าชี้ไปไหน · ตั้ง `AUTO_R01_WATCH_FOLDER` |
| `LastTaskResult = 4` ทุกวัน | POS export ช้ากว่าเวลา Task → เลื่อนเวลาด้วย `Set-ScheduledTask` |
| `LastTaskResult = 9` | ไม่มี Python — ลงจาก python.org แล้วติ๊ก "Add python.exe to PATH" |
| `LastTaskResult = 267011` | Task ยังไม่เคยรัน (ไม่ใช่ error) |
| `LastTaskResult = 2147942401` | มักเป็น path ผิดใน `-Execute` — ตรวจว่า `$Bat` มีจริง |
| Task ขึ้น Running ค้าง | ครบ 15 นาทีจะถูกฆ่าเอง · ดู log ว่าค้างตรงไหน |
| log ไม่ขยับเลย | Task ไม่ได้รัน — เช็ค `NextRunTime` และ History ใน Task Scheduler UI |

---

## ข้อควรรู้ / ข้อจำกัด

- **ไม่ติด time gate ของเว็บ** — สคริปต์เขียน Firestore ตรง ไม่ผ่าน UI (กฎ "แนะนำอัพหลัง 21:00" อยู่ฝั่งหน้าเว็บเท่านั้น)
- **เครื่องเป้าหมายต้องเปิด** และ POS ต้อง export ไฟล์เสร็จก่อน 08:10 · ถ้าเครื่องปิด `StartWhenAvailable` จะรันชดเชยตอนเปิด แล้ว guard "ไฟล์เก่า" ตัดสินอีกที
- **WH ถูกอัปทุกเช้าด้วย** ผลคือ **R16.104/103 ของ WH ถูก invalidate ทุกวัน** Supervisor ต้องอัป R16 ชุดใหม่ก่อน Confirm
  และ `systemQty` ของคลังจะขยับใต้รอบนับที่ค้างอยู่ · ถ้ารบกวนงาน ให้เอา `"WH"` ออกจาก `AUTO_BRANCHES`
- **นาฬิกาเครื่องนี้กำหนด `r01Version` ของทั้งระบบ** — เครื่องอื่นเทียบด้วย `>` แบบ lexicographic ถ้าเวลาเพี้ยนย้อนหลังจะไม่มีใคร adopt ควรเปิด time sync อัตโนมัติ
- การเขียนใช้ Firebase REST API + API key สาธารณะ (ตัวเดียวกับเว็บ) ภายใต้ Firestore rules ปัจจุบัน
- **`WH_r01` = 670 KB จาก 6,653 แถว** เพดาน 1 MiB ≈ 10,000 แถว · ถ้าโตเกินนี้ต้องเปลี่ยน `data_json` เป็น array-of-arrays แบบที่ R05 ใช้ (`_serializeR05()` ใน `index.html`) ซึ่งลดได้ ~40%

---

## ตรวจ log

```powershell
Get-Content "C:\Users\BigYa-spare\Desktop\Stock-Count\auto-r01\auto_r01.log" -Tail 30
```

บรรทัดผลลัพธ์ต่อ branch มี: จำนวนรายการ · `nc` (หมวดไม่นับ) · ขนาด KB · `r01Version` ที่เขียน
`r01Version` เป็นค่าเดียวกันทั้ง 4 branch ในรอบเดียว ใช้จับคู่ย้อนหลังกับ doc บน Console ได้
