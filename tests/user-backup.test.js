'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Backup=require('../src/shared/user-backup');
const timetable={terms:[{id:'fall',name:'Fall',start:'2026-09-01',end:'2026-12-20',courses:[{code:'EDITED',title:'Edited title',address:'New course address'}],meetings:[{id:'local-meeting',code:'EDITED',day:1,start:'09:00',end:'10:00',address:'New meeting address'}]}],transcript:{cgpa:'3.5',sessions:[]}};
const gradebook={schemaVersion:1,courses:[{id:'local-course',title:'Course',rules:{kind:'weighted'},assessments:[{id:'zero',title:'Zero',weight:.5,status:'graded',score:{mode:'ratio',value:0}},{id:'pending',title:'Pending',weight:.5,status:'ungraded',score:null}]}]};
const clone=x=>JSON.parse(JSON.stringify(x));
test('portable backup roundtrip preserves edited courses, addresses, zero and ungraded; excludes unknown sensitive fields at every boundary',()=>{
 const data=clone(timetable),book=clone(gradebook);data.oauthToken='secret';data.calendarLinks={ownedIds:['remote']};data.terms[0].meetings[0].remoteId='remote';book.journal={token:'secret'};book.courses[0].binding={sheetId:'remote'};
 const value=Backup.create(data,book,{tab:'grades','map-provider':'amap',token:'secret',binding:'remote'}),parsed=Backup.parse(JSON.stringify(value));
 assert.equal(parsed.timetable.terms[0].courses[0].title,'Edited title');assert.equal(parsed.timetable.terms[0].meetings[0].address,'New meeting address');assert.equal(parsed.gradebook.courses[0].assessments[0].score.value,0);assert.equal(parsed.gradebook.courses[0].assessments[1].score,null);assert.doesNotMatch(JSON.stringify(value),/secret|remote|oauthToken|journal|binding/);
});
function fixture(){let state={timetable:{terms:[]},grades:{schemaVersion:1,courses:[]},preferences:{tab:'term'}};let writes=[];return {state,writes,io:{loadTimetable:async()=>clone(state.timetable),loadGrades:async()=>clone(state.grades),loadPreferences:async()=>clone(state.preferences),saveTimetable:async v=>{writes.push('timetable');state.timetable=clone(v)},saveGrades:async v=>{writes.push('grades');state.grades=clone(v)},savePreferences:async v=>{writes.push('preferences');state.preferences=clone(v)}}};}
test('invalid gradebook/version/preference rejects before any store read/write',async()=>{
 for(const mutate of [b=>b.gradebook.courses[0].assessments[0].weight=2,b=>b.backupVersion=99,b=>b.preferences.tab='invalid']){const value=Backup.create(timetable,gradebook,{});mutate(value);await assert.rejects(Backup.restore(value,new Proxy({},{get(){throw Error('I/O must not run')}}),{replaceGrades:true}));}
});
test('explicit replacement required; legacy preserves grades and preferences',async()=>{const f=fixture();await Backup.restore(Backup.create(timetable,gradebook,{}),f.io);assert.equal(f.state.grades.courses.length,0);assert.ok(!f.writes.includes('grades'));const g=fixture();await Backup.restore(timetable,g.io,{replaceGrades:true});assert.deepEqual(g.writes,['timetable']);});
test('failed second write rolls back both stores, including uncertain partial write',async()=>{const f=fixture(),before=clone(f.state);let fail=true;const save=f.io.saveTimetable;f.io.saveTimetable=async v=>{await save(v);if(fail){fail=false;throw Error('disk failure')}};await assert.rejects(Backup.restore(Backup.create(timetable,gradebook,{}),f.io,{replaceGrades:true}),/已恢复/);assert.deepEqual(f.state,before);});
test('rollback failure is explicit and never reports import success',async()=>{const f=fixture();f.io.saveTimetable=async()=>{throw Error('disk unavailable')};await assert.rejects(Backup.restore(Backup.create(timetable,gradebook,{}),f.io,{replaceGrades:true}),/回滚未确认成功/);});

test('envelope cap permits separate stores but enforces each independent store cap',()=>{
 const value=Backup.create(timetable,gradebook,{});
 value.gradebook.ignored='x'.repeat(2*1024*1024);
 assert.throws(()=>Backup.parse(value),/作业成绩部分/);
 delete value.gradebook.ignored;value.timetable.ignored='x'.repeat(2*1024*1024);
 assert.throws(()=>Backup.parse(value),/2 MiB/);
 delete value.timetable.ignored;value.ignored='x'.repeat(5*1024*1024);
 assert.throws(()=>Backup.parse(value),/5 MiB/);
 assert.equal(Backup.MAX_BYTES,5*1024*1024);
});
test('full backup roundtrips a valid aggregate larger than 2 MiB',()=>{
 const data=clone(timetable);data.terms[0].courses=Array.from({length:400},(_,i)=>({code:i?'C'+i:'EDITED',title:'T'.repeat(3000)}));
 const book={schemaVersion:1,courses:Array.from({length:2},(_,i)=>({id:'course'+i,title:'Course',rules:{kind:'weighted'},assessments:Array.from({length:600},(_,j)=>({id:'assessment'+j,title:'A'.repeat(1000),weight:0,status:'ungraded',score:null}))}))};
 const value=Backup.create(data,book,{}),text=JSON.stringify(value,null,2);
 assert.ok(Buffer.byteLength(text)>2*1024*1024);assert.ok(Buffer.byteLength(text)<Backup.MAX_BYTES);
 const result=Backup.parse(text);assert.equal(result.gradebook.courses[1].assessments.length,600);assert.equal(result.timetable.terms[0].courses.length,400);
});
