// Synthetic-data integration smoke test. Requires Playwright and a Chromium installation.
// Run: CHROME_BIN=/path/to/chrome-headless-shell node tests/renderer-smoke.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {chromium}=require('playwright');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href;
const screenshots = process.env.SCREENSHOT_DIR || path.join(require('node:os').tmpdir(), 'bcorn-renderer-smoke');
(async()=>{
 await fs.mkdir(screenshots, { recursive: true });
 const browser=await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:360,height:560},timezoneId:'America/Toronto'});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install({time:new Date('2026-10-19T10:30:00-04:00')});await page.goto(root);await page.waitForFunction(()=>document.querySelector('#footer').textContent.includes('演示'));
 assert.match(await page.locator('.hero-code').textContent(),/CSC373/);
 await page.screenshot({path:path.join(screenshots,'updated-today.png')});
 await page.click('[data-tab="grades"]');await page.screenshot({path:path.join(screenshots,'updated-grades.png')});
 await page.click('[data-tab="term"]');await page.screenshot({path:path.join(screenshots,'updated-term.png')});
 // import invalid JSON, ensure original untouched.
 await page.click('[data-action="menu"]');await page.click('[data-action="import"]');
 await page.setInputFiles('#json-file',{name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{"terms":"bad"}')});
 await page.waitForFunction(()=>document.querySelector('#import-error').textContent.length>0);
 assert.equal(await page.locator('.course-open').count(),5);await page.click('[data-action="close-dialog"]');
 const data={fetchedAt:'2026-10-01T12:00:00Z',terms:[{id:'test',name:'Synthetic Test',start:'2026-10-01',end:'2026-11-15',timezone:'America/Toronto',courses:[{code:'A101',title:'Confirmed',credits:'0.5'},{code:'B102',title:'Waiting',credits:'0.5'},{code:'C103',title:'No time',credits:'0.5'}],meetings:[{code:'A101',title:'Confirmed',section:'LEC01',kind:'LEC',day:1,start:'09:00',end:'10:00',room:'101',location:'Example Hall',address:'40 St George St, Toronto',exdates:['2026-10-26']},{code:'B102',title:'Waiting',status:'Wait List',section:'LEC01',kind:'LEC',day:1,start:'09:30',end:'10:30',location:'BA 1160'},{code:'C103',title:'No time',start:'TBA',end:'TBA'}]}]};
 await page.click('[data-action="menu"]');await page.click('[data-action="import"]');
 await page.setInputFiles('#json-file',{name:'test.json',mimeType:'application/json',buffer:Buffer.from('\ufeff'+JSON.stringify(data))});
 await page.waitForSelector('[data-action="confirm-import"]');assert.match(await page.locator('#dialog-content').textContent(),/untimed\/TBA/);
 await page.click('[data-action="confirm-import"]');await page.waitForFunction(()=>!document.querySelector('#app-dialog').open);
 assert.equal(await page.locator('.course-open').count(),3);assert.equal(await page.locator('.block').count(),2);assert.equal(await page.locator('.block.waitlisted').count(),1);assert.match(await page.locator('.course-open').last().textContent(),/TBA/);
 await page.screenshot({path:path.join(screenshots,'updated-edge-cases.png')});
 // clicking a meeting detail includes real address and map search links, never arbitrary remote URLs.
 await page.locator('.block').first().click();assert.match(await page.locator('#dialog-content').textContent(),/40 St George/);
 await page.evaluate(()=>window.open=(url)=>{window.__opened=url;});await page.click('[data-action="map-google"]');assert.match(await page.evaluate(()=>window.__opened),/^https:\/\/www.google.com\/maps\/search/);
 await page.screenshot({path:path.join(screenshots,'updated-detail.png')});await page.click('[data-action="close-dialog"]');
 // whole-term ICS excludes waitlist; exdate preserved.
 await page.click('.course-toolbar [data-action="export"]');let download=page.waitForEvent('download');await page.click('#export-form [type="submit"]');let d=await download;let ics=await fs.readFile(await d.path(),'utf8');assert.match(ics,/A101/);assert.doesNotMatch(ics,/B102|C103|20261026T/);assert.match(ics,/20261102T140000Z/);
 // explicitly include waitlist.
 await page.click('.course-toolbar [data-action="export"]');await page.check('[name="includeWaitlisted"]');download=page.waitForEvent('download');await page.click('#export-form [type="submit"]');d=await download;ics=await fs.readFile(await d.path(),'utf8');assert.match(ics,/B102/);assert.match(ics,/STATUS:TENTATIVE/);
 // selected TBA-only ICS provides an actionable error; JSON can still export it.
 await page.locator('[data-select="C103"]').check();await page.click('.course-toolbar [data-action="export"]');await page.click('#export-form [type="submit"]');assert.match(await page.locator('#export-error').textContent(),/TBA/);await page.selectOption('[name="format"]','json');download=page.waitForEvent('download');await page.click('#export-form [type="submit"]');d=await download;const json=JSON.parse(await fs.readFile(await d.path(),'utf8'));assert.equal(json.terms[0].courses.length,1);assert.equal(json.terms[0].courses[0].code,'C103');
 // overlap lanes and right click.
 const lanes=await page.locator('.block').evaluateAll(items=>items.map(el=>el.style.getPropertyValue('--lanes')));assert.deepEqual(lanes,['2','2']);
 await page.locator('.block').first().click({button:'right'});assert.equal(await page.locator('#context-menu').isVisible(),true);await page.keyboard.press('Escape');assert.equal(await page.locator('#context-menu').isVisible(),false);
 // Actual in-app long press, movement cancellation, and hidden-window repaint guard.
 const blockBox = await page.locator('.block').first().boundingBox();
 await page.mouse.move(blockBox.x + 8, blockBox.y + 8); await page.mouse.down(); await page.clock.runFor(2200); await page.mouse.up();
 assert.equal(await page.locator('#context-menu').isVisible(), true); await page.keyboard.press('Escape');
 await page.clock.runFor(1100);
 await page.mouse.move(blockBox.x + 8, blockBox.y + 8); await page.mouse.down(); await page.mouse.move(blockBox.x + 35, blockBox.y + 20); await page.clock.runFor(600); await page.mouse.up();
 assert.equal(await page.locator('#context-menu').isVisible(), false);
 if (await page.locator('#app-dialog').evaluate(el => el.open)) await page.click('[data-action="close-dialog"]');
 await page.evaluate(() => { window.__paintCount = 0; new MutationObserver(() => window.__paintCount++).observe(document.querySelector('#view'), { childList: true }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); });
 await page.clock.runFor(60000); assert.equal(await page.evaluate(() => window.__paintCount), 0);
 await page.evaluate(() => { delete document.hidden; });
 // keyboard invocation and extension registry.
 await page.evaluate(()=>window.acornCourseActions.register('test',{label:'Test action',run:()=>window.__extension=true}));await page.locator('.course-open').first().focus();await page.keyboard.press('Shift+F10');await page.click('[data-context-action="test"]');assert.equal(await page.evaluate(()=>window.__extension),true);
 // Imported status aliases survive an unrelated edit and remain excluded by default.
 await page.locator('[data-course="B102"].course-open').click(); await page.click('[data-action="edit-course"]'); assert.equal(await page.locator('[name="meetingStatus"]').inputValue(), 'waitlisted'); await page.fill('[name="title"]', 'Waiting, updated'); await page.click('#course-form [type="submit"]'); await page.waitForFunction(() => !document.querySelector('#app-dialog').open);
 const statusRoundTrip = await page.evaluate(() => JSON.parse(localStorage.getItem('acorn-local-data'))); assert.equal(statusRoundTrip.terms[0].meetings.find(m => m.code === 'B102').status, 'waitlisted');
 // Title-only editor round-trip preserves a distinct building/location and room.
 await page.locator('.course-open').first().click(); await page.click('[data-action="edit-course"]'); await page.fill('[name="title"]', 'Edited title'); await page.selectOption('[name="meetingStatus"]', 'waitlisted'); await page.click('#course-form [type="submit"]'); await page.waitForFunction(() => !document.querySelector('#app-dialog').open);
 const roundTrip = await page.evaluate(() => JSON.parse(localStorage.getItem('acorn-local-data'))); assert.equal(roundTrip.terms[0].meetings.find(m => m.code === 'A101').room, '101'); assert.equal(roundTrip.terms[0].meetings.find(m => m.code === 'A101').location, 'Example Hall');
 // editor validation, multiple meetings and non-destructive cancel.
 await page.locator('.course-open').first().click();await page.click('[data-action="edit-course"]');await page.fill('[name="end"]','08:00');await page.click('#course-form [type="submit"]');assert.match(await page.locator('#form-error').textContent(),/结束时间/);await page.fill('[name="end"]','10:00');await page.screenshot({path:path.join(screenshots,'updated-editor.png')});await page.click('[data-action="close-dialog"]');
 assert.equal(await page.locator('.block').count(),2);
 await page.click('[data-tab="today"]');assert.equal(await page.locator('.slot.waitlisted').count(),2);await page.screenshot({path:path.join(screenshots,'updated-today-edge.png')});
 assert.deepEqual(errors,[]);console.log('Deep renderer suite passed: invalid/BOM import, TBA, waitlist, overlaps, details/maps, UTC DST export, exdates, selected JSON, context keyboard/extensions, editor validation, original tabs; no JS errors.');
 await context.close();
 // Native capabilities and explicit unsupported authentication, with empty local cache.
 const native=await browser.newContext({viewport:{width:360,height:560}});const p=await native.newPage();await p.addInitScript(()=>{window.acorn={capabilities:{login:false,refresh:false,pin:false},getState:async()=>({data:null,status:{state:'unsupported',message:'ACORN authentication unavailable on this platform'},pinned:false}),onUpdate(){},onPinned(){},saveData:async(data)=>{window.__saved=data;return {ok:true};}}});await p.goto(root);await p.waitForSelector('.empty-actions');await p.click('.empty-actions [data-action="add-course"]');await p.fill('[name="code"]','NEW001');await p.fill('[name="title"]','New term course');await p.click('#course-form [type="submit"]');await p.waitForFunction(()=>!document.querySelector('#app-dialog').open);assert.equal(await p.locator('.course-open').count(),1);assert.match(await p.locator('#footer').textContent(),/unavailable/);assert.equal(await p.evaluate(()=>window.__saved.source),'local');console.log('Native empty-state/local save/unsupported-auth suite passed.');
 // Native ingress rejects malformed caches and retains valid data on bad updates.
 const bad = await browser.newContext(); const badPage = await bad.newPage(); const nativeErrors = []; badPage.on('pageerror', e => nativeErrors.push(e.message));
 await badPage.addInitScript(() => { window.acorn = { getState: async () => ({ data: { terms: [{ id: 'bad', name: 'Bad', start: '2026-02-31', end: '2026-12-31', courses: [null], meetings: [] }] }, status: { state: 'ok' } }), onUpdate(callback) { window.__update = callback; }, onPinned() {} }; });
 await badPage.goto(root); await badPage.waitForSelector('.empty-actions [data-action="import"]'); assert.match(await badPage.locator('#view').textContent(), /校验失败/);
 await badPage.evaluate(data => window.__update({ data, status: { state: 'ok' } }), data); await badPage.click('[data-tab="term"]'); assert.equal(await badPage.locator('.course-open').count(), 3);
 await badPage.evaluate(() => window.__update({ data: { terms: 'broken' }, status: { state: 'ok' } })); assert.equal(await badPage.locator('.course-open').count(), 3); assert.match(await badPage.locator('#footer').textContent(), /校验失败/); assert.deepEqual(nativeErrors, []);
 // Toronto wall-clock is independent of the device zone, including its calendar date.
 const china = await browser.newContext({ timezoneId: 'Asia/Shanghai', viewport: { width: 360, height: 640 } }); const chinaPage = await china.newPage();
 await chinaPage.clock.install({ time: new Date('2026-10-19T13:30:00Z') });
 const mixed = JSON.parse(JSON.stringify(data)); mixed.terms.push({ id: 'china', name: 'China', start: '2026-10-01', end: '2026-11-15', timezone: 'Asia/Shanghai', courses: [{ code: 'CN01', title: 'Shanghai morning', credits: '0.5' }], meetings: [{ code: 'CN01', day: 2, start: '09:30', end: '10:30', section: 'LEC01', exdates: [] }] });
 await chinaPage.addInitScript(data => { window.acorn = { platform: 'android', capabilities: { login: false, refresh: false, pin: false }, getState: async () => ({ data, status: { state: 'unsupported', message: 'ACORN login unavailable; local data' } }), onUpdate() {}, onPinned() {}, addCalendarEvent: async event => { window.__calendar = event; return { opened: true, saved: false }; }, importData: async () => { window.__imported = true; return { preview: true }; } }; }, mixed);
 await chinaPage.goto(root); await chinaPage.waitForSelector('.hero-code'); assert.match(await chinaPage.locator('.hero-code').textContent(), /A101/); assert.match(await chinaPage.locator('#timezone').textContent(), /America\/Toronto/);
 await chinaPage.clock.fastForward(12 * 60 * 60 * 1000); assert.match(await chinaPage.locator('#date').textContent(), /10月19日/); assert.match(await chinaPage.locator('.hero-code').textContent(), /CN01/); // Tuesday Shanghai is still Monday Toronto.
 await chinaPage.click('[data-tab="term"]'); await chinaPage.locator('[data-course="A101"].course-open').click(); await chinaPage.click('[data-action="calendar-preview"]');
 const event = await chinaPage.evaluate(() => window.__calendar); assert.match(event.title, /A101/); assert.equal(new Date(event.startMillis).toISOString(), '2026-11-02T14:00:00.000Z'); // Oct 26 is excluded; DST has ended.
 assert.match(await chinaPage.locator('#toast').textContent(), /确认保存/); await chinaPage.click('[data-action="close-dialog"]'); await chinaPage.locator('[data-course="B102"].course-open').click(); assert.equal(await chinaPage.locator('[data-action="calendar-preview"]').count(), 0); await chinaPage.click('[data-action="close-dialog"]');
 await chinaPage.click('[data-action="menu"]'); await chinaPage.click('[data-action="import"]'); await chinaPage.click('[data-action="choose-json"]'); assert.equal(await chinaPage.evaluate(() => window.__imported), true);
 console.log('Malformed native cache, timezone/device independence, mixed-zone Today, Android import and single-event calendar preview tests passed.');
 // A host DST spring gap must not normalize a valid foreign-zone civil time.
 const dstHost = await browser.newContext({ timezoneId: 'America/New_York' }); const dstPage = await dstHost.newPage();
 await dstPage.clock.install({ time: new Date('2026-03-07T18:30:00Z') });
 await dstPage.addInitScript(() => { window.acorn = { getState: async () => ({ data: { terms: [{ id: 'dst', name: 'Shanghai', start: '2026-03-01', end: '2026-03-31', timezone: 'Asia/Shanghai', courses: [{ code: 'DST01', title: 'Valid Shanghai civil time' }], meetings: [{ code: 'DST01', day: 7, start: '02:00', end: '03:00' }] }] }, status: { state: 'ok' } }), onUpdate() {}, onPinned() {} }; });
 await dstPage.goto(root); await dstPage.waitForSelector('.hero-code'); assert.match(await dstPage.locator('.hero-code').textContent(), /DST01/); assert.match(await dstPage.locator('.hero-label').textContent(), /正在上课/); assert.match(await dstPage.locator('.hero-when').textContent(), /30 分钟/); assert.match(await dstPage.locator('#date').textContent(), /3月8日/);
 console.log('Foreign civil time survives the device timezone spring-forward gap.');
 // Mobile viewport preview uses only the repository's original synthetic fixture.
 const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, timezoneId: 'Asia/Shanghai' }); const phonePage = await phone.newPage();
 await phonePage.clock.install({ time: new Date('2026-10-19T14:30:00Z') });
 await phonePage.addInitScript({ content: (await fs.readFile(path.resolve(__dirname, '../src/renderer/mock.js'), 'utf8')) + `
window.acorn = { ...window.acornMock, platform: 'android', capabilities: {login:false,refresh:false,pin:false}, getState: async () => { const state = await window.acornMock.getState(); state.status = {state:'unsupported',message:'Android 界面预览 · 合成数据 · ACORN 登录暂不支持'}; state.data.terms[0].courses[4].status='waitlisted'; state.data.terms[0].courses.push({code:'TBA100H1',title:'Synthetic untimed course',credits:'0.50'}); return state; } };` });
 await phonePage.goto(root); await phonePage.waitForSelector('.hero-code'); await phonePage.screenshot({path:path.join(screenshots,'phone-today-390x844.png')});
 await phonePage.click('[data-tab="term"]'); await phonePage.screenshot({path:path.join(screenshots,'phone-term-390x844.png')});
 assert.equal(await phonePage.locator('.course-open').count(), 6); assert.match(await phonePage.locator('#timezone').textContent(), /America\/Toronto/);
 await phonePage.locator('.course-open').first().click(); await phonePage.screenshot({path:path.join(screenshots,'phone-detail-390x844.png')});
 console.log('390x844 synthetic mobile renderer screenshots saved to ' + screenshots);
 // Cold Electron startup remains offline with actionable local onboarding.
 const offlineContext = await browser.newContext(); const offlinePage = await offlineContext.newPage();
 await offlinePage.addInitScript(() => { window.acorn = { getState: async () => ({ data: null, status: { state: 'offline' } }), onUpdate(callback) { window.__offlineUpdate = callback; }, onPinned() {} }; });
 await offlinePage.goto(root); await offlinePage.waitForSelector('.empty-actions [data-action="import"]'); assert.equal(await offlinePage.locator('.empty-actions [data-action="add-course"]').count(), 1); assert.equal(await offlinePage.locator('.empty-actions [data-action="login"]').count(), 1); assert.doesNotMatch(await offlinePage.locator('#view').textContent(), /正在加载/);
 await offlinePage.evaluate(data => window.__offlineUpdate({ data: { ...data, source: 'local' }, status: { state: 'error', message: 'Synthetic refresh failure' } }), data); await offlinePage.click('[data-tab="term"]'); assert.equal(await offlinePage.locator('.course-open').count(), 3); assert.match(await offlinePage.locator('#footer').textContent(), /刷新失败.*已保留现有课表/);
 await offlinePage.evaluate(() => window.__offlineUpdate({ status: { state: 'login' } })); assert.match(await offlinePage.locator('#footer').textContent(), /需要登录 ACORN.*已保留现有课表/); assert.equal(await offlinePage.locator('.course-open').count(), 3);
 await offlinePage.evaluate(() => { window.acorn.capabilities = { login: false }; window.__offlineUpdate({ status: { state: 'error', message: 'Synthetic native failure' } }); }); assert.match(await offlinePage.locator('#footer').textContent(), /本地操作失败.*ACORN 登录暂不支持/); assert.equal(await offlinePage.locator('#footer [data-action="refresh"]').count(), 0);
 console.log('Offline onboarding and visible refresh/login/native failures preserve local course data.');
 // Explicit native-only clear-local action requires confirmation; failed clear preserves data.
 await offlinePage.evaluate(() => { window.acorn.clearData = async () => { throw new Error('Synthetic clear failure'); }; });
 await offlinePage.click('[data-action="menu"]'); await offlinePage.click('[data-action="clear-local"]'); assert.equal(await offlinePage.locator('.course-open').count(), 3); await offlinePage.click('[data-action="confirm-clear-local"]'); assert.match(await offlinePage.locator('#clear-error').textContent(), /Synthetic clear failure/); assert.equal(await offlinePage.locator('.course-open').count(), 3);
 await offlinePage.evaluate(() => { window.acorn.clearData = async () => ({ data: null, status: { state: 'unsupported', message: 'Local data cleared; ACORN login unavailable' } }); });
 await offlinePage.click('[data-action="confirm-clear-local"]'); await offlinePage.waitForFunction(() => !document.querySelector('#app-dialog').open); assert.equal(await offlinePage.locator('.course-open').count(), 0); assert.equal(await offlinePage.locator('.empty-actions [data-action="import"]').count(), 1); assert.match(await offlinePage.locator('#toast').textContent(), /本地课表与成绩已清除/);
 console.log('Native local-data clear confirmation, failure retention and successful empty state pass.');
 await browser.close();
})();
