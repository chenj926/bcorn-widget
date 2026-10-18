'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const Service=require('../src/shared/sync-adapters/grade-sync');const Sheets=require('../src/shared/sync-adapters/google-sheets');
const copy=x=>JSON.parse(JSON.stringify(x));
const book=()=>({schemaVersion:1,courses:[{id:'synthetic-course',title:'Course',termId:'term',rules:{kind:'weighted'},assessments:[{id:'a',title:'A',weight:1,status:'graded',score:{mode:'ratio',value:0}}]},{id:'empty-course',title:'Empty',termId:'term',rules:{kind:'unconfirmed'},assessments:[]}]});
function fixture(){let local=book(),journal=null;const remote={};const bookStore={load:async()=>copy(local),save:async b=>{local=copy(b);return b;}};const syncStore={load:async()=>journal&&copy(journal),save:async s=>{journal=copy(s);}};const adapter={status:async()=>({state:'ready',automaticInbound:true}),read:async()=>Object.entries(remote).map(([id,value])=>({id,value})),write:async({id,value})=>{remote[id]=copy(value);return value;}};return{remote,bookStore,syncStore,adapter,getLocal:()=>copy(local),getJournal:()=>copy(journal),make:()=>Service.createService({bookStore,syncStore,adapter,deviceId:'synthetic-device'})};}
test('normalized rows roundtrip complete books including empty courses and graded zero',()=>{
 const records=Service.recordsFromBook(book());assert.deepEqual(Service.bookFromRecords(records),book());
 const decoded=records.map(r=>Sheets.decodeRow(Sheets.encodeRecord(r.id,r.value),2));assert.deepEqual(Service.bookFromRecords(decoded),book());
});
test('local and sheet edits synchronize automatically through facade and survive restart',async()=>{
 const f=fixture();let service=f.make();await service.start();assert.equal(Object.keys(f.remote).length,3);
 const next=f.getLocal();next.courses[0].assessments[0].score.value=.8;await service.saveBook(next);await service.idle();const key=Object.keys(f.remote).find(k=>k.startsWith('assessment:'));assert.equal(f.remote[key].score.value,.8);
 f.remote[key].score.value=.9;await service.notifyRemoteChange();assert.equal(f.getLocal().courses[0].assessments[0].score.value,.9);
 service.dispose();service=f.make();await service.start();assert.equal(f.getLocal().courses[0].assessments[0].score.value,.9);
});
test('course deletion carries explicit tombstones for its assessments and preserves other courses',async()=>{
 const f=fixture(),service=f.make();await service.start();const next=f.getLocal();next.courses.shift();await service.saveBook(next);await service.idle();assert.equal(Object.values(f.remote).filter(v=>v===null).length,2);assert.equal(f.getLocal().courses[0].id,'empty-course');
});
test('new remote course is retained when local save did not observe it',async()=>{
 const f=fixture(),service=f.make();await service.start();const remoteBook={schemaVersion:1,courses:[{id:'other',title:'Remote',termId:'',rules:{kind:'weighted'},assessments:[]}]};for(const r of Service.recordsFromBook(remoteBook))f.remote[r.id]=r.value;
 const next=f.getLocal();next.courses[0].title='Local title';await service.saveBook(next);await service.idle();assert.equal(f.getLocal().courses.length,3);
});
test('changed stable IDs, unknown parent and invalid journal are rejected',async()=>{
 const records=Service.recordsFromBook(book());records[0].id='changed';assert.throws(()=>Service.bookFromRecords(records));
 assert.throws(()=>Service.bookFromRecords(Service.recordsFromBook(book()).filter(r=>!r.id.startsWith('course:'))));
 const f=fixture();f.syncStore.load=async()=>({schemaVersion:99});await assert.rejects(f.make().start(),e=>e.code==='invalid-storage');
});
