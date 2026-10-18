'use strict';
// Synthetic data only. Civil-date operations are deliberately host-timezone independent.
const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../src/shared/course-tools');
const fixture = () => ({ terms: [{ id: 'synthetic', name: 'Synthetic year', start: '2026-01-01', end: '2026-12-31', timezone: 'America/Toronto', courses: [{ code: 'EVT-SYN', title: 'Study group', type: 'event', address: 'Example Library' }], meetings: [{ code: 'EVT-SYN', title: 'Study group', recurrence: 'once', date: '2026-10-18', day: 7, start: '10:00', end: '11:00', exdates: [] }] }], transcript: null });
test('one-off event type and date survive validation, reload and export exactly once', () => {
 const first = tools.validateImport(fixture()); assert.ok(first.ok, first.errors.join('\n'));
 const data = tools.validateImport(JSON.stringify(first.data)).data;
 const term = data.terms[0], event = term.meetings[0];
 assert.equal(term.courses[0].type, 'event'); assert.equal(term.courses[0].address, 'Example Library');
 assert.equal(event.recurrence, 'once'); assert.equal(event.date, '2026-10-18');
 assert.equal(event.from, event.date); assert.equal(event.until, event.date);
 assert.deepEqual(tools.occurrenceDates(term, event), ['2026-10-18']);
 assert.ok(tools.occursOn(term, event, '2026-10-18'));
 assert.equal(tools.occursOn(term, event, '2026-10-25'), false);
 const ics = tools.exportICS(data, {courseCodes:['EVT-SYN']});
 assert.equal((ics.match(/BEGIN:VEVENT/g)||[]).length, 1);
 assert.match(ics, /DTSTART:20261018T140000Z/);
});
test('one-off validation rejects missing or impossible dates and unknown recurrence/type', () => {
 for (const [target,key,value] of [['meeting','date','2026-02-29'],['meeting','date',undefined],['meeting','recurrence','monthly'],['course','type','unknown']]) {
  const data=fixture(); const item=target==='meeting'?data.terms[0].meetings[0]:data.terms[0].courses[0]; item[key]=value;
  assert.equal(tools.validateImport(data).ok,false, key+String(value));
 }
});
test('once date sets weekday and respects exclusions independently of teaching bounds', () => {
 const data=fixture(); data.terms[0].meetings[0].day=1;
 const term=tools.validateImport(data).data.terms[0], event=term.meetings[0];
 assert.equal(event.day,7);
 event.exdates=['2026-10-18']; assert.deepEqual(tools.occurrenceDates(term,event),[]);
 event.exdates=[]; term.end='2026-10-17'; assert.deepEqual(tools.occurrenceDates(term,event),['2026-10-18']);
});
test('weekly events use actual week boundaries and exclude cancelled occurrences', () => {
 const data=fixture(), event=data.terms[0].meetings[0]; event.recurrence='weekly'; delete event.date; event.from='2026-10-01'; event.until='2026-10-31'; event.exdates=['2026-10-18'];
 const term=tools.validateImport(data).data.terms[0];
 assert.deepEqual(tools.occurrenceDates(term,term.meetings[0]),['2026-10-04','2026-10-11','2026-10-25']);
 for(const date of ['2026-09-27','2026-10-18','2026-11-01']) assert.equal(tools.occursOn(term,term.meetings[0],date),false);
});
test('civil day/week navigation crosses month, year, leap day and DST without drift', () => {
 assert.equal(tools.addDays('2026-12-31',1),'2027-01-01');
 assert.equal(tools.addDays('2028-02-28',1),'2028-02-29');
 assert.equal(tools.addDays('2028-02-29',1),'2028-03-01');
 assert.equal(tools.addDays('2026-03-08',7),'2026-03-15');
 assert.equal(tools.addDays('2026-11-01',-7),'2026-10-25');
 assert.equal(tools.weekStart('2027-01-01'),'2026-12-28');
 assert.equal(tools.weekStart('2026-10-18'),'2026-10-12');
 assert.throws(()=>tools.weekStart('2026-02-29'));
});
test('one-off export honors DST timezone and existing term data is untouched', () => {
 const data=fixture(), before=JSON.stringify(data);
 data.terms[0].meetings[0].date='2026-11-01'; data.terms[0].meetings[0].start='01:30'; data.terms[0].meetings[0].end='02:30';
 const input=JSON.stringify(data), ics=tools.exportICS(data,{courseCodes:['EVT-SYN']});
 assert.match(ics,/DTSTART:20261101T053000Z/); assert.match(ics,/DTEND:20261101T073000Z/);
 assert.equal(JSON.stringify(data),input); assert.notEqual(input,before);
});
test('upgrade-style normalize/edit/reload preserves synthetic 15-pattern schedule, addresses, waitlist, TBA and transcript', () => {
 const data = {source:'local',modifiedAt:'2026-10-17T06:00:00Z',terms:[{id:'synthetic-existing',name:'Existing calendar',start:'2026-09-01',end:'2026-12-31',timezone:'America/Toronto',courses:[],meetings:[]}],transcript:{cgpa:'3.5',sessions:[{name:'Synthetic prior term',courses:[{code:'PAST',title:'Past work',weight:'0.5',mark:'80',grade:'A-',avg:'B'}],notes:['Synthetic retained note']}]}};
 const term=data.terms[0];
 for(let i=0;i<15;i++) {const code=`SYN${i}`; term.courses.push({code,title:`Synthetic subject ${i}`,credits:'0.5',status:i===3?'waitlisted':'enrolled',room:`Room ${i}`,address:`${100+i} Example Street`}); term.meetings.push({id:`synthetic-meeting-${i}`,code,title:`Synthetic subject ${i}`,section:i%2?'TUT01':'LEC01',kind:i%2?'TUT':'LEC',day:i%7+1,start:'09:00',end:'10:00',room:`Room ${i}`,location:`Example Hall ${i}`,address:`${100+i} Example Street`,building:'Example Hall',delivery:'In person',status:i===3?'waitlisted':'enrolled',from:'2026-09-01',until:'2026-12-31',exdates:['2026-10-12']}); }
 term.courses.push({code:'TBA-SYN',title:'Unscheduled',credits:'0.5',status:'enrolled',address:'Retained TBA address'});
 const once=tools.validateImport(data); assert.ok(once.ok,once.errors.join('\n'));
 const edited=structuredClone(once.data); edited.terms[0].meetings[7].room='Updated room'; edited.terms[0].meetings[7].address='Updated synthetic address';
 const reloaded=tools.validateImport(JSON.stringify(edited)); assert.ok(reloaded.ok); assert.deepEqual(reloaded.data,edited);
 assert.equal(reloaded.data.terms[0].meetings.length,15); assert.equal(reloaded.data.terms[0].courses.length,16);
 assert.equal(reloaded.data.terms[0].meetings[7].location,'Example Hall 7');
 assert.equal(reloaded.data.terms[0].meetings[3].status,'waitlisted');
 assert.equal(reloaded.data.terms[0].courses.at(-1).address,'Retained TBA address');
 assert.equal(reloaded.data.transcript.sessions[0].courses[0].grade,'A-');
 assert.deepEqual(reloaded.data.terms[0].meetings[7].exdates,['2026-10-12']);
});
