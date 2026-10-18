'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../src/shared/course-tools');
const fixture = () => tools.validateImport({ terms: [{ id:'synthetic', name:'Synthetic term', start:'2026-09-01', end:'2026-12-20', timezone:'America/Toronto', courses:[{code:'ABC101',title:'Synthetic course',color:'#436b95',room:'Example101',address:'Example campus'}], meetings:[{id:'weekly',code:'ABC101',title:'Synthetic course',section:'LEC',day:1,start:'09:00',end:'10:00',room:'Example101',exdates:['2026-10-12']}]}] }).data.terms[0];
const quiz = (title='Quiz one') => ({title,date:'2026-10-19',start:'09:15',end:'09:30',room:'Example102',color:'#a45b68'});
test('course-contained independent one-offs preserve weekly and sibling occurrences immutably', () => {
 const before=fixture(), snapshot=JSON.stringify(before);
 const first=tools.upsertCourseEvent(before,'ABC101',quiz());
 const second=tools.upsertCourseEvent(first.term,'ABC101',quiz('Quiz two'));
 assert.notEqual(first.event.id,second.event.id);
 assert.equal(second.term.meetings.length,3);
 assert.equal(first.event.color,'#A45B68'); assert.equal(second.term.courses[0].color,'#436B95');
 assert.equal(JSON.stringify(before),snapshot);
 assert.deepEqual(second.term.meetings[0],before.meetings[0]);
 assert.equal(tools.occursOn(second.term,first.event,'2026-10-26'),false);
 const updated=tools.upsertCourseEvent(second.term,'ABC101',{...quiz(),title:'Updated quiz',start:'09:20',end:'09:35'},first.event.id);
 assert.equal(updated.event.id,first.event.id);
 assert.deepEqual(updated.term.meetings.find(m=>m.id===second.event.id),second.event);
 const removed=tools.removeCourseEvent(updated.term,'ABC101',first.event.id);
 assert.deepEqual(removed.meetings.map(m=>m.id),['weekly',second.event.id]);
});
test('outside-term one-off does not widen or duplicate parent weekly schedule', () => {
 const term=fixture(), result=tools.upsertCourseEvent(term,'ABC101',{...quiz(),date:'2027-01-05'});
 assert.equal(result.term.end,'2026-12-20');
 assert.equal(tools.occursOn(result.term,result.event,'2027-01-05'),true);
 assert.equal(tools.occursOn(result.term,result.term.meetings[0],'2027-01-04'),false);
 const ics=tools.exportICS({terms:[result.term]},{courseCodes:['ABC101']});
 assert.match(ics,/DTSTART:20270105T141500Z/);
 assert.equal((ics.match(/Quiz one/g)||[]).length,2,'title in summary and description for one occurrence');
});
test('stable identity protects weekly rows and different course events from stale editors', () => {
 const term=fixture();
 assert.throws(()=>tools.upsertCourseEvent(term,'ABC101',quiz(),'weekly'));
 assert.throws(()=>tools.removeCourseEvent(term,'ABC101','weekly'));
 assert.throws(()=>tools.upsertCourseEvent(term,'missing',quiz()));
 const event=tools.upsertCourseEvent(term,'ABC101',quiz());
 assert.throws(()=>tools.removeCourseEvent(event.term,'different',event.event.id));
 for(const patch of [{date:'2026-02-29'},{start:'09:30',end:'09:15'},{title:''},{color:'url(https://example.com)'}]) assert.throws(()=>tools.upsertCourseEvent(term,'ABC101',{...quiz(),...patch}));
});
test('annotation ranges and colors round-trip but do not suppress scheduled classes', () => {
 const term=fixture();term.holidays=[{id:'h1',title:'Synthetic school break',start:'2026-10-19',end:'2026-10-23',kind:'school-break',source:'User supplied synthetic range'},{id:'h2',title:'Synthetic holiday',start:'2026-10-19',end:'2026-10-19',kind:'holiday'}];
 const checked=tools.validateImport({terms:[term]}); assert.ok(checked.ok,checked.errors.join('\n'));
 const saved=checked.data.terms[0]; assert.deepEqual(saved,term);
 assert.equal(tools.getDateAnnotations(saved,'2026-10-19').length,2);
 assert.equal(tools.getDateAnnotations(saved,'2026-10-23').length,1);
 assert.equal(tools.getDateAnnotations(saved,'2026-10-24').length,0);
 assert.equal(tools.occursOn(saved,saved.meetings[0],'2026-10-19'),true);
 const list=tools.getDateAnnotations(saved,'2026-10-19');list[0].title='Changed';assert.notEqual(saved.holidays[0].title,'Changed');
 for(const patch of [{kind:'cancel-all'},{end:'2026-10-18'},{start:'bad'},{id:''}]) { const candidate=structuredClone(term);Object.assign(candidate.holidays[0],patch);assert.equal(tools.validateImport({terms:[candidate]}).ok,false); }
});
test('identical overlapping one-offs export separately and retain UID across edit/reorder', () => {
 let a=tools.upsertCourseEvent(fixture(),'ABC101',quiz()); let b=tools.upsertCourseEvent(a.term,'ABC101',quiz());
 const once=t=>({...t,meetings:t.meetings.filter(m=>m.recurrence==='once')});
 const exported=tools.exportICS({terms:[once(b.term)]}); assert.equal((exported.match(/BEGIN:VEVENT/g)||[]).length,2);
 const edited=tools.upsertCourseEvent(b.term,'ABC101',{...quiz(),title:'Changed',start:'09:10'},a.event.id).term;edited.meetings.reverse();
 const ids=ics=>[...ics.matchAll(/^UID:(.+)$/gm)].map(x=>x[1]).sort();
 assert.deepEqual(ids(tools.exportICS({terms:[once(edited)]})),ids(exported));
});
test('optional sourced Engineering preset is idempotent and never changes meeting rules',()=>{
 const term=fixture(),before=JSON.stringify(term.meetings);term.holidays=[{id:'user',title:'Synthetic custom range',start:'2026-10-01',end:'2026-10-02',kind:'holiday'}];
 const preset=tools.getCalendarPresets()[0];assert.match(preset.title,/本科/);assert.match(preset.source,/engineering.calendar.utoronto.ca/);
 const once=tools.applyCalendarPreset(term,preset.id),twice=tools.applyCalendarPreset(once,preset.id);
 assert.deepEqual(once,twice);assert.equal(once.holidays.length,8);assert.equal(JSON.stringify(once.meetings),before);
 assert.equal(tools.getDateAnnotations(once,'2027-01-05').length,1);assert.equal(tools.getDateAnnotations(once,'2027-01-06').length,0);
 assert.deepEqual(tools.applyCalendarPreset(once,preset.id,false).holidays,term.holidays);
 assert.equal(tools.validateImport({terms:[once]}).ok,true);
});
