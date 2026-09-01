#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Auto R01.102 importer  ->  Firestore  (Stock Count)

อ่านไฟล์ R01.102 (CSV) ที่ใหม่ที่สุดในโฟลเดอร์ที่กำหนด แล้วแยกตาม Col D (CF_WNAME)
เป็น 4 branch (WH / SRC / KKL / SSS) เขียนเข้า Firestore:
    stock_sessions/<BRANCH>_r01

รูปแบบข้อมูลตรงกับที่ index.html (loadR01 + syncMasterToFirestore) ใช้ทุกประการ
ใช้ Python stdlib ล้วน — ไม่ต้องลง pip อะไรเพิ่ม

⚠️ ต้องแยกไฟล์ตาม Col D ก่อนเขียนเสมอ — SKU เดียวกันมีอยู่หลาย branch ในไฟล์เดียว
   ถ้าอัปทั้งไฟล์ผ่านหน้าเว็บ qtyMap.set() ใน _rebuildCountableSkus() เป็น last-wins
   ทุกสาขาจะได้ยอดของ branch ที่อยู่ท้ายไฟล์

วิธีรัน:
    python auto_r01_import.py            # โหมดจริง — เขียนขึ้น Firestore
    python auto_r01_import.py --dry-run  # ทดสอบ — แค่พิมพ์ยอดต่อ branch ไม่เขียน
    python auto_r01_import.py --force    # ข้าม guard "ไฟล์ไม่ใช่ของวันนี้" (ใช้ตอนทดสอบเท่านั้น)

ตั้งเวลา 8:10 ทุกวันด้วย Windows Task Scheduler (ดู README.md)
"""

import sys
import os
import csv
import io
import json
import glob
import urllib.request
import urllib.error
import urllib.parse
from collections import defaultdict
from datetime import datetime, timezone

# บังคับ console เป็น UTF-8 (กัน emoji/ภาษาไทย crash บน Windows cp874)
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# ============================================================
#  CONFIG — แก้ตรงนี้ให้ตรงกับเครื่องจริง
# ============================================================

# โฟลเดอร์ที่ไฟล์ R01.102 ถูก export มาวาง — หาตามลำดับนี้:
#   1. อาร์กิวเมนต์ --folder "<path>"        (ใช้ตอนทดสอบ)
#   2. ตัวแปรระบบ AUTO_R01_WATCH_FOLDER      (ใช้เมื่อ path ไม่ตรงแบบมาตรฐาน หรือ Task รันด้วย account อื่น)
#   3. <โฟลเดอร์ผู้ใช้ปัจจุบัน>\Desktop\run-upload-stock   ← ค่าปกติ
#
# ข้อ 3 ทำให้ไฟล์เดียวใช้ได้ทุกเครื่องโดยไม่ต้องแก้โค้ด เพราะทุกเครื่องวางไฟล์ที่ Desktop\run-upload-stock
# เหมือนกัน ต่างกันแค่ชื่อผู้ใช้ (BigYa-spare / AninMainPC / ...) — เดิมฮาร์ดโค้ดชื่อผู้ใช้ไว้
# ⚠️ ถ้าตั้ง Task Scheduler แบบ "Run whether user is logged on or not" ด้วย account อื่น (เช่น SYSTEM)
#    ข้อ 3 จะชี้ไปโฟลเดอร์ผิด — กรณีนั้นให้ตั้ง AUTO_R01_WATCH_FOLDER แบบ system-wide
DEFAULT_WATCH_FOLDER = os.path.join(os.path.expanduser("~"), "Desktop", "run-upload-stock")


def resolve_watch_folder(argv):
    for i, a in enumerate(argv):
        if a == "--folder" and i + 1 < len(argv):
            return argv[i + 1], "--folder"
        if a.startswith("--folder="):
            return a.split("=", 1)[1], "--folder"
    env = os.environ.get("AUTO_R01_WATCH_FOLDER", "").strip()
    if env:
        return env, "AUTO_R01_WATCH_FOLDER"
    return DEFAULT_WATCH_FOLDER, "ค่าปกติ (โฟลเดอร์ผู้ใช้ปัจจุบัน)"


WATCH_FOLDER, WATCH_FOLDER_SOURCE = resolve_watch_folder(sys.argv)

# รูปแบบชื่อไฟล์ที่จะมองหา (เลือกไฟล์ที่ใหม่ที่สุด)
FILE_GLOB = "Allstock*.csv"

# Firebase project (จาก index.html FIREBASE_CONFIG)
PROJECT_ID = "stock-count-1d6e7"
API_KEY    = "AIzaSyDba_44vuyh-DyXeSYUoppm925oFCfr010"

# Col D (index 3, CF_WNAME) -> รหัส branch.  เทียบแบบ lower-case + ตัดช่องว่างซ้ำ
BRANCH_MAP = {
    "warehouse":   "WH",
    "front store": "SRC",
    "main kkl":    "KKL",
    "main sss":    "SSS",
}

# branch ที่จะเขียนจริง — ปิด branch ไหนก็เอาออกจาก set นี้ที่เดียว (ไม่ต้องแตะโค้ดอื่น)
# ⚠️ ถอด "WH" ออกถ้าการอัป R01 ทุกเช้ารบกวนรอบนับคลัง (R16 ของ WH จะถูก invalidate ทุกครั้ง)
AUTO_BRANCHES = {"WH", "SRC", "KKL", "SSS"}

# guard: branch ที่มีแถวน้อยกว่านี้ = ไฟล์ผิดปกติ (ของจริงต่ำสุดคือ SSS ~3,100 แถว)
MIN_ROWS_PER_BRANCH = 500

# guard: doc ใหญ่เกินนี้ (KB) ไม่เขียน — Firestore ปฏิเสธที่ 1 MiB
MAX_DOC_KB = 950

# index คอลัมน์ (ตรงกับ loadR01 ใน index.html)
COL_BRANCH = 3   # D  CF_WNAME
COL_SKU    = 4   # E  CF_ITEMID
COL_NAME   = 5   # F  CF_ITEMNAME
COL_QTY    = 6   # G  CF_QUANTITY
COL_CAT    = 15  # P  CF_ITEMGROUPL1_GROUPNAME

# ต้องตรงกับ R01_NON_COUNT_PREFIXES / R01_NON_COUNT_KEYWORDS ใน index.html เป๊ะ
# เพิ่มหมวดใหม่ต้องแก้ "ทั้งสองฝั่ง" พร้อมกัน ไม่งั้นอัพมือกับอัพออโต้ให้ผลต่างกัน
R01_NON_COUNT_PREFIXES = ("11.",)
R01_NON_COUNT_KEYWORDS = ("DELETE",)

# field ทั้งหมดที่เขียน — ใช้เป็น updateMask ด้วย
# ⚠️ ห้ามเขียนแบบไม่มี updateMask: PATCH จะ replace ทั้ง document แล้วลบ field ที่เว็บเขียนไว้ทิ้ง
WRITE_FIELDS = [
    "data_json", "r01UploadedAt", "r01Version", "r01BaselineAt",
    "r16Loaded", "r16UploadedAt", "r16DetailVersion",
    "r16_103Loaded", "r16_103UploadedAt", "r16_103DetailVersion",
    "updated_at",
]

# ============================================================


def log(msg):
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def find_latest_file():
    pattern = os.path.join(WATCH_FOLDER, FILE_GLOB)
    files = glob.glob(pattern)
    # glob บน Windows ไม่ case-sensitive อยู่แล้ว แต่กันไว้
    if not files:
        files = glob.glob(os.path.join(WATCH_FOLDER, FILE_GLOB.upper()))
    if not files:
        return None
    files.sort(key=os.path.getmtime, reverse=True)
    return files[0]


def decode_bytes(raw):
    """เลียนแบบ parseFile: UTF-8 BOM -> UTF-8 -> Windows-874 (cp874)"""
    for enc in ("utf-8-sig", "utf-8", "cp874"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    # สุดท้ายยอมแทนตัวที่ decode ไม่ได้ เพื่อไม่ให้ล้มทั้งงาน
    return raw.decode("cp874", errors="replace")


def sniff_delimiter(sample):
    """เดา delimiter จากบรรทัดแรก — POS CSV ส่วนใหญ่เป็น comma"""
    first = sample.splitlines()[0] if sample else ""
    counts = {",": first.count(","), ";": first.count(";"), "\t": first.count("\t")}
    return max(counts, key=counts.get) or ","


def norm(s):
    return " ".join(str(s).strip().lower().split())


def parse_qty(g):
    """ตรงกับ loadR01: strip comma+ช่องว่าง แล้ว Number() — ว่าง/ไม่ใช่ตัวเลข = None (ข้ามแถว)

    ⛔ ห้ามใส่ `qty <= 0 -> ข้าม` กลับมา
    SKILL-data-files.md: qty ≤ 0 (ติดลบ/0) เก็บไว้ด้วยค่าจริง ไม่ clamp
    - G = 0  ยังต้องนับถ้า PBM Col D ∈ {A,B,C,REVIEW}
    - G < 0  (negSys) คือ "ขายของขาด" ต้องบังคับให้เภสัชตรวจทุกตัว
    ทิ้งไปแล้ว = ของที่ต้องเดินไปนับหายเกือบครึ่งสาขา
    """
    g = "".join(str(g).split()).replace(",", "")
    if g == "":
        return None
    try:
        v = float(g)
    except ValueError:
        return None
    if v != v or v in (float("inf"), float("-inf")):   # NaN / Infinity -> เหมือน !isFinite()
        return None
    return int(v) if v == int(v) else v


def is_non_count_category(col_p):
    """ตรงกับ _isNonCountR01Category() ใน index.html"""
    v = str(col_p or "").strip().upper()
    if not v:
        return False
    return v.startswith(R01_NON_COUNT_PREFIXES) or any(k in v for k in R01_NON_COUNT_KEYWORDS)


def parse_file(path):
    with open(path, "rb") as f:
        raw = f.read()
    text = decode_bytes(raw)
    delim = sniff_delimiter(text)
    rows = list(csv.reader(io.StringIO(text), delimiter=delim))

    branches = defaultdict(list)
    nc_counts = defaultdict(int)
    skipped_no_sku = 0
    skipped_qty = 0
    unknown_branch = defaultdict(int)

    # ข้าม header แถวแรก (เหมือน loadR01 ที่เริ่ม i=1)
    for r in rows[1:]:
        if not r or len(r) <= COL_QTY:
            continue
        sku = str(r[COL_SKU]).strip()
        if not sku:
            skipped_no_sku += 1
            continue
        qty = parse_qty(r[COL_QTY])
        if qty is None:
            skipped_qty += 1
            continue

        d = norm(r[COL_BRANCH])
        branch = BRANCH_MAP.get(d)
        if branch is None:
            unknown_branch[str(r[COL_BRANCH]).strip()] += 1
            continue
        if branch not in AUTO_BRANCHES:
            continue

        item = {"colE": sku, "productName": str(r[COL_NAME]).strip(), "systemQty": qty}
        if is_non_count_category(r[COL_CAT] if len(r) > COL_CAT else ""):
            item["nc"] = 1
            nc_counts[branch] += 1
        branches[branch].append(item)

    return branches, {
        "nc_counts": nc_counts,
        "skipped_no_sku": skipped_no_sku,
        "skipped_qty": skipped_qty,
        "unknown_branch": dict(unknown_branch),
        "delimiter": repr(delim),
        "total_rows": max(0, len(rows) - 1),
    }


def thai_ts(dt):
    """ตรงกับ formatThaiDateTime ใน index.html:  HH:MM น. DD/MM/YYYY"""
    return f"{dt:%H:%M} น. {dt:%d/%m/%Y}"


def iso_utc_ms():
    """ต้องเทียบ lexicographic กับที่ new Date().toISOString() ผลิตได้ (มิลลิวินาที + Z)"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def build_payload(items, version_iso, uploaded_at):
    """field ที่เขียนและเหตุผล — ดู README.md §สิ่งที่สคริปต์เขียน

    r01Version    : _branchConfirmVersions() ใช้ตรวจก่อน Confirm · WH _applyWhR01Doc ใช้ตัดสินว่าจะ adopt ไหม
    r01BaselineAt : trigger ให้ listener ของสาขายาเรียก _applyR01BaselineUpdate()
                    (ห้ามแตะ session doc — r01BaselineAt เดิมฝังรวมกับ scanData ใน blob v1 เสี่ยงทับยอดสแกน)
    r16* = ล้าง    : ตรงกับที่ syncR16MetaToFirestore() เขียนตอนอัพ R01 ด้วยมือ
                    R01 ใหม่ = ยอดระบบรวมยอดขายเมื่อวานแล้ว บวก R16 เก่าซ้ำ = ผิด → บล็อก Confirm จนอัป R16 ชุดใหม่
    """
    data_json = json.dumps(items, ensure_ascii=False)
    return data_json, {
        "fields": {
            "data_json":            {"stringValue": data_json},
            "r01UploadedAt":        {"stringValue": uploaded_at},
            "r01Version":           {"stringValue": version_iso},
            "r01BaselineAt":        {"stringValue": version_iso},
            "r16Loaded":            {"booleanValue": False},
            "r16UploadedAt":        {"stringValue": ""},
            "r16DetailVersion":     {"stringValue": ""},
            "r16_103Loaded":        {"booleanValue": False},
            "r16_103UploadedAt":    {"stringValue": ""},
            "r16_103DetailVersion": {"stringValue": ""},
            "updated_at":           {"timestampValue": datetime.now(timezone.utc)
                                     .strftime("%Y-%m-%dT%H:%M:%S.%fZ")},
        }
    }


def write_branch(branch, items, version_iso, uploaded_at, dry_run):
    data_json, body = build_payload(items, version_iso, uploaded_at)
    size_kb = len(data_json.encode("utf-8")) / 1024
    nc = sum(1 for x in items if x.get("nc"))

    if size_kb > MAX_DOC_KB:
        log(f"  ❌ {branch}_r01: {size_kb:.0f} KB เกิน {MAX_DOC_KB} KB (เพดาน Firestore 1 MiB) — ไม่เขียน")
        log(f"     แก้ด้วยการเปลี่ยน data_json เป็น array-of-arrays แบบ R05 (ดู _serializeR05 ใน index.html)")
        return False

    if dry_run:
        log(f"  [DRY] {branch}_r01: {len(items)} รายการ · nc {nc} · {size_kb:.0f} KB — ไม่เขียน")
        return True

    mask = "&".join(f"updateMask.fieldPaths={urllib.parse.quote(f)}" for f in WRITE_FIELDS)
    url = (
        f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}"
        f"/databases/(default)/documents/stock_sessions/{branch}_r01?{mask}&key={API_KEY}"
    )
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), method="PATCH",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            resp.read()
        log(f"  ✅ {branch}_r01: {len(items)} รายการ · nc {nc} · {size_kb:.0f} KB · r01Version={version_iso}")
        return True
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        log(f"  ❌ {branch}_r01: HTTP {e.code} — {detail[:400]}")
        return False
    except Exception as e:
        log(f"  ❌ {branch}_r01: {e}")
        return False


def main():
    dry_run = "--dry-run" in sys.argv or "-n" in sys.argv
    force = "--force" in sys.argv

    log(f"เริ่มงาน auto R01 import  (dry_run={dry_run}, force={force})")
    log(f"เครื่อง: {os.environ.get('COMPUTERNAME', '?')} · ผู้ใช้: {os.environ.get('USERNAME', '?')}")
    log(f"โฟลเดอร์: {WATCH_FOLDER}   [จาก {WATCH_FOLDER_SOURCE}]")
    log(f"branch ที่เปิดใช้: {', '.join(sorted(AUTO_BRANCHES))}")

    if not os.path.isdir(WATCH_FOLDER):
        log(f"❌ ไม่มีโฟลเดอร์นี้ในเครื่อง — ยกเลิก")
        log(f"   ถ้าไฟล์อยู่ที่อื่น ตั้งค่าแล้วรันใหม่:")
        log(f'   setx AUTO_R01_WATCH_FOLDER "D:\\path\\to\\run-upload-stock"   (แล้วเปิด CMD ใหม่)')
        log(f'   หรือทดสอบครั้งเดียว:  python auto_r01_import.py --folder "D:\\path" --dry-run')
        sys.exit(2)

    path = find_latest_file()
    if not path:
        log(f"❌ ไม่พบไฟล์ตรงรูปแบบ '{FILE_GLOB}' ในโฟลเดอร์ — ยกเลิก")
        try:
            others = sorted(os.listdir(WATCH_FOLDER))[:10]
            log(f"   ไฟล์ที่มีในโฟลเดอร์: {others if others else '(ว่าง)'}")
        except Exception:
            pass
        sys.exit(2)

    mtime = datetime.fromtimestamp(os.path.getmtime(path))
    log(f"ไฟล์ล่าสุด: {os.path.basename(path)}  (แก้ไขล่าสุด {mtime:%Y-%m-%d %H:%M})")

    # guard 1: ไฟล์ไม่ใช่ของวันนี้ = POS ยัง export ไม่เสร็จ / export ล้ม
    # เขียนของเก่าทับ = ดัน r01BaselineAt ใหม่ด้วยข้อมูลเก่า + ล้าง R16 ของทุกเครื่องฟรี → ต้องหยุด
    # (สำคัญเป็นพิเศษเพราะ Task Scheduler ตั้ง StartWhenAvailable ไว้ = รันชดเชยข้ามวันได้)
    if mtime.date() != datetime.now().date():
        if not force:
            log("❌ ไฟล์ไม่ได้ถูกแก้ไขวันนี้ — ยกเลิก (ไม่เขียน Firestore). ใช้ --force ถ้าตั้งใจ")
            sys.exit(4)
        log("⚠️ ไฟล์ไม่ได้ถูกแก้ไขวันนี้ แต่มี --force — ดำเนินการต่อ")

    branches, stats = parse_file(path)
    log(f"delimiter={stats['delimiter']} · แถวข้อมูล {stats['total_rows']} · "
        f"ข้าม: ไม่มี SKU={stats['skipped_no_sku']}, qty อ่านไม่ได้={stats['skipped_qty']}")

    # guard 2: Col D ที่ map ไม่ได้ = POS เปลี่ยนชื่อคลัง / เพิ่มสาขาใหม่ ต้องมีคนมาดูก่อน
    if stats["unknown_branch"]:
        log(f"❌ Col D ที่ map ไม่ได้: {stats['unknown_branch']}")
        log("   POS อาจเปลี่ยนชื่อคลังหรือเพิ่มสาขา — เพิ่มใน BRANCH_MAP ก่อน. ยกเลิก (ไม่เขียน Firestore)")
        sys.exit(4)

    # guard 3: branch หาย/แถวน้อยผิดปกติ = ไฟล์ export ไม่ครบ — ตรวจให้ครบก่อนเขียนตัวแรก (all-or-none)
    problems = []
    for branch in sorted(AUTO_BRANCHES):
        n = len(branches.get(branch, []))
        if n < MIN_ROWS_PER_BRANCH:
            problems.append(f"{branch}={n}")
    if problems:
        log(f"❌ branch ที่แถวน้อยกว่า {MIN_ROWS_PER_BRANCH}: {', '.join(problems)}")
        log("   ไฟล์ export น่าจะไม่ครบ. ยกเลิกทั้งงาน (ไม่เขียน Firestore)")
        sys.exit(4)

    for branch in sorted(AUTO_BRANCHES):
        log(f"  · {branch}: {len(branches[branch])} รายการ (nc {stats['nc_counts'][branch]})")

    # ใช้ค่าเดียวกันทุก branch ในรอบเดียว — อ่าน log ย้อนหลังแล้วจับคู่ได้ว่า doc ไหนมาจากรอบไหน
    version_iso = iso_utc_ms()
    uploaded_at = thai_ts(datetime.now())

    ok = True
    for branch in sorted(AUTO_BRANCHES):
        if not write_branch(branch, branches[branch], version_iso, uploaded_at, dry_run):
            ok = False

    log("เสร็จสิ้น" if ok else "เสร็จแบบมีข้อผิดพลาด (ดู log ด้านบน)")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
