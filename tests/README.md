# Automated tests — Anin Stock Count

ชุดทดสอบอัตโนมัติของ `index.html` **แยกขาดจากระบบจริง 100%** ใช้ Firestore Emulator บนเครื่องนี้เท่านั้น
รันได้ทุกเวลา แม้ระหว่างพนักงานกำลังสแกน — ไม่แตะข้อมูลจริง ไม่กินโควต้า Firebase แม้แต่ read เดียว

## ทำไมถึงปลอดภัย (isolation 3 ชั้น)

1. **ไม่แก้ไฟล์ production เลย** — `index.html`, `sw.js`, `firestore.rules`, `vercel.json` ถูกอ่านอย่างเดียว
   การ redirect ไป emulator ทำโดย inject `<script>` ตอนเสิร์ฟไฟล์ (`lib/static-server.mjs` + `lib/routes.js`)
   ซึ่ง wrap `firebase.initializeApp` แล้วบังคับ `projectId` เป็น `demo-stock-count` + `useEmulator(127.0.0.1, 8791)`
2. **projectId ขึ้นต้นด้วย `demo-`** — firebase-tools ถือว่าเป็นโหมด offline ต่อ Google จริงไม่ได้โดยธรรมชาติ
   ทุกหน้าที่ boot จะ assert ว่า `firebase.app().options.projectId` ขึ้นต้น `demo-`
3. **default-deny ในเบราว์เซอร์เทส** — บล็อกทุก request ที่ไม่ใช่ `127.0.0.1` แล้วบันทึกลง `violations`
   ทุกเทส assert ว่า `violations` ว่างตอนจบ (`closeApp` ใน `lib/hooks.js`) — ถ้าแอปเผลอยิง `firestore.googleapis.com` เทสจะ fail ทันทีพร้อมพิมพ์ URL
   `specs/e2e/isolation.spec.js` ยิง googleapis จงใจเพื่อพิสูจน์ว่ากับดักนี้ทำงานจริง

**พิสูจน์ขั้นสุดท้าย:** ปิด Wi-Fi แล้วรัน `npm test` ต้องเขียวเหมือนเดิม (ทุกอย่าง local หมด — SDK ก็ vendor ไว้แล้ว)

> ⚠️ อย่าเปิด `http://127.0.0.1:4173` ในเบราว์เซอร์ปกติ — หน้านั้นไม่มี shim จะต่อ Firebase **ของจริง** เหมือนเว็บ production

## ติดตั้งครั้งแรก

```powershell
cd tests
npm install          # ~3-5 นาที (firebase-tools ตัวใหญ่สุด)
npm run setup        # vendor Firebase SDK + ดาวน์โหลด Chromium (~150MB ครั้งเดียว)
npm run preflight    # เช็ค Node/Java/ports/vendor
```

ถ้า preflight บอกว่าไม่มี Java: `winget install Microsoft.OpenJDK.21` แล้ว **เปิด PowerShell หน้าต่างใหม่**

## รันเทส

```powershell
npm run test:logic   # เร็ว (~7 วิ) ไม่ต้องมี Java ไม่ใช้ emulator — ใช้เป็น inner loop
npm run test:e2e     # เต็มรูปแบบผ่าน emulator (ครั้งแรกโหลด emulator JAR ~60MB)
npm test             # ทั้งหมด
npm run report       # เปิด HTML report ของรอบล่าสุด
```

Debug:

```powershell
npm run test:headed                       # เห็นเบราว์เซอร์จริง
npx playwright test --project=e2e -g "concurrent"   # เจาะเทสเดียว (ต้องมี emulator รันอยู่)
npm run emu                               # เปิด emulator ค้างไว้อีกหน้าต่าง
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8791'; npm run e2e:attach   # แล้วเกาะตัวที่เปิดค้าง
```

## โครงสร้าง

| ไฟล์ | หน้าที่ |
|---|---|
| `scripts/run-e2e.mjs` | คุม lifecycle เอง (emulator → static server → playwright → ปิดทุกตัว) + หา Java เองถ้า PATH ยังไม่อัปเดต · ไม่ใช้ `firebase emulators:exec` เพราะ shell ที่ซ้อนกันทำให้รันจบแล้วค้างถาวรบน Windows |
| `lib/routes.js` | **หัวใจของ isolation** — allowlist, inject emulator shim, vendor SDK, stub `?_vchk=`/`maintenance.json` |
| `lib/static-server.mjs` | เสิร์ฟ repo root + inject shim (ต้อง inject ที่ server ไม่ใช่ `route.fulfill` ไม่งั้น Chromium ตัด cross-port fetch ไป emulator) |
| `lib/boot.js` | สร้าง context/page + login ผ่าน `_autoUpdate` backdoor + บล็อก Service Worker |
| `lib/scenario.js` | flow ระดับสูง: `bootFreshCount` (เครื่องแรก → `startNewCount()` จริง), `bootJoinCount` (เครื่องที่ 2), `armR16`/`armWhR16` |
| `lib/wh-workflow.js` | fixture/helper สังเคราะห์สำหรับ WH Count/Recheck, committed operations และ legacy compatibility (**ไม่มีข้อมูล production**) |
| `lib/fixtures.js` | catalog สังเคราะห์ 20 SKU + ตัวสร้าง CSV (**ห้ามใส่ข้อมูลจริง**) |
| `lib/seed.js` / `lib/emulator.js` | seed master docs / items · `clearAll`, `waitForDoc` |
| `specs/logic/**` | เทสสูตรและ merge — ไม่ใช้ emulator |
| `specs/e2e/**` | เทสเต็ม flow ผ่าน emulator |

## ครอบอะไรบ้าง

**ครบ 3 field test ที่ CLAUDE.md ค้างไว้:**
- `concurrent-scan.spec.js` — สอง PDA สแกน SKU เดียวกัน → **ยอดต้องรวม ไม่ใช่ทับ** (delta transaction)
- `confirm-count.spec.js` / `audit-verify.spec.js` — Confirm รอบแรก + Audit Verify บน schema v2 รวม **mid-work abort** (ข้อมูลเปลี่ยนกลางงาน = ยกเลิกทั้งชุด ไม่มี partial)
- `offline-reconcile.spec.js` — PDA offline สแกนค้าง → กลับ online → push ครบ ไม่ทับของเครื่องอื่น

**อื่นๆ:** สูตร `effectiveQty`, กฎราคา ProductMaster, zero-sys/negSys first scan, multiplier, unknown barcode,
`updatePharmacyRecheckQty`, merge rules ของ `_applyCloudScanData`, firestore.rules schema guard, CSV upload path

**WH workflow v2:** Confirm-All 577 SKU, Confirm แยกพนักงาน, Count/Recheck committed operation,
atomic reader overlay, recovery หลัง commit, Dashboard precedence, candidate/master race abort, branch lock,
canonical hash และ rules ป้องกัน stale PDA/legacy final map

## สิ่งที่เทสแทนไม่ได้ (ยังต้องทดสอบมือ)

- **PDA จริง**: Intent scanner, จังหวะ keystroke, WebView, เสียง, APK — เทสจำลองแค่ viewport + User-Agent
- **composite index บน production** (`countResetAt` + `status`) — emulator ไม่บังคับ index ปัญหานี้โผล่เฉพาะของจริง
- **KKL/SSS v1 blob path** — โดนทางอ้อมผ่าน merge tests ไม่ใช่ E2E เต็ม
- **ระยะเวลา transaction บนเครือข่าย production สำหรับ Confirm ชุดใหญ่มาก** — emulator ยืนยัน contract/atomicity แต่จำลอง WAN latency และ contention จริงไม่ได้
- โควต้า/backoff ของ Firestore จริง — เทสได้แค่ logic ฝั่ง client

## เกร็ดสำคัญตอนเขียนเทสเพิ่ม

- **ห้าม sleep** — ใช้ `page.waitForFunction(..., { polling: 100 })` (rAF polling ค้างเมื่อหน้าไม่ได้ focus) และ `waitForDoc()` ยืนยันความจริงที่ emulator
- บังคับ flush ตรงๆ ด้วย `evaluate(() => _flushDirtySkus())` ข้าม debounce 800 ms ได้
- เทส offline ต้องปลด backoff ก่อน flush: `_scanItemBackoffUntil = 0; _scanItemFailStreak = 0`
- Confirm ต้อง `armR16()` ก่อน (ตั้งทั้ง state ในหน้าและ master doc) ไม่งั้นติด version mismatch
- Audit Verify: ต้องรอ marker ลงเครื่องก่อนแก้ `recheckQty` — marker เป็น authoritative และจะลบ draft ที่ใส่มาก่อนหน้า
- `firebase-admin` ใน `lib/emulator.js` **bypass rules** — ใช้ seed/ตรวจเท่านั้น อะไรที่ต้องพิสูจน์ rules ให้ยิงผ่าน web SDK ในหน้า
- **ห้ามรันสองรอบพร้อมกัน** — ทุกเทสเรียก `clearAll()` ล้าง emulator ถ้าซ้อนกันจะลบข้อมูลที่อีกรอบเพิ่ง seed แล้วขึ้น timeout 20 วิ กระจายมั่ว
  (`npm run test:e2e` เช็คพอร์ต 8791/4400 ให้แล้ว ถ้าไม่ว่างจะหยุดพร้อมบอกเหตุผล — เจอเมื่อไหร่ให้ปิดรอบเก่าก่อน)
- **`bootFreshCount`/`bootJoinCount` ต้องผ่าน `restoreMastersUntilReady`** ห้ามเรียก `restoreMasterFromFirestore` ตรงๆ แล้วเชื่อว่า catalog พร้อม มีสองกับดักที่เจอมาแล้ว:
  1. `startNewCount()` ลบ `{branch}_r01` ผ่าน SDK ของหน้านั้น → cache จำว่า doc ถูกลบ พอ seed ด้วย admin แล้ว `.get()` ยังคืนค่า cache เก่า → `r01Data` ว่างถาวร (ต้อง retry)
  2. `skuMap` ถูก derive โดยไฟล์ที่โหลดเสร็จทีหลัง อาจถูกสร้างจาก PM ล้วน → **`systemQty` เป็น 0 ทุกตัว** เทสจะผ่านแบบผิดๆ หรือล้มงงๆ (ต้อง `rebuildMaps()` + ตรวจ canary `S-NORM.systemQty===10`)
  3. **กับดักเดียวกันนี้ยังไม่ถูกปิดใน `wh-workflow-rules.spec.js:157`** (`legacy WH final documents are read/delete-only`) — `startNewCount()` ที่ [index.html:3453](../index.html#L3453) ลบ `WH_count_confirmations`/`WH_recheck_confirmations` ผ่าน `Promise.all` ของหน้านั้น
     ถ้าเทส seed doc กลับด้วย admin ก่อน delete ชุดนั้น commit เสร็จ → delete มาถึงทีหลังแล้วลบทับ → `recheckRead:false` (ตัวสุดท้ายใน `Promise.all` จึงโดนบ่อยสุด)
     **เป็นเทสที่ flaky อยู่แล้วก่อนหน้านี้ ไม่ใช่บั๊กของ production** — วัดแล้วล้ม 2/3 รอบบน `index.html` ที่ยังไม่แก้อะไร · ถ้าจะปิดต้องรอ delete settle หลัง boot ก่อน seed
