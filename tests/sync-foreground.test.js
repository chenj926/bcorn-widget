'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const Foreground=require('../src/shared/sync-adapters/foreground-sync');
function fixture(reconcile){let clock=0,seq=0;const timers=new Map();const scheduler=Foreground.createScheduler({reconcile,now:()=>clock,schedule:(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:clock+ms});return id;},cancel:id=>timers.delete(id)});return{scheduler,timers,async advance(ms){clock+=ms;const due=[...timers].filter(([,t])=>t.at<=clock);for(const[id,t]of due){timers.delete(id);await t.fn();}await new Promise(resolve=>setImmediate(resolve));},now:()=>clock};}
test('visible automatic checks adapt from 15 to 120 seconds and activity does not postpone a nearer check',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return{changed:false,status:'synced'};});f.scheduler.start(false);assert.equal(f.scheduler.snapshot().nextCheckAt,15000);
 await f.advance(15000);assert.equal(calls,1);assert.equal(f.scheduler.snapshot().intervalMs,30000);
 await f.advance(30000);assert.equal(f.scheduler.snapshot().intervalMs,60000);
 await f.advance(60000);assert.equal(f.scheduler.snapshot().intervalMs,120000);
 f.scheduler.activity();assert.equal(f.scheduler.snapshot().nextCheckAt,f.now()+15000);await f.advance(5000);f.scheduler.activity();assert.equal(f.scheduler.snapshot().nextCheckAt,f.now()+10000);f.scheduler.dispose();assert.equal(f.timers.size,0);
});
test('hidden and offline stop all timers, resume/reconnect trigger immediate reconciliation',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return{changed:true};});f.scheduler.start();await f.advance(0);assert.equal(calls,1);
 f.scheduler.setVisible(false);assert.equal(f.timers.size,0);await f.advance(600000);assert.equal(calls,1);
 f.scheduler.setVisible(true);await f.advance(0);assert.equal(calls,2);
 f.scheduler.setOnline(false);assert.equal(f.timers.size,0);f.scheduler.setVisible(false);f.scheduler.setOnline(true);assert.equal(f.timers.size,0);
 f.scheduler.setVisible(true);await f.advance(0);assert.equal(calls,3);
});
test('notifications never create concurrent requests and hide cancels queued continuation',async()=>{
 let finish,calls=0;const f=fixture(()=>{calls++;return new Promise(resolve=>{finish=resolve;});});f.scheduler.start();await f.advance(0);assert.equal(calls,1);
 await f.scheduler.trigger();await f.scheduler.trigger();assert.equal(calls,1);f.scheduler.setVisible(false);finish({changed:true});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.timers.size,0);assert.equal(calls,1);
});
test('rate-limit retry-after and revoked authorization stop aggressive checks',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return calls===1?{retryAfterMs:300000}:{status:'revoked'};});f.scheduler.start();await f.advance(0);assert.equal(f.scheduler.snapshot().nextCheckAt,300000);
 f.scheduler.activity();assert.equal(f.scheduler.snapshot().nextCheckAt,300000);await f.advance(300000);assert.equal(f.scheduler.snapshot().enabled,false);assert.equal(f.timers.size,0);
});
