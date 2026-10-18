/* Synthetic interaction regressions for the shared renderer. Native hosts are simulated;
 * these checks do not claim Windows WebView2 or Android device runtime coverage.
 * Run: CHROME_BIN=/path/to/chromium node tests/mobile-interactions.cjs */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const root = pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href;
const fixture = {source:'local',terms:[{id:'synthetic',name:'Synthetic autumn',start:'2026-10-01',end:'2026-11-30',timezone:'America/Toronto',courses:[
  {code:'SYN101',title:'Synthetic weekly lecture',credits:'0.5'},
  {code:'SYN102',title:'Synthetic waiting seminar',credits:'0.5',status:'waitlisted'},
  {code:'SYN103',title:'Synthetic untimed course',credits:'0.5'},
  {code:'EVT001',title:'Synthetic one-time appointment',type:'event'}
],meetings:[
  {code:'SYN101',title:'Synthetic weekly lecture',section:'LEC01',kind:'LEC',day:1,start:'09:00',end:'10:00',location:'Example Hall',room:'101',exdates:['2026-10-26']},
  {code:'SYN102',title:'Synthetic waiting seminar',section:'TUT01',kind:'TUT',day:1,start:'09:30',end:'10:30'},
  {code:'EVT001',title:'Synthetic one-time appointment',section:'EVENT',kind:'EVENT',day:2,start:'12:00',end:'13:00',recurrence:'once',date:'2026-10-20',from:'2026-10-20',until:'2026-10-20'}
]}]};
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try {
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Shanghai'});
  const page=await context.newPage(); page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date('2026-10-19T13:30:00Z')});
  await page.addInitScript(data=>{
    window.__saved=[];
    window.acorn={platform:'android',capabilities:{login:false,refresh:false,pin:false},getState:async()=>({data,status:{state:'unsupported',message:'Synthetic local mode'}}),onUpdate(){},onPinned(){},addCalendarEvent:async event=>{window.__calendar=event;return {opened:true,saved:false};},saveData:async next=>{window.__saved.push(JSON.parse(JSON.stringify(next)));return {ok:true};},exportFile:async payload=>{window.__exported=payload;return {ok:true};}};
  },fixture);
  await page.goto(root);await page.waitForSelector('.hero-code');
  assert.match(await page.locator('.hero-code').textContent(),/SYN101/);
  assert.match(await page.locator('#timezone').textContent(),/America\/Toronto/);
  // Day navigation is the timetable timezone's civil date, not the device date.
  assert.equal(await page.locator('#calendar-date').inputValue(),'2026-10-19');
  await page.click('[data-action="next-date"]');
  assert.equal(await page.locator('#calendar-date').inputValue(),'2026-10-20');
  assert.match(await page.locator('#view').textContent(),/Synthetic one-time appointment/);
  await page.click('[data-action="previous-date"]');
  assert.equal(await page.locator('#calendar-date').inputValue(),'2026-10-19');
  await page.locator('#calendar-date').fill('2026-10-26');await page.locator('#calendar-date').dispatchEvent('change');
  assert.equal(await page.locator('.slot[data-course="SYN101"]').count(),0,'excluded weekly occurrence must not reappear');
  assert.equal(await page.locator('.slot[data-course="EVT001"]').count(),0,'one-time event must not repeat');
  await page.click('[data-action="go-today"]');
  await page.click('[data-tab="term"]');
  assert.equal(await page.locator('.block[data-course="EVT001"]').count(),1);
  assert.equal(await page.locator('[data-action="toggle-course-list"]').getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('.course-list').isVisible(),false);
  assert.equal(await page.locator('[data-action="export"]').isVisible().catch(()=>false),false,'no selected export before selection mode');
  await page.click('[data-action="next-date"]');
  assert.equal(await page.locator('.block[data-course="EVT001"]').count(),0,'once event absent from later week');
  assert.equal(await page.locator('.block[data-course="SYN101"]').count(),0,'weekly grid respects exclusions');
  await page.click('[data-action="previous-date"]');
  await page.click('[data-day-date="2026-10-20"]');
  assert.equal(await page.locator('#calendar-date').inputValue(),'2026-10-20');
  assert.equal(await page.locator('.slot[data-course="EVT001"]').count(),1);
  await page.click('[data-tab="term"]');
  await page.click('[data-action="toggle-course-list"]');
  assert.equal(await page.locator('.course-list').isVisible(),true);
  assert.equal(await page.locator('.course-select:visible').count(),0);
  await page.click('[data-action="toggle-selection"]');
  assert.equal(await page.locator('.course-select:visible').count(),4);
  await page.locator('[data-select="SYN101"]').check();
  assert.match(await page.locator('.selection-export').textContent(),/1/);
  await page.click('.selection-export');
  assert.equal(await page.locator('[name="scope"]').inputValue(),'selected');
  assert.equal(await page.evaluate(()=>window.acornHandleBack()),true);
  assert.equal(await page.locator('#app-dialog').evaluate(el=>el.open),false);
  assert.equal(await page.evaluate(()=>window.acornHandleBack()),true,'back leaves selection mode before app');
  assert.equal(await page.locator('.course-select:visible').count(),0);
  // Dirty back is handled in the renderer; retaining edits and discarding are separate.
  await page.locator('.course-open[data-course="SYN101"]').click();
  await page.click('[data-action="edit-course"]');
  await page.fill('#course-form [name="title"]','Unsaved synthetic edit');
  assert.equal(await page.evaluate(()=>window.__bcornHandleBack()),true);
  assert.equal(await page.locator('#discard-dialog').evaluate(el=>el.open),true);
  await page.click('[data-action="keep-editing"]');
  assert.equal(await page.locator('#course-form [name="title"]').inputValue(),'Unsaved synthetic edit');
  assert.equal(await page.evaluate(()=>window.acornHandleBack()),true);
  await page.click('[data-action="discard-changes"]');
  assert.equal(await page.evaluate(()=>window.__saved.length),0,'discard never saves');
  if(await page.locator('#app-dialog').evaluate(el=>el.open)) await page.evaluate(()=>window.acornHandleBack());
  // Dedicated event form saves a single occurrence and supports independent weekly events.
  await page.click('[data-action="add-menu"]');await page.click('[data-action="add-event"]');
  await page.fill('#event-form [name="title"]','Created synthetic event');
  await page.fill('#event-form [name="date"]','2026-10-21');
  await page.fill('#event-form [name="start"]','14:00');await page.fill('#event-form [name="end"]','15:00');
  await page.click('#event-form [type="submit"]');
  await page.waitForFunction(()=>window.__saved.length===1);
  const saved=await page.evaluate(()=>window.__saved.at(-1));
  const course=saved.terms.flatMap(t=>t.courses).find(c=>c.title==='Created synthetic event');
  assert.equal(course.type,'event');
  const event=saved.terms.flatMap(t=>t.meetings).find(m=>m.code===course.code);
  assert.equal(event.recurrence,'once');assert.equal(event.date,'2026-10-21');
  assert.equal(event.from,event.date);assert.equal(event.until,event.date);
  const ics=await page.evaluate(({term,code})=>window.CourseTools.exportICS({terms:[term]},{termId:term.id,courseCodes:[code]}),{term:saved.terms.find(t=>t.courses.some(c=>c.code===course.code)),code:course.code});
  assert.equal((ics.match(/BEGIN:VEVENT/g)||[]).length,1);
  assert.match(ics,/Created synthetic event/);
  await page.click('[data-action="add-menu"]');await page.click('[data-action="add-event"]');
  await page.fill('#event-form [name="title"]','Created weekly event');
  await page.selectOption('#event-form [name="recurrence"]','weekly');
  await page.selectOption('#event-form [name="day"]','4');
  await page.fill('#event-form [name="from"]','2026-10-22');await page.fill('#event-form [name="until"]','2026-11-05');
  await page.click('#event-form [type="submit"]');await page.waitForFunction(()=>window.__saved.length===2);
  assert.equal(await page.evaluate(()=>window.__saved.at(-1).terms.flatMap(t=>t.courses).filter(c=>['Created synthetic event','Created weekly event'].includes(c.title)).length),2,'new events must have unique IDs even when the clock is unchanged');
  const weekly=await page.evaluate(()=>window.__saved.at(-1).terms.flatMap(t=>t.meetings).find(m=>m.title==='Created weekly event'));
  assert.equal(weekly.recurrence,'weekly');assert.equal(weekly.day,4);
  // A standalone event can live outside every imported academic term.
  await page.locator('#calendar-date').fill('2027-02-15');await page.locator('#calendar-date').dispatchEvent('change');
  assert.equal(await page.locator('#calendar-date').inputValue(),'2027-02-15');
  await page.click('[data-action="add-menu"]');await page.click('[data-action="add-event"]');
  assert.equal(await page.locator('#event-form [name="date"]').inputValue(),'2027-02-15');
  await page.fill('#event-form [name="title"]','Outside-term synthetic event');
  await page.click('#event-form [type="submit"]');await page.waitForFunction(()=>window.__saved.length===3);
  const outside=await page.evaluate(()=>window.__saved.at(-1));
  assert.deepEqual(outside.terms.find(t=>t.id==='synthetic').courses.filter(c=>['SYN101','SYN102','SYN103','EVT001'].includes(c.code)).map(c=>c.code),['SYN101','SYN102','SYN103','EVT001']);
  const personal=outside.terms.find(t=>t.courses.some(c=>c.title==='Outside-term synthetic event'));
  assert.notEqual(personal.id,'synthetic');assert.ok(personal.start<='2027-02-15'&&personal.end>='2027-02-15');
  assert.equal(await page.locator('#calendar-date').inputValue(),'2027-02-15');
  assert.match(await page.locator('.block').textContent(),/Outside-term synthetic event/);
  await page.click('[data-tab="today"]');
  assert.equal(await page.locator('.slot').count(),1);assert.match(await page.locator('.slot').textContent(),/Outside-term synthetic event/);
  // Tapped past/future occurrences keep their exact date in details and native preview.
  await page.locator('#calendar-date').fill('2026-10-12');await page.locator('#calendar-date').dispatchEvent('change');
  await page.locator('.slot[data-course="SYN101"]').click();
  assert.equal(await page.locator('.detail-date').getAttribute('data-detail-occurrence'),'2026-10-12');
  assert.equal(await page.locator('[data-action="calendar-preview"]').count(),0,'past occurrence cannot silently preview a different future date');
  await page.evaluate(()=>window.acornHandleBack());
  await page.locator('#calendar-date').fill('2026-11-02');await page.locator('#calendar-date').dispatchEvent('change');
  await page.locator('.slot[data-course="SYN101"]').click();
  assert.equal(await page.locator('.detail-date').getAttribute('data-detail-occurrence'),'2026-11-02');
  await page.locator('.more-details').evaluateAll(rows=>rows.forEach(row=>row.open=true));
  await page.click('[data-action="calendar-preview"]');
  assert.equal(await page.evaluate(()=>new Date(window.__calendar.startMillis).toISOString()),'2026-11-02T14:00:00.000Z');
  await page.evaluate(()=>window.acornHandleBack());
  await page.locator('#calendar-date').fill('2026-10-20');await page.locator('#calendar-date').dispatchEvent('change');
  await page.locator('.slot[data-course="EVT001"]').click();
  await page.locator('.more-details').evaluateAll(rows=>rows.forEach(row=>row.open=true));
  await page.click('[data-action="calendar-preview"]');
  assert.equal(await page.evaluate(()=>window.__calendar.title),'Synthetic one-time appointment');
  assert.equal(await page.evaluate(()=>new Date(window.__calendar.startMillis).toISOString()),'2026-10-20T16:00:00.000Z');
  await page.evaluate(()=>window.acornHandleBack());
  // Editor titles and primary controls remain visible with a phone-sized viewport.
  await page.click('[data-tab="term"]');
  await page.selectOption('#calendar-term','synthetic');
  if(await page.locator('[data-action="toggle-course-list"]').getAttribute('aria-expanded')==='false') await page.click('[data-action="toggle-course-list"]');
  await page.locator('.course-open[data-course="SYN101"]').click();await page.click('[data-action="edit-course"]');
  assert.equal(await page.locator('.meeting-fields[open]').count(),0,'existing meetings start as compact accordions');
  await page.locator('.meeting-fields summary').first().click();
  assert.equal(await page.locator('[name="start"]').isVisible(),true);
  await fs.mkdir('/tmp/bcorn-mobile-qa',{recursive:true});
  await page.screenshot({path:'/tmp/bcorn-mobile-qa/course-editor-390.png'});
  await page.evaluate(()=>window.acornHandleBack());await page.evaluate(()=>window.acornHandleBack());
  // No document-level horizontal overflow at narrow and ordinary desktop dimensions.
  await page.clock.runFor(6100);
  await page.click('[data-tab="term"]');
  for (const viewport of [{width:360,height:800},{width:390,height:844},{width:900,height:700}]) {
    await page.setViewportSize(viewport);
    await page.evaluate(()=>document.querySelector('#view').scrollTop=0);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`document overflow at ${viewport.width}`);
    const targets=await page.locator('.nav-arrow, .today-btn:visible, .tabs button, .add-inline, .course-list-toggle, #btn-add, [data-action="menu"]').evaluateAll(nodes=>nodes.map(el=>({name:el.textContent.trim(),width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})));
    for(const target of targets) assert.ok(target.width>=48&&target.height>=48,`touch target too small: ${JSON.stringify(target)}`);
    await fs.mkdir('/tmp/bcorn-mobile-qa',{recursive:true});
    await page.screenshot({path:`/tmp/bcorn-mobile-qa/week-${viewport.width}.png`});
  }
  // Periodic clock repaint and resume must not destroy a focused native date picker.
  await page.evaluate(()=>{
    window.__focusedPicker=document.querySelector('#calendar-date');window.__focusedPicker.focus();
    window.__pickerRenders=0;window.__pickerObserver=new MutationObserver(()=>window.__pickerRenders++);
    window.__pickerObserver.observe(document.querySelector('#header-calendar'),{childList:true});
  });
  await page.clock.runFor(61000);
  assert.equal(await page.evaluate(()=>document.querySelector('#calendar-date')===window.__focusedPicker),true);
  assert.equal(await page.evaluate(()=>window.__pickerRenders),0);
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(await page.evaluate(()=>document.querySelector('#calendar-date')===window.__focusedPicker),true);
  await page.evaluate(()=>window.__focusedPicker.blur());await page.clock.runFor(31000);
  assert.ok(await page.evaluate(()=>window.__pickerRenders)>0,'normal clock repaint resumes after blur');
  await page.evaluate(()=>window.__pickerObserver.disconnect());
  // Hidden documents and open editor dialogs do not run periodic renderer work.
  await page.evaluate(()=>{
    window.__guardRenders=0;window.__guardObserver=new MutationObserver(()=>window.__guardRenders++);
    window.__guardObserver.observe(document.querySelector('#view'),{childList:true});
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
  });
  await page.clock.runFor(31000);assert.equal(await page.evaluate(()=>window.__guardRenders),0);
  await page.evaluate(()=>{delete document.hidden;});await page.clock.runFor(31000);
  assert.ok(await page.evaluate(()=>window.__guardRenders)>0,'visible document resumes periodic repaint');
  await page.locator('.course-open[data-course="SYN101"]').click();await page.click('[data-action="edit-course"]');
  await page.evaluate(()=>{document.activeElement.blur();window.__guardRenders=0;});
  await page.clock.runFor(61000);assert.equal(await page.evaluate(()=>window.__guardRenders),0,'open editor suppresses background repaint even without focused input');
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(await page.evaluate(()=>window.__guardRenders),0);
  await page.evaluate(()=>window.acornHandleBack());await page.evaluate(()=>window.acornHandleBack());
  await page.clock.runFor(31000);assert.ok(await page.evaluate(()=>window.__guardRenders)>0,'closing editor resumes periodic repaint');
  await page.evaluate(()=>window.__guardObserver.disconnect());
  assert.equal(await page.evaluate(()=>window.acornHandleBack()),false,'plain calendar back must be handed to native host');
  assert.deepEqual(errors,[]);
  console.log('Synthetic mobile navigation, selection, editing and back interactions passed.');
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
