/*
 * One-time SRC schema-v2 recovery helper.
 *
 * Run only in DevTools Console on a fresh Desktop page that is logged in to SRC:
 *   1. Paste this whole file.
 *   2. Dry-run: await recoverSrcMissingItems({dryRun:true})
 *   3. Select SRC-local-backup-2026-07-24T15-03-43-176Z.json.
 *   4. If the dry-run passes, run: await recoverSrcMissingItems()
 *      and select the same file again.
 *
 * Safety properties:
 * - accepts only the exact backup that was verified on 25 Jul 2026;
 * - validates the whole-file SHA-256, embedded session SHA-256, branch and epoch;
 * - dry-runs against Firestore server data before asking for confirmation;
 * - downloads a second backup of the Cloud session/items before any write;
 * - transactionally writes only SKUs whose document ID does not exist in any epoch;
 * - never replaces an existing document, even if it appears after the dry-run;
 * - rechecks the session epoch in every transaction and verifies all recovered SKUs.
 */
(()=>{
'use strict';

const SPEC=Object.freeze({
  branch:'SRC',
  schemaVersion:2,
  fileName:'SRC-local-backup-2026-07-24T15-03-43-176Z.json',
  fileSha256:'95a80f2fa44992733778123b532644e07cfc06a9330fddc9d19018096db5e2d7',
  sessionSha256:'ab8d27786d2b8bb063e7e3d8aafab127f36d77f02fd1f9b6d8e229adc668a142',
  epoch:'2026-07-19T02:39:21.626Z',
  scanDataSize:5917,
  completed:1937,
  statuses:Object.freeze({pending:3980,pass:1687,stock_adjustment:215,audit:35}),
  cloudItemStatuses:Object.freeze({pass:1687,stock_adjustment:215,audit:35}),
  staleBlobScanDataSize:328
});
const CONFIRMED_STATUSES=new Set(['pass','audit','audit_check','stock_adjustment']);
const OMIT_FIELDS=new Set(['retries','scans','manualEditAt','sku','countResetAt','rev','updatedBy','updatedAt']);
const TX_CHUNK_SIZE=100;
const TX_PAUSE_MS=250;

function fail(message){throw new Error(`[SRC recovery] ${message}`);}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function countStatuses(scanData){
  const statuses={};
  let completed=0;
  for(const item of Object.values(scanData||{})){
    const status=item?.status||'pending';
    statuses[status]=(statuses[status]||0)+1;
    if(CONFIRMED_STATUSES.has(status))completed++;
  }
  return{total:Object.keys(scanData||{}).length,completed,statuses};
}
function countsByStatus(entries,getItem){
  const out={};
  for(const entry of entries){
    const item=getItem?getItem(entry):entry;
    const status=item?.status||'unknown';
    out[status]=(out[status]||0)+1;
  }
  return out;
}
function sameStatusCounts(actual,expected){
  const actualKeys=Object.keys(actual).sort();
  const expectedKeys=Object.keys(expected).sort();
  return actualKeys.length===expectedKeys.length&&
    actualKeys.every((key,index)=>key===expectedKeys[index]&&actual[key]===expected[key]);
}
function mapContentJson(map){
  return JSON.stringify([...map.entries()].sort(([a],[b])=>String(a).localeCompare(String(b))));
}
function sameExpectedSummary(actual){
  if(actual.total!==SPEC.scanDataSize||actual.completed!==SPEC.completed)return false;
  const actualKeys=Object.keys(actual.statuses).sort();
  const expectedKeys=Object.keys(SPEC.statuses).sort();
  return actualKeys.length===expectedKeys.length&&
    actualKeys.every((key,index)=>key===expectedKeys[index]&&actual.statuses[key]===SPEC.statuses[key]);
}
async function sha256Hex(bytes){
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
}
function parseSessionSnapshot(doc){
  if(!doc?.exists)return null;
  const raw=doc.data()||{};
  try{return raw.session_data_json?JSON.parse(raw.session_data_json):raw.session_data||null;}
  catch(e){fail(`session บน Cloud อ่านไม่ออก: ${e.message}`);}
}
function chooseBackupFile(){
  return new Promise(resolve=>{
    const input=document.createElement('input');
    let settled=false;
    const finish=file=>{if(settled)return;settled=true;window.removeEventListener('focus',onFocus);resolve(file||null);};
    const onFocus=()=>setTimeout(()=>finish(input.files?.[0]||null),500);
    input.type='file';
    input.accept='.json,application/json';
    input.addEventListener('change',()=>finish(input.files?.[0]||null),{once:true});
    window.addEventListener('focus',onFocus,{once:true});
    input.click();
  });
}
async function validateBackupFile(file){
  if(!file)fail('ไม่ได้เลือกไฟล์');
  if(file.name!==SPEC.fileName)fail(`ชื่อไฟล์ไม่ตรง: ต้องเป็น ${SPEC.fileName}`);
  const bytes=new Uint8Array(await file.arrayBuffer());
  const fileHash=await sha256Hex(bytes);
  if(fileHash!==SPEC.fileSha256)fail(`SHA-256 ของไฟล์ไม่ตรง (${fileHash}) — ห้ามใช้ไฟล์นี้`);
  let backup;
  try{backup=JSON.parse(new TextDecoder().decode(bytes));}
  catch(e){fail(`ไฟล์ JSON อ่านไม่ออก: ${e.message}`);}
  if(backup.backupType!=='SRC_LOCAL_SESSION'||Number(backup.backupVersion)!==1)fail('ชนิดหรือเวอร์ชันไฟล์สำรองไม่ตรง');
  if(backup.sourceKey!=='stockCountSession_SRC')fail(`sourceKey ไม่ใช่ SRC (${backup.sourceKey||'ว่าง'})`);
  if(!backup.session||typeof backup.session!=='object')fail('ไม่พบ session ในไฟล์สำรอง');
  if(backup.session.countResetAt!==SPEC.epoch)fail(`รอบนับในไฟล์ไม่ตรง (${backup.session.countResetAt||'ว่าง'})`);
  if(backup.sessionSha256!==SPEC.sessionSha256)fail('sessionSha256 ที่บันทึกในไฟล์ไม่ตรงกับไฟล์ที่อนุมัติ');
  const sessionHash=await sha256Hex(new TextEncoder().encode(JSON.stringify(backup.session)));
  if(sessionHash!==SPEC.sessionSha256)fail(`เนื้อหา session ถูกเปลี่ยน (SHA-256 ${sessionHash})`);
  const summary=countStatuses(backup.session.scanData);
  if(!sameExpectedSummary(summary))fail(`สรุปไฟล์ไม่ตรงกับชุดที่ตรวจแล้ว: ${JSON.stringify(summary)}`);
  if(JSON.stringify(backup.summary)!==JSON.stringify({completed:SPEC.completed,statuses:SPEC.statuses})){
    fail('summary ที่ฝังในไฟล์ไม่ตรงกับชุดที่ตรวจแล้ว');
  }
  return{backup,fileHash,sessionHash,summary};
}
function assertAppReady(){
  if(typeof _db==='undefined'||!_db)fail('Firestore ยังไม่พร้อม กรุณา login เข้าโปรแกรมก่อน');
  if(typeof firebase==='undefined'||!firebase.firestore)fail('ไม่พบ Firebase runtime ของโปรแกรม');
  if(typeof currentBranch==='undefined'||currentBranch!==SPEC.branch)fail(`ต้องเปิดสาขา ${SPEC.branch} เท่านั้น (ขณะนี้ ${typeof currentBranch==='undefined'?'ไม่ทราบ':currentBranch})`);
  if(typeof _isPdaApp==='function'&&_isPdaApp())fail('ต้องรันบน Desktop เท่านั้น ห้ามรันบน PDA');
  if(typeof _adminMode!=='undefined'&&_adminMode)fail('กรุณาออกจาก Admin Mode ก่อน');
  if(typeof _branchConfirming!=='undefined'&&_branchConfirming)fail('มีการ Confirm อยู่ กรุณารอให้จบก่อน');
  if(!navigator.onLine)fail('เครื่องออฟไลน์');
  // Fresh/Incognito page อาจยังถือค่าเริ่มต้น v1 ก่อน restore async อ่าน session จบ
  // recovery ใช้ค่าจาก Firestore Server ใน readCloudPreflight() เป็น source of truth
  if(typeof _schemaVersion==='undefined'||Number(_schemaVersion)!==SPEC.schemaVersion){
    console.warn(`[SRC recovery] local schema ยังเป็น v${typeof _schemaVersion==='undefined'?'?':_schemaVersion}; จะตรวจค่าจริงจาก Firestore Server`);
  }
}
function makePayload(sku,item,oldDoc){
  const out={};
  for(const[key,value]of Object.entries(item||{})){
    if(OMIT_FIELDS.has(key)||value===undefined)continue;
    out[key]=value;
  }
  out.sku=String(sku);
  out.countResetAt=SPEC.epoch;
  out.rev=(Number(oldDoc?.rev)||0)+1;
  out.updatedBy='recovery-src-local-backup';
  out.updatedAt=firebase.firestore.FieldValue.serverTimestamp();
  return out;
}
function essentialDifference(backupItem,cloudItem){
  const fields=['status','countedQty','scannedBy','auditor','recheckQty','recheckBy','auditStatus'];
  return fields.some(field=>JSON.stringify(backupItem?.[field]??null)!==JSON.stringify(cloudItem?.[field]??null));
}
function downloadJsonFile(fileName,json){
  const blob=new Blob([json],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url;
  link.download=fileName;
  link.style.display='none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function backupCloudBeforeWrite(validated,cloud){
  const items={};
  for(const[sku,item]of cloud.all)items[sku]=item;
  const data={
    capturedAt:new Date().toISOString(),
    branch:SPEC.branch,
    schemaVersion:SPEC.schemaVersion,
    countResetAt:SPEC.epoch,
    sourceLocalBackupSha256:validated.fileHash,
    sessionDocument:cloud.sessionRaw,
    items
  };
  const dataJson=JSON.stringify(data);
  const dataSha256=await sha256Hex(new TextEncoder().encode(dataJson));
  const archive={
    backupType:'SRC_CLOUD_BEFORE_RECOVERY',
    backupVersion:1,
    dataSha256,
    data
  };
  const stamp=data.capturedAt.replace(/[:.]/g,'-');
  const fileName=`SRC-cloud-before-recovery-${stamp}.json`;
  const archiveJson=JSON.stringify(archive);
  downloadJsonFile(fileName,archiveJson);
  globalThis.__SRC_RECOVERY_CLOUD_BACKUP__={fileName,dataSha256,archive};
  console.info(`[SRC recovery] สำรอง Cloud ก่อนเขียนแล้ว: ${fileName} (SHA-256 ${dataSha256})`);
  return{fileName,dataSha256,itemCount:cloud.all.size};
}
async function readSchemaRepairSnapshot(){
  assertAppReady();
  const sessionRef=_db.collection('stock_sessions').doc(SPEC.branch);
  const sessionDoc=await sessionRef.get({source:'server'});
  if(!sessionDoc.exists)fail('ไม่พบ session SRC บน Cloud');
  const raw=sessionDoc.data()||{};
  const schemaValue=raw.schemaVersion===undefined||raw.schemaVersion===null?null:Number(raw.schemaVersion);
  if(schemaValue!==null&&schemaValue!==1&&schemaValue!==SPEC.schemaVersion){
    fail(`schemaVersion บน Cloud เป็นค่าที่ไม่รองรับ (${raw.schemaVersion})`);
  }
  if(typeof raw.session_data_json!=='string')fail('session_data_json บน Cloud ไม่ใช่ข้อความเดิม — หยุด');
  const session=parseSessionSnapshot(sessionDoc);
  if(!session)fail('session SRC บน Cloud ว่าง');
  if((session.countResetAt||'')!==SPEC.epoch)fail(`Cloud อยู่คนละรอบนับ (${session.countResetAt||'ว่าง'}) — ห้ามซ่อม`);
  const staleBlobScanDataSize=Object.keys(session.scanData||{}).length;
  if(staleBlobScanDataSize!==SPEC.staleBlobScanDataSize){
    fail(`scanData ใน blob เปลี่ยนจากหลักฐานเดิม (${staleBlobScanDataSize} แทน ${SPEC.staleBlobScanDataSize}) — หยุด`);
  }

  const itemsRef=sessionRef.collection('items');
  let itemsSnapshot;
  try{itemsSnapshot=await itemsRef.get({source:'server'});}
  catch(e){fail(`อ่าน items จาก Cloud ไม่สำเร็จ (${e.code||e.message})`);}
  const all=new Map();
  const current=new Map();
  itemsSnapshot.forEach(doc=>{
    const item=doc.data()||{};
    all.set(doc.id,item);
    if(String(item.countResetAt||'')===SPEC.epoch)current.set(doc.id,item);
  });
  const currentStatuses=countsByStatus([...current.values()]);
  if(current.size!==SPEC.completed||!sameStatusCounts(currentStatuses,SPEC.cloudItemStatuses)){
    fail(`items รอบปัจจุบันไม่ตรงหลักฐาน 1,937 รายการ (${current.size}; ${JSON.stringify(currentStatuses)}) — หยุด`);
  }
  const sessionJson=raw.session_data_json;
  const sessionHash=await sha256Hex(new TextEncoder().encode(sessionJson));
  const itemsJson=mapContentJson(all);
  const itemsHash=await sha256Hex(new TextEncoder().encode(itemsJson));
  return{
    sessionRef,
    schemaValue,
    raw,
    session,
    sessionJson,
    sessionHash,
    sessionBytes:new TextEncoder().encode(sessionJson).length,
    staleBlobScanDataSize,
    all,
    current,
    currentStatuses,
    itemsHash
  };
}
function printSchemaRepairDryRun(snapshot){
  const report={
    cloudSchemaVersion:snapshot.schemaValue===null?'(missing)':snapshot.schemaValue,
    countResetAt:SPEC.epoch,
    sessionBytes:snapshot.sessionBytes,
    staleBlobScanData:snapshot.staleBlobScanDataSize,
    currentEpochItems:snapshot.current.size,
    currentStatuses:snapshot.currentStatuses,
    allItemDocuments:snapshot.all.size,
    sessionSha256:snapshot.sessionHash,
    itemsSha256:snapshot.itemsHash,
    plannedWrite:snapshot.schemaValue===SPEC.schemaVersion?'none':'merge schemaVersion: 2 only'
  };
  console.group('[SRC schema repair] DRY RUN — ยังไม่ได้เขียนข้อมูล');
  console.table(report);
  console.table(snapshot.currentStatuses);
  console.groupEnd();
  return report;
}
async function backupSchemaRepairSnapshot(snapshot){
  const items={};
  for(const[sku,item]of snapshot.all)items[sku]=item;
  const data={
    capturedAt:new Date().toISOString(),
    purpose:'before-schema-version-repair',
    branch:SPEC.branch,
    expectedCountResetAt:SPEC.epoch,
    sessionSha256:snapshot.sessionHash,
    itemsSha256:snapshot.itemsHash,
    sessionDocument:snapshot.raw,
    items
  };
  const dataJson=JSON.stringify(data);
  const dataSha256=await sha256Hex(new TextEncoder().encode(dataJson));
  const archive={backupType:'SRC_CLOUD_BEFORE_SCHEMA_REPAIR',backupVersion:1,dataSha256,data};
  const stamp=data.capturedAt.replace(/[:.]/g,'-');
  const fileName=`SRC-cloud-before-schema-repair-${stamp}.json`;
  downloadJsonFile(fileName,JSON.stringify(archive));
  globalThis.__SRC_SCHEMA_REPAIR_CLOUD_BACKUP__={fileName,dataSha256,archive};
  console.info(`[SRC schema repair] สำรอง Cloud แล้ว: ${fileName} (SHA-256 ${dataSha256})`);
  return{fileName,dataSha256,itemCount:snapshot.all.size};
}
async function repairSrcSchemaVersion(options={}){
  const before=await readSchemaRepairSnapshot();
  const dryRun=printSchemaRepairDryRun(before);
  globalThis.__SRC_SCHEMA_REPAIR_LAST_REPORT__={stage:'dry-run',...dryRun};
  if(before.schemaValue===SPEC.schemaVersion){
    const report={stage:'already-repaired',...dryRun};
    globalThis.__SRC_SCHEMA_REPAIR_LAST_REPORT__=report;
    console.info('[SRC schema repair] Cloud เป็น schema v2 อยู่แล้ว — ไม่ได้เขียนอะไร');
    return report;
  }
  if(options.dryRun){
    globalThis.__SRC_SCHEMA_REPAIR_DRY_RUN__={
      sessionHash:before.sessionHash,
      itemsHash:before.itemsHash,
      epoch:SPEC.epoch,
      at:Date.now()
    };
    console.info('[SRC schema repair] dryRun=true — ไม่ได้เขียนข้อมูล');
    return globalThis.__SRC_SCHEMA_REPAIR_LAST_REPORT__;
  }
  const prior=globalThis.__SRC_SCHEMA_REPAIR_DRY_RUN__;
  if(!prior||prior.sessionHash!==before.sessionHash||prior.itemsHash!==before.itemsHash||
    prior.epoch!==SPEC.epoch||Date.now()-prior.at>30*60*1000){
    fail('ต้องรัน await repairSrcSchemaVersion({dryRun:true}) ให้ผ่านใน Console เดียวกันก่อน — ยังไม่ได้เขียนข้อมูล');
  }
  const cloudBackup=await backupSchemaRepairSnapshot(before);
  const phrase='REPAIR SRC SCHEMA 2';
  const answer=prompt(
    `สำรอง Cloud เป็น ${cloudBackup.fileName} แล้ว\n`+
    `items รอบปัจจุบันครบ ${before.current.size} รายการ\n`+
    `transaction จะ merge เฉพาะ schemaVersion: 2\n`+
    `ไม่เขียนหรือลบ session_data_json และ items\n\n`+
    `พิมพ์ ${phrase} เพื่อดำเนินการ:`
  );
  if(answer!==phrase){
    console.warn('[SRC schema repair] ยกเลิก — ไม่ได้เขียนข้อมูล');
    return globalThis.__SRC_SCHEMA_REPAIR_LAST_REPORT__;
  }

  const transactionResult=await _db.runTransaction(async tx=>{
    const freshDoc=await tx.get(before.sessionRef);
    if(!freshDoc.exists)fail('session SRC หายระหว่างซ่อม');
    const freshRaw=freshDoc.data()||{};
    const freshSchema=freshRaw.schemaVersion===undefined||freshRaw.schemaVersion===null?null:Number(freshRaw.schemaVersion);
    if(freshSchema===SPEC.schemaVersion)return{changed:false,already:true};
    if(freshSchema!==null&&freshSchema!==1)fail(`schemaVersion เปลี่ยนกลางงาน (${freshRaw.schemaVersion})`);
    if(freshRaw.session_data_json!==before.sessionJson)fail('session_data_json เปลี่ยนกลางงาน — หยุดโดยไม่เขียน');
    let freshSession;
    try{freshSession=JSON.parse(freshRaw.session_data_json);}
    catch(e){fail(`session_data_json อ่านไม่ออกกลางงาน (${e.message})`);}
    if((freshSession.countResetAt||'')!==SPEC.epoch||
      Object.keys(freshSession.scanData||{}).length!==SPEC.staleBlobScanDataSize){
      fail('epoch หรือจำนวน blob เปลี่ยนกลางงาน — หยุดโดยไม่เขียน');
    }
    // จุดเขียนเพียงจุดเดียวของ schema repair: merge field เดียว ไม่แตะ blob/items
    tx.set(before.sessionRef,{schemaVersion:SPEC.schemaVersion},{merge:true});
    return{changed:true,already:false};
  });

  const after=await readSchemaRepairSnapshot();
  if(after.schemaValue!==SPEC.schemaVersion)fail('ตรวจหลังเขียนแล้ว schemaVersion ยังไม่เป็น 2');
  if(after.sessionHash!==before.sessionHash||after.sessionJson!==before.sessionJson){
    fail('ตรวจหลังเขียนพบว่า session_data_json เปลี่ยน — กรุณาใช้ไฟล์ Cloud backup และหยุดใช้งาน');
  }
  if(after.itemsHash!==before.itemsHash){
    fail('ตรวจหลังเขียนพบว่า items เปลี่ยนระหว่างงาน — schema repair ไม่ได้เขียน items กรุณาหยุดและตรวจ concurrent client');
  }
  const verified={
    schemaVersion:after.schemaValue,
    sessionUnchanged:true,
    itemsUnchanged:true,
    currentEpochItems:after.current.size,
    currentStatuses:after.currentStatuses,
    sessionSha256:after.sessionHash,
    itemsSha256:after.itemsHash
  };
  const report={stage:'verified',...dryRun,cloudBackup,transactionResult,verified};
  globalThis.__SRC_SCHEMA_REPAIR_LAST_REPORT__=report;
  console.group('[SRC schema repair] ✅ ซ่อมและตรวจผลสำเร็จ');
  console.table(report);
  console.table(verified.currentStatuses);
  console.groupEnd();
  console.info('รีโหลดหน้า SRC ทุกเครื่องหลังยืนยันว่า deploy รุ่นล่าสุดแล้ว');
  return report;
}
async function readCloudPreflight(backup){
  const sessionRef=_db.collection('stock_sessions').doc(SPEC.branch);
  const sessionDoc=await sessionRef.get({source:'server'});
  if(!sessionDoc.exists)fail('ไม่พบ session SRC บน Cloud');
  const raw=sessionDoc.data()||{};
  if(Number(raw.schemaVersion)!==SPEC.schemaVersion)fail(`Cloud SRC ไม่ใช่ schema v${SPEC.schemaVersion}`);
  const session=parseSessionSnapshot(sessionDoc);
  if(!session)fail('session SRC บน Cloud ว่าง');
  if((session.countResetAt||'')!==SPEC.epoch)fail(`Cloud อยู่คนละรอบนับ (${session.countResetAt||'ว่าง'}) — ห้ามกู้`);
  if(typeof _countResetAt==='undefined'||(_countResetAt||'')!==SPEC.epoch){
    console.warn(`[SRC recovery] local countResetAt ยังเป็น ${typeof _countResetAt==='undefined'?'ไม่ทราบ':(_countResetAt||'ว่าง')}; ใช้รอบจาก Firestore Server ${SPEC.epoch}`);
  }

  const itemsRef=_db.collection('stock_sessions').doc(SPEC.branch).collection('items');
  let snapshot;
  try{snapshot=await itemsRef.get({source:'server'});}
  catch(e){fail(`อ่าน items จาก Cloud ไม่สำเร็จ (${e.code||e.message})`);}
  const all=new Map();
  const current=new Map();
  snapshot.forEach(doc=>{
    const item=doc.data()||{};
    all.set(doc.id,item);
    if(String(item.countResetAt||'')===SPEC.epoch)current.set(doc.id,item);
  });
  const candidates=Object.entries(backup.session.scanData||{})
    .filter(([,item])=>item&&CONFIRMED_STATUSES.has(item.status))
    .sort(([a],[b])=>a.localeCompare(b));
  const missing=[];
  const different=[];
  const blockedExisting=[];
  let same=0;
  for(const[sku,item]of candidates){
    const id=String(sku);
    const cloudItem=current.get(id);
    if(!cloudItem){
      const existing=all.get(id);
      if(existing){blockedExisting.push({sku:id,backup:item,cloud:existing});continue;}
      missing.push([id,item]);
      continue;
    }
    if(essentialDifference(item,cloudItem))different.push({sku:String(sku),backup:item,cloud:cloudItem});
    else same++;
  }
  return{sessionRef,sessionRaw:raw,itemsRef,all,current,candidates,missing,different,blockedExisting,same};
}
function printPreflight(validated,cloud){
  const report={
    backupFile:SPEC.fileName,
    fileSha256:validated.fileHash,
    countResetAt:SPEC.epoch,
    backupCompleted:cloud.candidates.length,
    cloudCurrentEpoch:cloud.current.size,
    cloudAllEpochs:cloud.all.size,
    alreadySame:cloud.same,
    existingDifferentSkipped:cloud.different.length,
    existingOtherEpochBlocked:cloud.blockedExisting.length,
    missingToWrite:cloud.missing.length,
    missingByStatus:countsByStatus(cloud.missing,entry=>entry[1])
  };
  console.group('[SRC recovery] DRY RUN — ยังไม่ได้เขียนข้อมูล');
  console.table(report);
  console.table(report.missingByStatus);
  if(cloud.different.length){
    console.warn(`พบ ${cloud.different.length} SKU ที่ Cloud มีอยู่แล้วแต่ข้อมูลต่างจาก backup — จะข้ามทั้งหมด ไม่เขียนทับ`);
    console.table(cloud.different.slice(0,20).map(row=>({
      sku:row.sku,
      backupStatus:row.backup.status,
      cloudStatus:row.cloud.status,
      backupQty:row.backup.countedQty,
      cloudQty:row.cloud.countedQty
    })));
  }
  if(cloud.blockedExisting.length){
    console.error(`พบ ${cloud.blockedExisting.length} SKU ที่มี document เดิมใน epoch อื่น — บล็อกการกู้ทั้งหมดเพื่อไม่เขียนทับข้อมูลเดิม`);
    console.table(cloud.blockedExisting.slice(0,20).map(row=>({
      sku:row.sku,
      backupStatus:row.backup.status,
      existingStatus:row.cloud.status,
      existingEpoch:row.cloud.countResetAt||''
    })));
  }
  console.groupEnd();
  return report;
}
async function writeMissingTransactionally(cloud){
  let written=0;
  let skippedExisting=0;
  for(let offset=0;offset<cloud.missing.length;offset+=TX_CHUNK_SIZE){
    const chunk=cloud.missing.slice(offset,offset+TX_CHUNK_SIZE);
    const result=await _db.runTransaction(async tx=>{
      const sessionDoc=await tx.get(cloud.sessionRef);
      if(!sessionDoc.exists)fail('session SRC หายระหว่างกู้');
      const raw=sessionDoc.data()||{};
      const session=parseSessionSnapshot(sessionDoc);
      if(Number(raw.schemaVersion)!==SPEC.schemaVersion||(session?.countResetAt||'')!==SPEC.epoch){
        fail(`รอบนับเปลี่ยนระหว่างกู้ (${session?.countResetAt||'ว่าง'})`);
      }
      const refs=chunk.map(([sku])=>cloud.itemsRef.doc(String(sku)));
      const docs=await Promise.all(refs.map(ref=>tx.get(ref)));
      let chunkWritten=0;
      let chunkSkipped=0;
      docs.forEach((doc,index)=>{
        const[sku,item]=chunk[index];
        const old=doc.exists?(doc.data()||{}):null;
        // ห้ามทับ document เดิมทุกกรณี แม้เป็น epoch เก่า หรือเพิ่งถูกสร้างหลัง dry-run
        if(old){chunkSkipped++;return;}
        tx.set(refs[index],makePayload(sku,item,null),{merge:false});
        chunkWritten++;
      });
      return{written:chunkWritten,skippedExisting:chunkSkipped};
    });
    written+=result.written;
    skippedExisting+=result.skippedExisting;
    console.info(`[SRC recovery] ${Math.min(offset+chunk.length,cloud.missing.length)}/${cloud.missing.length} ตรวจแล้ว — เขียนสะสม ${written}, ข้าม document เดิม ${skippedExisting}`);
    if(offset+chunk.length<cloud.missing.length)await sleep(TX_PAUSE_MS);
  }
  return{written,skippedExisting};
}
async function verifyRecovery(candidates){
  const sessionRef=_db.collection('stock_sessions').doc(SPEC.branch);
  const sessionDoc=await sessionRef.get({source:'server'});
  const session=parseSessionSnapshot(sessionDoc);
  if(!sessionDoc.exists||Number(sessionDoc.data()?.schemaVersion)!==SPEC.schemaVersion||(session?.countResetAt||'')!==SPEC.epoch){
    fail('รอบนับหรือ schema เปลี่ยนก่อนตรวจผล');
  }
  const snapshot=await sessionRef.collection('items').where('countResetAt','==',SPEC.epoch).get({source:'server'});
  const finalItems=new Map();
  snapshot.forEach(doc=>finalItems.set(doc.id,doc.data()||{}));
  const absent=candidates.filter(([sku])=>!finalItems.has(String(sku))).map(([sku])=>String(sku));
  if(absent.length)fail(`ตรวจหลังเขียนแล้วยังขาด ${absent.length} SKU (ตัวอย่าง ${absent.slice(0,10).join(', ')})`);
  return{
    cloudCurrentEpoch:finalItems.size,
    backupCandidatesPresent:candidates.length,
    finalByStatus:countsByStatus([...finalItems.values()])
  };
}

async function recoverSrcMissingItems(options={}){
  assertAppReady();
  const file=options.file||await chooseBackupFile();
  const validated=await validateBackupFile(file);
  const cloud=await readCloudPreflight(validated.backup);
  const dryRun=printPreflight(validated,cloud);
  globalThis.__SRC_RECOVERY_LAST_REPORT__={stage:'dry-run',...dryRun};
  if(options.dryRun){
    globalThis.__SRC_RECOVERY_DRY_RUN__={fileHash:validated.fileHash,epoch:SPEC.epoch,at:Date.now()};
    console.info('[SRC recovery] dryRun=true — ไม่ได้เขียนข้อมูล');
    return globalThis.__SRC_RECOVERY_LAST_REPORT__;
  }
  const priorDryRun=globalThis.__SRC_RECOVERY_DRY_RUN__;
  if(!priorDryRun||priorDryRun.fileHash!==validated.fileHash||priorDryRun.epoch!==SPEC.epoch||Date.now()-priorDryRun.at>30*60*1000){
    fail('ต้องรัน await recoverSrcMissingItems({dryRun:true}) ให้ผ่านใน Console เดียวกันก่อน — ยังไม่ได้เขียนข้อมูล');
  }
  if(cloud.blockedExisting.length){
    fail(`พบ document เดิมใน epoch อื่น ${cloud.blockedExisting.length} SKU จึงหยุดเพื่อไม่ให้ข้อมูลเดิมหาย — ยังไม่ได้เขียนข้อมูล`);
  }
  if(!cloud.missing.length){
    const verified=await verifyRecovery(cloud.candidates);
    globalThis.__SRC_RECOVERY_LAST_REPORT__={stage:'already-complete',...dryRun,verified};
    console.info('[SRC recovery] Cloud มีรายการจาก backup ครบแล้ว — ไม่ได้เขียนอะไร');
    return globalThis.__SRC_RECOVERY_LAST_REPORT__;
  }
  const cloudBackup=await backupCloudBeforeWrite(validated,cloud);
  const phrase=`RESTORE SRC ${cloud.missing.length}`;
  const answer=prompt(
    `ตรวจไฟล์และรอบนับผ่านแล้ว\n`+
    `สำรอง Cloud ก่อนเขียนเป็น ${cloudBackup.fileName} แล้ว\n`+
    `จะเขียนเฉพาะ ${cloud.missing.length} SKU ที่ Cloud ยังไม่มี\n`+
    `จะไม่ทับ document เดิม ${cloud.all.size} SKU ไม่ว่าจะเป็น epoch ใด\n\n`+
    `พิมพ์ ${phrase} เพื่อดำเนินการ:`
  );
  if(answer!==phrase){
    console.warn('[SRC recovery] ยกเลิก — ไม่ได้เขียนข้อมูล');
    return globalThis.__SRC_RECOVERY_LAST_REPORT__;
  }
  let writeResult;
  try{writeResult=await writeMissingTransactionally(cloud);}
  catch(e){
    console.error('[SRC recovery] หยุดกลางทางอย่างปลอดภัย:',e);
    console.error('รายการที่ commit แล้วไม่เสียหาย รันคำสั่งเดิมซ้ำได้ ระบบจะข้ามรายการที่มีแล้ว');
    globalThis.__SRC_RECOVERY_LAST_REPORT__={stage:'partial',...dryRun,error:e.message};
    throw e;
  }
  const verified=await verifyRecovery(cloud.candidates);
  const finalReport={stage:'verified',...dryRun,cloudBackup,...writeResult,verified};
  globalThis.__SRC_RECOVERY_LAST_REPORT__=finalReport;
  console.group('[SRC recovery] ✅ กู้คืนและตรวจผลสำเร็จ');
  console.table(finalReport);
  console.table(verified.finalByStatus);
  console.groupEnd();
  console.info('รีโหลดหน้า แล้วเปิด Dashboard เพื่อตรวจยอดอีกครั้ง');
  return finalReport;
}

globalThis.validateSrcLocalBackup=async file=>validateBackupFile(file||await chooseBackupFile());
globalThis.recoverSrcMissingItems=recoverSrcMissingItems;
globalThis.repairSrcSchemaVersion=repairSrcSchemaVersion;
console.info('[SRC recovery] Helper พร้อมแล้ว — เริ่มด้วย await recoverSrcMissingItems({dryRun:true})');
console.info('[SRC schema repair] เริ่มตรวจด้วย await repairSrcSchemaVersion({dryRun:true})');
})();
