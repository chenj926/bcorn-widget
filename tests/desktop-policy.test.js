'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function boot(options = {}) {
  const handlers = new Map(), events = new EventEmitter(), windows = [], writes = new Map();
  const counts = { fetch: 0, intervals: 0, cookieSet: 0, external: [], removed: [] };
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; windows.push(this); this.webContents = new EventEmitter(); this.webContents.send = () => {}; this.webContents.setWindowOpenHandler = () => {}; }
    loadFile() {} show() {} focus() {} setAlwaysOnTop() {} isVisible() { return true; } isFocused() { return true; }
  }
  class Tray extends EventEmitter { setToolTip() {} }
  const app = Object.assign(new EventEmitter(), { getPath: () => '/synthetic-only', requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), isPackaged: true, getLoginItemSettings: () => ({openAtLogin:false}), setLoginItemSettings: () => { throw Error('Unexpected automatic startup registration'); } });
  const cookieEvents = new EventEmitter(); cookieEvents.set = () => {counts.cookieSet++;};
  const electron = { app, BrowserWindow: Window, Tray, Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} }, ipcMain: Object.assign(events, { handle: (key, fn) => handlers.set(key, fn) }), session: {fromPartition: () => ({cookies:cookieEvents})}, nativeImage: {createFromPath: () => ({isEmpty:()=>false,getSize:()=>({})})}, safeStorage: {isEncryptionAvailable:()=>false}, screen: {getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1920,height:1080}}),getAllDisplays:()=>[]}, shell: {openExternal:async url=>counts.external.push(url)}, dialog: {showMessageBox:async()=>({response:options.confirmReplace ? 1 : 0}),showSaveDialog:async()=>({canceled:true}),showOpenDialog:async()=>({canceled:true})} };
  const fakeFs = {rmSync:(path)=>counts.removed.push(path),readFileSync:(p)=>{if (p.endsWith('cache.bin') && options.cache) return Buffer.from(JSON.stringify(options.cache)); throw Error('No private data in test');},writeFileSync:(p,value)=>writes.set(p,value)};
  const acorn = {fetchAll:async()=>{counts.fetch++;return {terms:[],transcript:null};}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8'), {require:name=>name==='electron'?electron:name==='node:fs'?fakeFs:name==='./acorn'?acorn:require(name.startsWith('./')?path.join(__dirname,'../src',name):name),__dirname:path.join(__dirname,'../src'),process:{env:{},platform:'win32'},console,URL,setTimeout,clearTimeout,setInterval:()=>{counts.intervals++;}});
  return {handlers,windows,counts,writes,app};
}

test('cold startup is offline, persistent/resizable Windows window retains original renderer', async()=>{
 const host=boot(); await Promise.resolve();
 assert.equal(host.counts.fetch,0); assert.equal(host.counts.intervals,0); assert.equal(host.counts.cookieSet,0);
 assert.equal(host.windows.length,1); assert.equal(host.windows[0].options.resizable,true); assert.equal(host.windows[0].options.skipTaskbar,false);
 assert.equal(host.app.listenerCount('resume'),0);
 await host.handlers.get('acorn:refresh')(); assert.equal(host.counts.fetch,1);
});
test('local save validates input and external navigation restricts map providers',async()=>{
 const host=boot(); await Promise.resolve();
 assert.throws(()=>host.handlers.get('data:save')(null,{terms:'broken'}));
 assert.equal(host.handlers.get('data:save')(null,{terms:[],transcript:null}).ok,true);
 assert.equal(host.writes.size,1);
 await assert.rejects(host.handlers.get('external:open')(null,'https://evil.example/'));
 await assert.rejects(host.handlers.get('external:open')(null,'javascript:alert(1)'));
 await host.handlers.get('external:open')(null,'https://www.google.com/maps/search/?api=1&query=Synthetic');
 assert.equal(host.counts.external.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(await host.handlers.get('calendar:export')(null,{filename:'demo.ics',content:'BEGIN:VCALENDAR\r\nEND:VCALENDAR'}))),{canceled:true});
});

test('manual local data is never replaced by ACORN refresh without confirmation', async()=>{
 const data={source:'local',terms:[],transcript:null};
 const canceled=boot({cache:data}); await Promise.resolve();
 assert.equal((await canceled.handlers.get('acorn:refresh')()).canceled,true);
 assert.equal(canceled.counts.fetch,0); assert.equal(canceled.writes.size,0);
 const approved=boot({cache:data,confirmReplace:true}); await Promise.resolve();
 await approved.handlers.get('acorn:refresh')(); assert.equal(approved.counts.fetch,1);
 assert.equal(JSON.parse([...approved.writes.values()][0]).source,'acorn');
});

test('empty startup is offline and explicit local clear removes only timetable cache', async()=>{
 const host=boot(); await Promise.resolve();
 assert.equal(host.handlers.get('acorn:get-state')().status.state,'offline');
 assert.equal(host.counts.removed.length,0);
 const cleared=host.handlers.get('data:clear')();
 assert.equal(cleared.data,null); assert.equal(cleared.status.state,'offline');
 assert.deepEqual(host.counts.removed,['/synthetic-only/cache.bin']);
 assert.equal(host.counts.fetch,0);
});
