'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const Sheets=require('../src/shared/sync-adapters/google-sheets');const Foreground=require('../src/shared/sync-adapters/foreground-sync');
test('synthetic ten-minute idle request budget: eight metadata requests, one sheet read, zero hidden wakeups',async()=>{
 let clock=0,seq=0,metadata=0,sheetReads=0,wakeups=0,version='1';const timers=new Map();
 const adapter=Sheets.createAdapter({binding:{spreadsheetId:'synthetic-file',tab:'Assessments',confirmed:true},authorizationStatus:async()=> 'ready',getVersion:async()=>{metadata++;return{version};},request:async()=>{sheetReads++;return{status:200,body:{values:[Sheets.HEADERS]}};}});
 await adapter.read();const scheduler=Foreground.createScheduler({now:()=>clock,schedule:(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:clock+ms});return id;},cancel:id=>timers.delete(id),reconcile:async()=>{await adapter.read();return{changed:false,status:'synced'};}});scheduler.start(false);
 async function until(end){while(timers.size){const[id,timer]=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(timer.at>end)break;clock=timer.at;timers.delete(id);wakeups++;timer.fn();await new Promise(resolve=>setImmediate(resolve));}clock=end;}
 await until(600000);assert.equal(wakeups,7);assert.equal(metadata,8);assert.equal(sheetReads,1);
 scheduler.setVisible(false);await until(1200000);assert.equal(wakeups,7);assert.equal(metadata,8);assert.equal(timers.size,0);
 version='2';scheduler.setVisible(true);await until(1200000);assert.equal(metadata,9);assert.equal(sheetReads,2);scheduler.dispose();
 // These are synthetic request/timer counts, not battery or real-device energy measurements.
});
