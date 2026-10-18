'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const Sheets=require('../src/shared/sync-adapters/google-sheets');
const value=()=>({kind:'assessment',courseId:'synthetic-course',assessmentId:'a',title:'Assessment',weight:.5,status:'graded',score:{mode:'points',earned:0,possible:10}});
function fixture(){const rows=[Sheets.HEADERS.slice(),Sheets.encodeRecord('a',value())];const calls=[];let auth='ready';
 const request=async request=>{calls.push(request);if(request.method==='GET')return{status:200,body:{values:JSON.parse(JSON.stringify(rows))}};const range=decodeURIComponent(request.path).match(/!A(\d+):N/);rows[Number(range[1])-1]=request.body.values[0];return{status:200,body:{}};};
 const adapter=Sheets.createAdapter({request,binding:{spreadsheetId:'synthetic-file',tab:"bcorn's grades",confirmed:true},authorizationStatus:async()=>auth,inboundPushConfigured:true});
 return{rows,calls,adapter,setAuth:x=>auth=x};}
test('sheet schema roundtrips grade zero, decimal points, explicit ungraded, tombstones',()=>{
 const v=value();assert.deepEqual(Sheets.decodeRow(Sheets.encodeRecord('a',v),2),{id:'a',value:v});
 v.status='ungraded';v.score=null;assert.deepEqual(Sheets.decodeRow(Sheets.encodeRecord('a',v),2).value,v);
 assert.deepEqual(Sheets.decodeRow(Sheets.encodeRecord('a',null),2),{id:'a',value:null});
});
test('unconfigured/unauthorized binding never performs network operations',async()=>{
 let calls=0;const adapter=Sheets.createAdapter({request:async()=>{calls++;}});assert.equal((await adapter.status()).state,'not-configured');
 await assert.rejects(adapter.read(),e=>e.code==='not-configured');assert.equal(calls,0);
 const f=fixture();f.setAuth('revoked');await assert.rejects(f.adapter.read(),e=>e.code==='revoked');assert.equal(f.calls.length,0);
});
test('bounded exact tab reads, raw deterministic writes, readback verification',async()=>{
 const f=fixture();const original=(await f.adapter.read())[0].value;const changed={...original,title:'=not a formula'};
 await f.adapter.write({id:'a',value:changed,expected:original,mutationId:'synthetic:1'});
 const write=f.calls.find(c=>c.method==='PUT');assert.match(write.path,/valueInputOption=RAW/);assert.match(decodeURIComponent(write.path),/bcorn''s grades'!A2:N2/);
 assert.deepEqual((await f.adapter.read())[0].value,changed);
 const count=f.calls.filter(c=>c.method==='PUT').length;await f.adapter.write({id:'a',value:changed,expected:changed});assert.equal(f.calls.filter(c=>c.method==='PUT').length,count);
});
test('concurrent remote edit, unknown schema, duplicate IDs do not get overwritten',async()=>{
 const f=fixture();await assert.rejects(f.adapter.write({id:'a',value:value(),expected:{}}),e=>e.code==='conflict');assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);
 f.rows[0]=['unrelated workbook'];await assert.rejects(f.adapter.read(),e=>e.code==='schema-mismatch');
 f.rows[0]=Sheets.HEADERS.slice();f.rows.push(f.rows[1]);await assert.rejects(f.adapter.read(),e=>e.code==='invalid-remote');
});
test('invalid grade row and oversized response are rejected without a write',async()=>{
 const f=fixture();f.rows[1][11]=100;await assert.rejects(f.adapter.read(),e=>e.code==='invalid-remote');
 const g=fixture();g.rows.length=1002;await assert.rejects(g.adapter.read(),e=>e.code==='limit-exceeded');
});
test('template creation is a pure request builder with no original user IDs/data',()=>{
 const request=Sheets.templateRequest('Synthetic grades','Assessments');assert.equal(request.path,'/v4/spreadsheets');assert.equal(request.body.sheets.length,1);assert.equal(request.body.sheets[0].data[0].rowData.length,1);
});
test('unchanged Drive version skips full sheet reads; edits and writes invalidate the cache',async()=>{
 const rows=[Sheets.HEADERS.slice(),Sheets.encodeRecord('a',value())];let version='1',metadataCalls=0,sheetReads=0,writes=0;
 const adapter=Sheets.createAdapter({binding:{spreadsheetId:'synthetic-file',tab:'Assessments',confirmed:true},authorizationStatus:async()=> 'ready',getVersion:async()=>{metadataCalls++;return{version};},request:async request=>{if(request.method==='GET'){sheetReads++;return{status:200,body:{values:JSON.parse(JSON.stringify(rows))}};}writes++;rows[1]=request.body.values[0];version=String(Number(version)+1);return{status:200,body:{}};}});
 await adapter.read();await adapter.read();await adapter.read();assert.equal(metadataCalls,3);assert.equal(sheetReads,1);
 rows[1][6]='Remote title';version='2';const current=(await adapter.read())[0].value;assert.equal(sheetReads,2);assert.equal(current.title,'Remote title');
 await adapter.write({id:'a',expected:current,value:{...current,title:'Local title'}});assert.equal(writes,1);assert.equal(sheetReads,4,'preflight and verification force full reads');
 await adapter.read();assert.equal(sheetReads,4);
});
test('normalized quota backs off while file permission denial does not claim revoked grant',async()=>{
 for(const [status,code] of [[429,'rate-limited'],[403,'authorization-required'],[401,'authorization-required']]){
  const adapter=Sheets.createAdapter({binding:{spreadsheetId:'synthetic-file',tab:'Assessments',confirmed:true},authorizationStatus:async()=>'ready',request:async()=>({status,retryAfterMs:120000,body:{}})});
  await assert.rejects(adapter.read(),error=>error.code===code&&(status!==429||error.retryAfterMs===120000));
 }
});
