'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Sync = require('../src/shared/sync-coordinator');
const copy = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
function fixture() {
 const remote = {}; const saved = { state: null, writes: [], fail: false }; const calls = [];
 const store = { async load() { return copy(saved.state); }, async save(state) { if (saved.fail) throw new Error('disk full'); saved.state = copy(state); saved.writes.push(copy(state)); } };
 const adapter = { async status() { return { state: 'ready', automaticInbound: true }; }, async read() { calls.push('read'); return Object.entries(remote).map(([id, value]) => ({id, value:copy(value)})); }, async write(op) { calls.push(copy(op)); remote[op.id] = copy(op.value); return copy(op.value); } };
 const make = () => Sync.createCoordinator({ store, adapter, deviceId: 'synthetic-device' });
 return { remote, saved, calls, store, adapter, make };
}
test('local edit persists before automatic write and notification automatically imports remote edits', async () => {
 const f = fixture(); const sync = f.make();
 await sync.edit('a', { score: .8 }); await sync.idle(); assert.deepEqual(f.remote.a, {score:.8});
 assert.equal(f.saved.writes[0].status, 'pending'); assert.equal(f.saved.state.status, 'synced');
 f.remote.a.score = .9; await sync.notifyRemoteChange(); assert.equal((await sync.load()).records.a.score, .9);
});
test('disjoint concurrent fields merge; same-field conflicts retain both and block overwrite', async () => {
 assert.deepEqual(Sync.merge({a:1,b:1},{a:2,b:1},{a:1,b:2}),{value:{a:2,b:2},conflicts:[]});
 const f=fixture(); f.remote.a={score:.5,title:'A'}; const sync=f.make(); await sync.onResume();
 f.adapter.status = async()=>({state:'offline'}); await sync.edit('a',{score:.6,title:'A'}); await sync.idle();
 f.remote.a.score=.7; f.adapter.status=async()=>({state:'ready'}); await sync.onOnline();
 const state=await sync.load(); assert.equal(state.status,'conflict'); assert.deepEqual(state.conflicts.a.paths,['/score']);
 assert.equal(state.records.a.score,.6); assert.equal(f.remote.a.score,.7);
 await sync.resolve('a',{score:.65,title:'A'}); await sync.idle(); assert.equal(f.remote.a.score,.65);
});
test('durable pending edits survive process restart and converge after network recovery',async()=>{
 const f=fixture(); f.adapter.read=async()=>{throw Sync.syncError('offline');}; let sync=f.make();
 await sync.edit('a',{score:0}); await sync.idle(); assert.equal(f.saved.state.status,'offline'); sync.dispose();
 f.adapter.read=async()=>[]; sync=f.make(); await sync.onOnline(); assert.deepEqual(f.remote.a,{score:0}); assert.deepEqual(f.saved.state.outbox,{});
});
test('ambiguous completed write retries idempotently with remote read rather than duplicating',async()=>{
 const f=fixture(); const original=f.adapter.write;
 f.adapter.write=async op=>{await original(op);throw Sync.syncError('network-error');}; let clock = 1000; const sync=Sync.createCoordinator({store:f.store,adapter:f.adapter,now:()=>clock});
 await sync.edit('a',{score:1});await sync.idle();assert.equal(f.saved.state.status,'error');
 f.adapter.write=original;clock=10000;await sync.onOnline();assert.equal(f.calls.filter(c=>typeof c==='object').length,1);assert.equal(f.saved.state.status,'synced');
});
test('no configured adapter produces a truthful status and never calls read/write',async()=>{
 const f=fixture();f.adapter.status=async()=>({state:'not-configured',automaticInbound:false});const sync=f.make();
 await sync.edit('a',{score:.5});await sync.idle();assert.equal(f.calls.length,0);assert.equal(f.saved.state.status,'not-configured');assert.ok(f.saved.state.outbox.a);
});
test('failed durable save does not send an edit or leave failed mutation in current state',async()=>{
 const f=fixture();const sync=f.make();await sync.load();f.saved.fail=true;
 await assert.rejects(sync.edit('a',{score:.5}),/disk full/);assert.equal(f.calls.length,0);assert.deepEqual((await sync.load()).records,{});
});
test('remote row disappearance is not a destructive inferred deletion',async()=>{
 const f=fixture();f.remote.a={score:.5};const sync=f.make();await sync.onResume();delete f.remote.a;
 await sync.edit('a',{score:.6});await sync.idle();assert.equal(f.saved.state.conflicts.a.code,'remote-missing');assert.equal(f.remote.a,undefined);
 await assert.rejects(sync.resolve('a',null),error=>error.code==='relink-required');
});
test('duplicate/untrusted remote IDs and non-JSON unsafe IDs are rejected',async()=>{
 assert.throws(()=>Sync.recordsById([{id:'__proto__',value:{}}]));assert.throws(()=>Sync.recordsById([{id:'a',value:1},{id:'a',value:2}]));
 const f=fixture();await assert.rejects(f.make().edit('__proto__',{}));
});
test('revocation prevents further reads and writes while local data remains intact',async()=>{
 const f=fixture();const sync=f.make();await sync.edit('a',{score:.5});await sync.idle();await sync.revoke();
 const count=f.calls.length;await sync.notifyRemoteChange();assert.equal(f.calls.length,count);assert.equal((await sync.load()).records.a.score,.5);
});
test('rate limit is persisted and ignored notifications do not spin until retry time',async()=>{
 const f=fixture();let clock=1000;f.adapter.read=async()=>{throw Sync.syncError('rate-limited','',5000);};
 const sync=Sync.createCoordinator({store:f.store,adapter:f.adapter,now:()=>clock});await sync.onResume();assert.equal(f.saved.state.retryAt,6000);
 const n=f.saved.writes.length;await sync.notifyRemoteChange();assert.equal(f.saved.writes.length,n);
 clock=6000;f.adapter.read=async()=>[];await sync.onOnline();assert.equal(f.saved.state.status,'synced');
});
test('explicit tombstones propagate while arrays and delete-vs-edit conflicts remain atomic',async()=>{
 const f=fixture();f.remote.a={score:1};const sync=f.make();await sync.onResume();await sync.edit('a',null);await sync.idle();assert.equal(f.remote.a,null);
 assert.deepEqual(Sync.merge([1],[2],[3]).conflicts,['/']);assert.deepEqual(Sync.merge({a:1},null,{a:2}).conflicts,['/']);
});

test('revocation survives restart and only verified explicit resume clears it',async()=>{
 const f=fixture();let sync=f.make();await sync.edit('a',{score:.5});await sync.idle();await sync.revoke();sync.dispose();
 sync=f.make();const count=f.calls.length;await sync.onResume();assert.equal(f.calls.length,count);
 f.adapter.status=async()=>({state:'revoked'});await assert.rejects(sync.resumeAfterAuthorization(),e=>e.code==='authorization-required');
 f.adapter.status=async()=>({state:'ready'});await sync.resumeAfterAuthorization();assert.equal(f.saved.state.status,'synced');
});
test('automatic transient retry uses backoff, cancels after success, and no idle polling',async()=>{
 const f=fixture();let clock=0, scheduled, delay, cancellations=0;
 f.adapter.read=async()=>{throw Sync.syncError('network-error');};
 const sync=Sync.createCoordinator({store:f.store,adapter:f.adapter,now:()=>clock,scheduleRetry:(fn,ms)=>{scheduled=fn;delay=ms;return 1;},cancelRetry:()=>{cancellations++;}});
 await sync.onResume();assert.ok(delay>=1000);clock+=delay;f.adapter.read=async()=>[];scheduled();await sync.idle();assert.equal(f.saved.state.status,'synced');assert.equal(f.saved.state.retryAt,null);sync.dispose();
});
test('nonfinite values, functions, Dates and nested unsafe keys are not silently serialized',async()=>{
 const f=fixture(),sync=f.make();for(const value of [{a:NaN},{a:()=>1},new Date(),JSON.parse('{"a":{"__proto__":1}}')])await assert.rejects(sync.edit('a',value),e=>e.code==='invalid-edit');
});
test('corrupt state remains rejected on every retry and is never silently accepted after first error',async()=>{
 const f=fixture();f.saved.state={schemaVersion:1,records:{a:1},base:{},outbox:{a:{local:{x:1}}},conflicts:{},sequence:1,status:'pending'};const sync=f.make();
 await assert.rejects(sync.load(),e=>e.code==='invalid-storage');await assert.rejects(sync.load(),e=>e.code==='invalid-storage');assert.equal(f.saved.writes.length,0);
});
test('hidden runtime cancels transient retry and queues local writes without network until reactivated',async()=>{
 const f=fixture();let canceled=0;f.adapter.read=async()=>{throw Sync.syncError('network-error');};const sync=Sync.createCoordinator({store:f.store,adapter:f.adapter,scheduleRetry:()=>1,cancelRetry:()=>{canceled++;}});
 await sync.onResume();sync.setActive(false);assert.equal(canceled,1);await sync.edit('a',{score:.5});await sync.idle();assert.equal(f.remote.a,undefined);
 f.saved.state.retryAt=null;sync.dispose();const resumed=f.make();resumed.setActive(false);await resumed.onResume();assert.equal(f.remote.a,undefined);f.adapter.read=async()=>[];resumed.setActive(true);await resumed.onResume();assert.deepEqual(f.remote.a,{score:.5});
});
