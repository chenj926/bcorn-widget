'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('real renderer entrypoint loads grade modules in executable dependency order',()=>{
 const dir=path.join(__dirname,'../src/renderer'),html=fs.readFileSync(path.join(dir,'index.html'),'utf8');
 const scripts=[...html.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1]);
 const expected=['../shared/grade-book.js','../shared/sync-coordinator.js','../shared/sync-adapters/google-sheets.js','../shared/sync-adapters/grade-sync.js','../shared/sync-adapters/foreground-sync.js','../shared/sync-adapters/native-client.js','grades-ui.js'];
 let previous=-1;const context=vm.createContext({console,TextEncoder});
 for(const script of expected){const index=scripts.indexOf(script);assert.ok(index>previous,script+' must load once after its dependencies');assert.equal(scripts.filter(s=>s===script).length,1);previous=index;vm.runInContext(fs.readFileSync(path.join(dir,script),'utf8'),context,{filename:script});}
 for(const name of ['GradeBook','BcornSync','BcornSheets','GradeSync','GradeForegroundSync','GradeSyncClient','GradesUI'])assert.ok(context[name],name);
 assert.ok(scripts.indexOf('app.js')>previous);
});
test('actual Tauri and Android JavaScript bridges preserve grade request and journal arguments',async()=>{
 for(const platform of ['tauri','android']){
  const calls=[],window={addEventListener(){}};let context;
  if(platform==='tauri')window.__TAURI__={core:{invoke:async(method,args)=>{calls.push({method,args});return{ok:true};}},event:{listen:async()=>()=>{}}};
  context=vm.createContext({window,console,AcornNative:{call(id,method,json){calls.push({method,args:JSON.parse(json)});window.__acornNativeReply(id,{ok:true},null);}}});
  const file=platform==='tauri'?'../src/renderer/tauri-bridge.js':'../android/app/src/main/assets/android-bridge.js';vm.runInContext(fs.readFileSync(path.join(__dirname,file),'utf8'),context);
  const request={method:'GET',path:'/v4/spreadsheets/synthetic/values/test'},envelope={schemaVersion:1,coordinator:{},publishedBook:{schemaVersion:1,courses:[]}};
  await window.acorn.gradeSheetsRequest(request);await window.acorn.gradeSheetVersion();await window.acorn.loadGradeSyncState('synthetic-connection');await window.acorn.saveGradeSyncState('synthetic-connection',envelope);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),platform==='tauri'?[{method:'grade_sheets_request',args:{request}},{method:'grade_sheet_version'},{method:'load_grade_sync_state',args:{connectionId:'synthetic-connection'}},{method:'save_grade_sync_state',args:{connectionId:'synthetic-connection',envelope}}]:[{method:'gradeSheetsRequest',args:request},{method:'gradeSheetVersion',args:null},{method:'loadGradeSyncState',args:{connectionId:'synthetic-connection'}},{method:'saveGradeSyncState',args:{connectionId:'synthetic-connection',envelope}}]);
 }
});
test('actual native bridges expose scoped picker and guarded mapped writes',async()=>{
 for(const platform of ['tauri','android']){
  const calls=[],window={addEventListener(){}};
  if(platform==='tauri')window.__TAURI__={core:{invoke:async(method,args)=>{calls.push({method,args});return{ok:true};}},event:{listen:async()=>()=>{}}};
  const context=vm.createContext({window,console,AcornNative:{call(id,method,json){calls.push({method,args:JSON.parse(json)});window.__acornNativeReply(id,{ok:true},null);}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,platform==='tauri'?'../src/renderer/tauri-bridge.js':'../android/app/src/main/assets/android-bridge.js'),'utf8'),context);
  const mapping={schemaVersion:1},course={id:'synthetic'},expectedSnapshot={cells:{}},writes=[{cell:'C4',value:0}];
  await window.acorn.pickGradeSheet();await window.acorn.previewGradeSheet({selectionId:'candidate',sheetId:7});
  await window.acorn.confirmGradeSheetMapping({selectionId:'candidate',mapping});
  await window.acorn.readMappedGradeSnapshot({connectionId:'scoped'});
  await window.acorn.commitMappedGradeCells({connectionId:'scoped',expectedSnapshot,writes});
  await window.acorn.createMappedGradeSheet({course});
  assert.deepEqual(JSON.parse(JSON.stringify(calls)).slice(1).map(c=>c.args),[{selectionId:'candidate',sheetId:7},{selectionId:'candidate',mapping},{connectionId:'scoped'},{connectionId:'scoped',expectedSnapshot,writes},{course}]);
  assert.equal(calls[0].method,platform==='tauri'?'pick_grade_sheet':'pickGradeSheet');
 }
});
