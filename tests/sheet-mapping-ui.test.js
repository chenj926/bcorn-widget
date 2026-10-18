'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');const UI=require('../src/renderer/sheet-mapping-ui');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('DOM: explicit file/tab, readonly preview, manual mapping, zero import and safe text',async()=>{
 const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main');let confirms=0,previewCalls=0,result;
 const bridge={pickGradeSheet:async()=>({selectionId:'opaque',sheets:[{sheetId:3,tab:'Synthetic'}]}),previewGradeSheet:async query=>{previewCalls++;assert.equal(query.sheetId,3);return {sheetId:3,tab:'Synthetic',complete:true,cells:{A4:{value:'<img src=x onerror=alert(1)>'},B4:{value:100},C4:{value:0},D8:{value:'#DIV/0!',formula:true}}};}};
 const ui=UI.mount(host,{bridge,onConfirm:async data=>{confirms++;result=data;}});
 host.querySelector('button').click();await tick();assert.equal(previewCalls,0);const tabs=host.querySelector('select');tabs.value='3';tabs.dispatchEvent(new dom.window.Event('change'));await tick();assert.equal(previewCalls,1);assert.equal(host.querySelectorAll('img').length,0);assert.match(host.textContent,/公式（只读）/);
 const form=host.querySelector('form');for(const [key,value]of Object.entries({course:'synthetic',courseTitle:'Synthetic',title:'Exam',anchorCell:'A4',gradeCell:'C4',weightCell:'B4',gradeMode:'ratio',weightMode:'percentage'}))form.querySelector(`[name="${key}"]`).value=value;
 form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await tick();assert.equal(confirms,1);assert.equal(result.book.courses[0].assessments[0].score.value,0);assert.equal(result.mapping.courses[0].rules.kind,'unconfirmed');assert.equal(result.selectionId,'opaque');ui.dispose();assert.equal(host.children.length,0);dom.window.close();
});
test('DOM: formula destination blocks confirmation; no native picker shows honest blocker',async()=>{
 const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main');const ui=UI.mount(host,{bridge:{},onConfirm:async()=>assert.fail('must not confirm')});host.querySelector('button').click();await tick();assert.match(host.textContent,/尚未配置/);assert.equal(host.querySelector('button[type="submit"]').disabled,true);ui.dispose();dom.window.close();
});
test('DOM: a mapped formula is blocked, explicit correction can be confirmed',async()=>{
 const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main');let confirmed=0;
 const snapshot={sheetId:1,tab:'Synthetic',complete:true,cells:{A2:{value:'Test'},B2:{value:1},C2:{value:0,formula:true},D2:{value:''}}};
 const ui=UI.mount(host,{bridge:{pickGradeSheet:async()=>({selectionId:'synthetic',tabs:[{sheetId:1,title:'Synthetic'}]}),previewGradeSheet:async()=>snapshot},onConfirm:async()=>{confirmed++;}});
 host.querySelector('button').click();await tick();const tabs=host.querySelector('select');tabs.value='1';tabs.dispatchEvent(new dom.window.Event('change'));await tick();const form=host.querySelector('form');
 for(const [key,value]of Object.entries({course:'synthetic',courseTitle:'Synthetic',title:'Test',anchorCell:'A2',gradeCell:'C2',weightCell:'B2',gradeMode:'ratio',weightMode:'ratio'}))form.querySelector(`[name="${key}"]`).value=value;
 form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await tick();assert.equal(confirmed,0);assert.match(host.textContent,/公式、合并或受保护/);
 form.querySelector('[name="gradeCell"]').value='D2';form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await tick();assert.equal(confirmed,1);assert.equal(snapshot.cells.C2.formula,true);ui.dispose();dom.window.close();
});
test('DOM: course identity appears once and only one assessment editor stays open',async()=>{const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main');const ui=UI.mount(host,{bridge:{},onConfirm:async()=>{}});assert.equal(host.querySelectorAll('[name="course"]').length,1);[...host.querySelectorAll('button')].find(x=>x.textContent==='添加考核映射').click();await tick();assert.equal(host.querySelectorAll('.sm-row').length,2);assert.equal(host.querySelectorAll('.sm-row[open]').length,1);const first=host.querySelector('.sm-row');first.open=true;await new Promise(r=>setTimeout(r,10));assert.equal(host.querySelectorAll('.sm-row[open]').length,1);ui.dispose();dom.window.close();});
