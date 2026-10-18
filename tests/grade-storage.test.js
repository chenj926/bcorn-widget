'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const UI=require('../src/renderer/grades-ui');
const book=()=>({schemaVersion:1,courses:[{id:'synthetic',title:'Synthetic course',termId:'synthetic-term',rules:{kind:'weighted'},assessments:[{id:'a',title:'A',weight:1,status:'graded',score:{mode:'points',earned:0,possible:10}}]}]});
test('native independent grade persistence roundtrips without touching timetable or transcript',async()=>{
 let disk=null;const calls=[];const bridge={loadGradeBook:async()=>{calls.push('load');return disk;},saveGradeBook:async value=>{calls.push('save');disk=structuredClone(value);return{ok:true};}};
 const store=UI.createStorage(bridge);assert.equal(store.kind,'native');assert.deepEqual(await store.load(),{schemaVersion:1,courses:[]});
 await store.save(book());assert.deepEqual(await UI.createStorage(bridge).load(),book());assert.deepEqual(calls,['load','save','load']);
});
test('unsupported and corrupt grade versions never silently replace stored data',async()=>{
 const original={schemaVersion:999,courses:[]};let writes=0;
 const store=UI.createStorage({loadGradeBook:async()=>original,saveGradeBook:async()=>{writes++;return{ok:true};}});
 await assert.rejects(store.load());await assert.rejects(store.save(original));assert.equal(writes,0);
});
test('failed save is not acknowledged and native failure never downgrades to browser storage',async()=>{
 let fallbackWrites=0;const store=UI.createStorage({loadGradeBook:async()=>book(),saveGradeBook:async()=>({ok:false})},{setItem(){fallbackWrites++;}});
 await assert.rejects(store.save(book()));assert.equal(fallbackWrites,0);
});
test('explicit web preview storage is isolated, versioned and normalized',async()=>{
 const disk=new Map([['timetable','unchanged']]);const store=UI.createStorage(null,{getItem:k=>disk.get(k),setItem:(k,v)=>disk.set(k,v)});
 const input=book();input.credential='synthetic-not-a-secret';await store.save(input);assert.equal(store.kind,'browser-local');assert.equal(disk.get('timetable'),'unchanged');assert.equal((await store.load()).credential,undefined);
});
