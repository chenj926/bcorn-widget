/* Synthetic actual renderer import/export integration; no real files, accounts or native cloud calls. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8');
const dom=new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g,''),{url:'https://bcorn.test',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
w.TextEncoder=TextEncoder;w.HTMLElement.prototype.scrollIntoView=function(){};w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'))};
const clone=x=>JSON.parse(JSON.stringify(x));
let disk={terms:[{id:'fall',name:'Fall',start:'2026-09-01',end:'2026-12-20',courses:[{code:'EDITED',title:'Edited course',address:'New address'}],meetings:[{id:'local',code:'EDITED',day:1,start:'09:00',end:'10:00',address:'Edited room'}]}],transcript:{cgpa:'3.50',sessions:[]}};
let book={schemaVersion:1,courses:[{id:'local-course',title:'Notebook',rules:{kind:'weighted'},assessments:[{id:'zero',title:'Zero',weight:.5,status:'graded',score:{mode:'ratio',value:0}},{id:'later',title:'Pending',weight:.5,status:'ungraded',score:null}]}]}, exported,writeCount=0,calendarPauses=0,failNext=false;
const errors=[];w.addEventListener('error',e=>errors.push(e.error?.message||e.message));w.localStorage.setItem('map-provider','amap');w.localStorage.setItem('oauthToken','never-export');
w.acorn={capabilities:{login:false,refresh:false,pin:false},getState:async()=>({data:disk,status:{state:'unsupported'}}),onUpdate(){},onPinned(){},saveData:async data=>{writeCount++;if(failNext){failNext=false;throw Error('Synthetic write failed')}disk=clone(data);return{ok:true}},loadGradeBook:async()=>clone(book),saveGradeBook:async value=>{writeCount++;book=clone(value);return{ok:true}},exportCalendar:async value=>{exported=value;return{ok:true}}};
for(const [,file] of html.matchAll(/<script src="([^"]+)"/g)){w.eval(fs.readFileSync(path.resolve(root,'src/renderer',file),'utf8') + (file === 'app.js' ? '\nwindow.exportDialog=exportDialog;window.readImport=readImport;window.openImport=openImport;' : ''));}
const pause=()=>new Promise(r=>setTimeout(r,20)),q=s=>{const e=w.document.querySelector(s);assert.ok(e,s);return e};
const click=async s=>{q(s).click();await pause()};
const importFile=async data=>{await w.readImport({size:JSON.stringify(data).length,text:async()=>JSON.stringify(data)});await pause()};
(async()=>{await pause();
// Wrap actual pause hook, then exercise actual export form and import confirmation handlers.
const original=w.CalendarIntegration;w.CalendarIntegration={...original,pauseForImport:async()=>{calendarPauses++;await original.pauseForImport?.()}};
w.exportDialog(null,null,true);q('#export-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await pause();assert.ok(exported);const backup=JSON.parse(exported.content);assert.equal(backup.format,'bcorn-user-backup');assert.equal(backup.gradebook.courses[0].assessments[0].score.value,0);assert.equal(backup.gradebook.courses[0].assessments[1].status,'ungraded');assert.equal(backup.preferences['map-provider'],'amap');assert.doesNotMatch(exported.content,/never-export|oauthToken/);
backup.timetable.terms[0].courses[0].title='Restored edited title';backup.gradebook.courses[0].title='Replacement notebook';
await importFile(backup);assert.equal(writeCount,0);assert.equal(q('#import-replace-grades').checked,false);await click('[data-action="confirm-import"]');assert.equal(disk.terms[0].courses[0].title,'Restored edited title');assert.equal(book.courses[0].title,'Notebook');assert.equal(calendarPauses,1);
await importFile(backup);q('#import-replace-grades').checked=true;await click('[data-action="confirm-import"]');assert.equal(book.courses[0].title,'Replacement notebook');assert.equal(disk.terms[0].meetings[0].address,'Edited room');
const count=writeCount,pauses=calendarPauses;const bad=clone(backup);bad.gradebook.courses[0].assessments[0].weight=2;w.openImport();await importFile(bad);assert.ok(q('#import-error').textContent);assert.equal(writeCount,count);assert.equal(calendarPauses,pauses);
const before=clone(book);backup.gradebook.courses[0].title='Must roll back';await importFile(backup);q('#import-replace-grades').checked=true;failNext=true;await click('[data-action="confirm-import"]');assert.match(q('#import-error').textContent,/已恢复/);assert.deepEqual(book,before);
await importFile({terms:[]});assert.equal(w.document.querySelector('#import-replace-grades'),null);await click('[data-action="confirm-import"]');assert.deepEqual(disk.terms,[]);assert.deepEqual(book,before);
// Empty timetable must not prevent backing up the independent assessment book.
w.exportDialog(null,null,true);q('#export-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await pause();assert.equal(JSON.parse(exported.content).gradebook.courses.length,1);
assert.deepEqual(errors,[]);console.log('PASS actual backup DOM: export, preview, opt-in replacement, legacy preservation, invalid no-write, rollback, edited address, zero/ungraded, paused calendar, empty timetable.');w.close();})().catch(e=>{console.error(e);w.close();process.exitCode=1});
