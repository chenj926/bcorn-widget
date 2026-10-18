/* Canonical timetable → native calendar boundary. No provider IDs or credentials. */
(function(root,factory){'use strict';if(typeof module==='object'&&module.exports)module.exports=factory(require('./course-tools'));else root.CalendarLink=factory(root.CourseTools);}(typeof globalThis!=='undefined'?globalThis:this,function(tools){
'use strict';
function ensureMeetingIds(input){
 const checked=tools.validateImport(input);if(!checked.ok)throw new Error(checked.errors.join('\n'));
 let changed=false;
 for(const term of checked.data.terms){const ids=new Set(term.meetings.map(m=>m.id).filter(Boolean));for(const m of term.meetings){if(m.id)continue;let id;do{id='meeting-'+(globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));}while(ids.has(id));m.id=id;ids.add(id);changed=true;}}
 return {data:checked.data,changed};
}
function buildSeries(input,reminderMinutes){
 if(reminderMinutes!==null&&(!Number.isInteger(reminderMinutes)||reminderMinutes<0||reminderMinutes>40320))throw new Error('请选择有效的提醒时间。');
 const checked=tools.validateImport(input);if(!checked.ok)throw new Error(checked.errors.join('\n'));
 const output=[];
 for(const term of checked.data.terms){for(const meeting of term.meetings){
  if(!meeting.id)throw new Error('请先保存日程的稳定标识，再连接系统日历。');
  const id=JSON.stringify([term.id,meeting.id]);if(id.length>512)throw new Error('日程标识过长，无法连接系统日历。');
  const course=term.courses.find(c=>c.code===meeting.code),waiting=tools.isWaitlisted(course)||tools.isWaitlisted(meeting);
  const occurrences=waiting?[]:tools.occurrenceDates(term,meeting).map(date=>({key:date,startMillis:+tools.localToUtc(date,meeting.start,term.timezone),endMillis:+tools.localToUtc(date,meeting.end,term.timezone)}));
  if(occurrences.length>1000)throw new Error('单项日程超过 1000 次，请缩短日期范围。');
  output.push({id,title:course.type==='event'?(meeting.title||course.title):[course.code,meeting.recurrence==='once'?meeting.title:meeting.section||course.title].filter(Boolean).join(' · '),description:meeting.title||course.title||'',location:[...new Set([meeting.room||course.room,meeting.location||course.location,meeting.address||course.address].filter(Boolean))].join(', '),timeZone:term.timezone,reminders:reminderMinutes===null?[]:[reminderMinutes],occurrences});
 }}
 return output;
}
return Object.freeze({ensureMeetingIds,buildSeries});
}));
