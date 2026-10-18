/* Explicit Android CalendarProvider connection. Timetable saves never depend on it. */
(function(root){'use strict';
 const KEY='bcorn-calendar-link-v1';let host=null,config={enabled:false,reminder:10,ids:[]},queue=Promise.resolve(),pending=null,lastError='',selectedTarget=-1;
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function saveConfig(){localStorage.setItem(KEY,JSON.stringify(config));}
 function supported(){return !!host?.bridge?.calendarStatus;}
 function result(value){if(!value?.ok)throw new Error(value?.message||'系统日历暂时不可用，本地数据已保留。');return value;}
 function report(error){lastError=String(error?.message||error);host?.notify('课表已保存在本地；日历更新未完成：'+lastError);}
 async function sync(data){
  // Preflight every series first. Invalid dates cannot cause partial deletions.
  const series=root.CalendarLink.buildSeries(data,config.reminder),nextIds=new Set(series.map(s=>s.id));
  for(const payload of series){
   if(!config.enabled)return;
   if(!config.ids.includes(payload.id)){config.ids.push(payload.id);saveConfig();}
   result(await host.bridge.syncCalendarEvent(payload));
  }
  for(const id of [...config.ids])if(!nextIds.has(id)){
   if(!config.enabled)return;
   result(await host.bridge.removeCalendarEvent({id}));config.ids=config.ids.filter(x=>x!==id);saveConfig();
  }
  lastError='';
 }
 function onTimetableSaved(data){
  if(!supported()||!config.enabled||!data)return Promise.resolve();
  pending=data;
  queue=queue.then(async()=>{while(pending&&config.enabled){const next=pending;pending=null;try{await sync(next);}catch(error){report(error);break;}}}).catch(report);
  return queue;
 }
 async function openSettings(){
  if(!host)return;
  if(!supported()){host.openDialog('系统日历', '<p>当前平台可导出 ICS 日历文件。</p><p class="field-hint">自动写入系统日历目前仅适用于 Android。Google / Outlook 账户需要在设备上提供可写日历。</p>');return;}
  let status,calendars=[];
  try{status=result(await host.bridge.calendarStatus());if(status.permissionGranted)calendars=result(await host.bridge.listCalendars()).calendars||[];}
  catch(error){host.openDialog('系统日历',`<p role="alert">${esc(error.message)}</p><p>本地课表不会受到影响。</p>`);return;}
  selectedTarget=Number(status.selectedCalendarId);
  const selected=String(status.selectedCalendarId);
  host.openDialog('连接系统日历', `<section id="calendar-link-panel"><p>选择一个设备上的日历。启用后，课程与日程的新增、修改、删除会自动更新到这里，候补课程不会写入。</p><p class="field-hint">Google、Outlook 或 Vivo 是否同步到云端，由设备上的账户和日历设置决定。提醒由所选日历负责；请检查系统通知权限。</p>${!status.permissionGranted?'<button class="primary-btn" data-calendar="permission">允许访问设备日历</button>':calendars.length?`<label class="field"><span>写入哪个日历</span><select id="calendar-target">${calendars.map(c=>`<option value="${esc(c.id)}" ${String(c.id)===selected?'selected':''}>${esc(c.name)} · ${esc(c.account)}</option>`).join('')}</select></label><label class="field"><span>提前提醒</span><select id="calendar-reminder">${[[null,'不提醒'],[0,'开始时'],[5,'5 分钟'],[10,'10 分钟'],[15,'15 分钟'],[30,'30 分钟'],[60,'1 小时']].map(([v,label])=>`<option value="${v===null?'none':v}" ${config.reminder===v?'selected':''}>${label}</option>`).join('')}</select></label><button class="primary-btn" data-calendar="enable">${config.enabled?'保存设置并更新日历':'启用自动更新'}</button>`:'<p>没有可写的日历。请先在系统日历中添加账户或本地日历，然后重新打开此页面。</p>'}<p class="field-hint">${config.enabled?'已启用：保存课表后自动更新设备日历。':'尚未启用自动写入。'} 更换目标不会搬移已写入的安排；需要先移除旧连接的安排。</p>${lastError?`<p class="form-error" role="alert">${esc(lastError)}</p>`:''}${config.enabled?'<button class="secondary-btn" data-calendar="pause">暂停自动更新</button>':''}${config.ids.length?'<button class="text-btn" data-calendar="remove">移除 bcorn 已写入的安排…</button>':''}<p id="calendar-link-error" class="form-error" role="alert"></p></section>`,null,{push:false});
 }
 async function handlePanelAction(event){
   const button=event.target.closest('[data-calendar]');if(!button)return;button.disabled=true;
   try{
    switch(button.dataset.calendar){
     case 'permission':{const permission=result(await host.bridge.requestCalendarPermission());if(!permission.permissionGranted)throw new Error('未获得日历权限。你仍可在本地编辑或导出 ICS。');await openSettings();break;}
     case 'enable':{
      const target=Number(document.querySelector('#calendar-target').value),reminder=document.querySelector('#calendar-reminder').value;
      const data=host.getData();if(!data)throw new Error('请先添加或导入课程。');
      const identified=root.CalendarLink.ensureMeetingIds(data);const minutes=reminder==='none'?null:Number(reminder);
      root.CalendarLink.buildSeries(identified.data,minutes);
      if(config.ids.length&&target!==selectedTarget)throw new Error('请先移除旧连接的安排，再更换日历。当前连接未更改。');
      const previous={...config,ids:[...config.ids]};
      config.enabled=false;saveConfig();await queue;
      try{
       result(await host.bridge.selectCalendar({calendarId:target}));
       if(identified.changed)await host.persist(identified.data);
       config.reminder=minutes;config.enabled=true;saveConfig();
      }catch(error){config=previous;saveConfig();throw error;}
      await onTimetableSaved(host.getData());if(lastError)throw new Error(lastError);
      host.notify('已更新设备日历。云同步和提醒由系统日历处理。');await openSettings();break;
     }
     case 'pause':config.enabled=false;pending=null;saveConfig();host.notify('已暂停自动更新，已写入的日历安排仍保留。');await openSettings();break;
     case 'remove':button.disabled=false;confirmRemove();break;
    }
   }catch(error){const node=document.querySelector('#calendar-link-error');if(node)node.textContent=error.message;else report(error);}finally{button.disabled=false;}
 }
 function confirmRemove(){
  host.openDialog('移除已连接的日历安排？','<p>只移除由 bcorn 这次连接写入的安排，其他日历内容和本地课表都会保留。自动更新也会暂停。</p><div class="dialog-actions"><button class="secondary-btn" data-action="close-dialog">保留安排</button><button class="danger-btn" id="calendar-remove-confirm">移除这些安排</button></div><p id="calendar-remove-error" role="alert"></p>',null,{push:true});
 }
 async function handleRemoveConfirm(event){event.target.disabled=true;config.enabled=false;pending=null;saveConfig();try{await queue;for(const id of [...config.ids]){result(await host.bridge.removeCalendarEvent({id}));config.ids=config.ids.filter(x=>x!==id);saveConfig();}lastError='';host.notify('已移除连接的安排，本地课表保留。');await openSettings();}catch(error){document.querySelector('#calendar-remove-error').textContent=error.message;}finally{event.target.disabled=false;}}

 function init(options){if(!host&&typeof document!=='undefined')document.addEventListener('click',event=>{if(event.target.closest('#calendar-link-panel [data-calendar]'))void handlePanelAction(event);else if(event.target.closest('#calendar-remove-confirm'))void handleRemoveConfirm(event);});host=options;try{const saved=JSON.parse(localStorage.getItem(KEY)||'null');if(saved&&Array.isArray(saved.ids)&&saved.ids.every(id=>typeof id==='string')&&saved.ids.length<=300000&&(saved.reminder===null||Number.isInteger(saved.reminder)))config={enabled:saved.enabled===true,reminder:saved.reminder,ids:[...new Set(saved.ids)]};}catch(_){lastError='日历连接设置无法读取。自动更新保持关闭。';}}
 async function pauseForImport(){config.enabled=false;pending=null;saveConfig();await queue;}
 root.CalendarIntegration=Object.freeze({init,openSettings,onTimetableSaved,pauseForImport});
}(typeof window!=='undefined'?window:globalThis));
