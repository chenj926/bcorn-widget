'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICal, isAcornAppUrl, isLoggedIn } = require('../src/acorn');

test('original ACORN parser retains multi-day meetings and date exceptions', () => {
 const result = parseICal([
  'BEGIN:VCALENDAR','BEGIN:VEVENT','DTSTART;TZID=America/Toronto:20260908T100000',
  'DTEND;TZID=America/Toronto:20260908T110000','RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261208T235959Z',
  'EXDATE;TZID=America/Toronto:20261027T100000,20261029T100000',
  'SUMMARY:SYN101H1 LEC0101','DESCRIPTION:Synthetic Course\\nSynthetic Building','LOCATION:SYN 100',
  'END:VEVENT','END:VCALENDAR'
 ].join('\r\n'));
 assert.equal(result.length,2); assert.deepEqual(result.map(m=>m.day),[2,4]);
 assert.equal(result[0].from,'2026-09-08'); assert.equal(result[0].until,'2026-12-08');
 assert.deepEqual(result[0].exdates,['2026-10-27','2026-10-29']);
 assert.equal(result[0].location,'SYN 100'); assert.equal(result[0].building,'Synthetic Building');
});
test('expired authentication reports login required and makes no hidden retries', async()=>{
 let requests=0;
 assert.equal(await isLoggedIn({fetch:async()=>{requests++;return {url:'https://login.example.invalid/',headers:{get:()=> 'text/html'},status:200,ok:true};}}),false);
 assert.equal(requests,1);
 assert.equal(isAcornAppUrl('https://acorn.utoronto.ca/sws/'),true);
 assert.equal(isAcornAppUrl('https://acorn.utoronto.ca.evil.invalid/sws/'),false);
});
