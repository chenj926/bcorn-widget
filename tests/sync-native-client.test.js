'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const Client=require('../src/shared/sync-adapters/native-client');const Sheets=require('../src/shared/sync-adapters/google-sheets');
const empty=()=>({schemaVersion:1,courses:[]});
test('absent native OAuth transport is honestly not configured; no success simulation',async()=>{
 const bridge={};const session=await Client.getSession(bridge,{load:async()=>empty(),save:async b=>b});assert.equal(session.status.status,'not-configured');assert.equal(session.canConnect,false);assert.equal(session.service,null);await session.dispose();
});
test('native token never enters request contract; connection journal is isolated and notifications route',async()=>{
 let connection='synthetic-connection',ready=true, local=empty(),journal=null,requests=0,listener,unsubscribed=false;const savedIds=[];
 const bridge={getGradeSyncStatus:async()=>({state:ready?'ready':'revoked',connectionId:connection,deviceId:'synthetic-device',binding:{spreadsheetId:'synthetic-file',tab:'Assessments',confirmed:true},automaticInbound:true}),gradeSheetsRequest:async request=>{requests++;assert.equal(request.token,undefined);assert.equal(request.url,undefined);return{status:200,body:{values:[Sheets.HEADERS]}};},loadGradeSyncState:async id=>{savedIds.push(id);return journal;},saveGradeSyncState:async(id,state)=>{savedIds.push(id);journal=state;return{ok:true};},onGradeRemoteChange:fn=>{listener=fn;return()=>{unsubscribed=true;};}};
 const session=await Client.getSession(bridge,{load:async()=>local,save:async b=>{local=b;return b;}});assert.ok(session.service);assert.equal(session.status.automaticInbound,true);assert.ok(savedIds.every(id=>id==='synthetic-connection'));
 const count=requests;await session.notifyRemoteChange({connectionId:'other'});assert.equal(requests,count);
 await session.notifyRemoteChange({connectionId:connection});assert.ok(requests>count);
 ready=false;await session.refresh();assert.equal(session.status.status,'revoked');assert.equal(session.service,null);await session.dispose();assert.equal(unsubscribed,true);
});
test('connect action only requests a new app-owned sheet and requires verified native success',async()=>{
 let arg;const bridge={connectGradeSheet:async value=>{arg=value;return{ok:false};}};const session=await Client.getSession(bridge,{load:async()=>empty(),save:async b=>b});await assert.rejects(session.connect());assert.deepEqual(arg,{title:'bcorn grades',tab:'Assessments'});assert.equal(session.status.status,'not-configured');await session.dispose();
});
test('Windows ready status connect response is accepted and Android typed failures preserve semantics',async()=>{
 const bridge={connectGradeSheet:async()=>({state:'ready'})};const session=await Client.getSession(bridge,{load:async()=>empty(),save:async b=>b});await session.connect();await session.dispose();
 for(const method of ['getGradeSyncStatus','gradeSheetVersion','gradeSheetsRequest','loadGradeSyncState','saveGradeSyncState','connectGradeSheet']) {
  const native={[method]:async()=>({ok:false,error:{code:'offline',message:'Offline',retryAfterMs:30000}})};
  await assert.rejects(Client.nativeCall(native,method),error=>error.code==='offline'&&error.retryAfterMs===30000);
 }
});
test('Tauri rejected string codes retain revocation and hidden pause semantics',async()=>{
 for(const [nativeCode,expected] of [['revoked','revoked'],['authorization-required','authorization-required'],['background-paused','offline'],['connection-changed','authorization-required'],['network-error','network-error']])await assert.rejects(Client.nativeCall({gradeSheetVersion:async()=>{throw nativeCode;}},'gradeSheetVersion'),e=>e.code===expected);
});
