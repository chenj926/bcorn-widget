/* Standalone mapping dialog; host owns native binding and journal activation. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('../shared/sync-adapters/sheet-mapping'));else root.SheetMappingUI=factory(root.SheetMapping);}(typeof globalThis!=='undefined'?globalThis:this,function(Mapping){
  'use strict';
  function mount(host,{bridge,onConfirm}){
    const doc=host.ownerDocument;let selection=null,snapshot=null,disposed=false,busy=false,generation=0;
    const node=(tag,text,cls)=>{const el=doc.createElement(tag);if(text)el.textContent=text;if(cls)el.className=cls;return el;};
    const box=node('section',null,'sheet-mapping');box.setAttribute('aria-label','现有 Google Sheet 映射');
    const heading=node('h3','连接现有成绩表');const message=node('p','通过 Google 文件选择器授权单个文件。预览不会修改表格。','sm-message');message.setAttribute('role','status');
    const pick=node('button','选择 Google Sheet');pick.type='button';const tabs=node('select');tabs.setAttribute('aria-label','选择工作表');tabs.hidden=true;
    const preview=node('div',null,'sm-preview');const form=node('form');const rows=node('div',null,'sm-rows');const add=node('button','添加考核映射');add.type='button';const confirm=node('button','确认映射并连接');confirm.type='submit';confirm.disabled=true;
    const ordinaryLabel=node('label','已核对所有映射课程均使用普通加权规则（无最低分舍弃或替代规则）'),ordinary=node('input');ordinary.type='checkbox';ordinary.name='ordinary';ordinaryLabel.prepend(ordinary);
    const disclaimer=node('p','手动指定考核名称、成绩和权重单元格。空白成绩表示未评分，0 表示已评分零分。仅更新映射的成绩和权重，不写公式或其他工作表。请避免同步时同时编辑同一单元格；新增、删除或移动考核需重新映射。');
    const courseFields=node('div',null,'sm-course');for(const [name,label]of [['course','课程标识（用于匹配本机课程）'],['courseTitle','课程名称']]){const wrapper=node('label',label),input=node('input');input.name=name;input.required=true;wrapper.append(input);courseFields.append(wrapper);}
    form.append(courseFields,rows,add,ordinaryLabel,confirm);box.append(heading,message,pick,tabs,preview,disclaimer,form);host.append(box);
    function report(error){const labels={'mapping-required':'请完整填写映射，并明确选择成绩与权重格式。','invalid-mapping':'单元格地址无效或重复，请使用 A1:Z200 内不重叠的位置。','limit-exceeded':'当前仅支持 A1:Z200，请选择此范围内的单元格。','formula-protected':'所选成绩或权重单元格是公式、合并或受保护单元格，请改选可编辑位置。','mapping-stale':'名称或行位置已变化，请重新预览后确认。','invalid-remote':'映射位置的成绩或权重格式无效，请检查原表。','authorization-required':'需要重新通过 Google 文件选择器授权。','not-configured':'此版本尚未配置原生 Google 文件选择器。','conflict':'表格已被修改，请重新预览后确认。','relink-required':'工作表或连接已变化，请重新选择。','cancelled':'已取消选择，未修改成绩表。','network-error':'网络连接暂不可用，请稍后重试。'};message.textContent=labels[error?.code]||error?.message||'操作未完成；未修改成绩表。';}
    function addRow(){for(const prior of rows.children)prior.open=false;const row=node('details',null,'sm-row');row.open=true;const summary=node('summary','新考核 · 点击编辑单元格映射');row.append(summary);const fieldsBox=node('div',null,'sm-row-fields');row.append(fieldsBox);row.addEventListener('toggle',()=>{if(row.open)for(const other of rows.children)if(other!==row)other.open=false;});
      const fields=[['title','考核名称'],['anchorCell','名称单元格（如 A4）'],['gradeCell','成绩单元格（如 C4）'],['weightCell','权重单元格（如 B4）']];
      for(const [name,label]of fields){const wrapper=node('label',label),input=node('input');input.name=name;input.required=true;wrapper.append(input);fieldsBox.append(wrapper);if(name==='title')input.addEventListener('input',()=>{summary.textContent=input.value.trim()||'新考核 · 点击编辑单元格映射';});}
      for(const [name,label,options]of [['gradeMode','成绩格式',[['','请选择'],['ratio','小数 0–1'],['percentage','百分数 0–100'],['fraction','分数 40/50']]],['weightMode','权重格式',[['','请选择'],['ratio','小数 0–1'],['percentage','百分数 0–100']]]]){const wrapper=node('label',label),select=node('select');select.name=name;select.required=true;for(const [value,text]of options){const opt=node('option',text);opt.value=value;select.append(opt);}wrapper.append(select);fieldsBox.append(wrapper);}
      const remove=node('button','移除此映射');remove.type='button';remove.onclick=()=>row.remove();fieldsBox.append(remove);rows.append(row);
    }
    add.onclick=addRow;addRow();
    async function loadTab(){if(tabs.value===''){snapshot=null;confirm.disabled=true;preview.replaceChildren();return;}const version=++generation;confirm.disabled=true;snapshot=null;preview.replaceChildren();
      try{const result=await bridge.previewGradeSheet({selectionId:selection.selectionId,sheetId:Number(tabs.value)});if(disposed||version!==generation)return;if(!result?.complete)throw new Error('预览不完整，不能连接。');snapshot=result;
        const table=node('table');table.setAttribute('aria-label','只读结构预览');for(const [address,value]of Object.entries(result.cells||{})){if(value.value===''&&!value.formula)continue;const tr=node('tr');tr.append(node('th',address),node('td',String(value.value??'')),node('td',value.formula?'公式（只读）':value.protected?'受保护（只读）':''));table.append(tr);}preview.append(table);confirm.disabled=false;message.textContent='只读预览 A1:Z200 已加载。请选择明确的成绩和权重位置。';
      }catch(error){report(error);}}
    tabs.onchange=loadTab;
    pick.onclick=async()=>{if(busy)return;busy=true;pick.disabled=true;confirm.disabled=true;snapshot=null;selection=null;preview.replaceChildren();tabs.hidden=true;generation++;
      try{if(typeof bridge?.pickGradeSheet!=='function'||typeof bridge?.previewGradeSheet!=='function')throw new Error('此版本尚未配置原生 Google 文件选择器。');const result=await bridge.pickGradeSheet({});if(disposed)return;if(result&&!result.tabs&&Array.isArray(result.sheets))result.tabs=result.sheets.map(s=>({sheetId:s.sheetId,title:s.tab}));if(!result?.selectionId||!Array.isArray(result.tabs)||!result.tabs.length)throw new Error('未选择可用工作表。');selection=result;tabs.replaceChildren();const empty=node('option','请选择工作表');empty.value='';tabs.append(empty);for(const tab of result.tabs){const opt=node('option',tab.title);opt.value=String(tab.sheetId);tabs.append(opt);}tabs.hidden=false;message.textContent='已选择文件。请明确选择要预览的工作表。';}catch(error){report(error);}finally{busy=false;pick.disabled=false;}};
    form.onsubmit=async event=>{event.preventDefault();if(busy||!snapshot||!selection)return;busy=true;confirm.disabled=true;
      try{const courses=new Map();for(const row of rows.children){const get=name=>row.querySelector(`[name="${name}"]`).value.trim();const course=form.querySelector('[name="course"]').value.trim(),courseTitle=form.querySelector('[name="courseTitle"]').value.trim();if(!courses.has(course))courses.set(course,{id:course,title:courseTitle,termId:'',rules:{kind:ordinary.checked?'weighted':'unconfirmed'},assessments:[]});const c=courses.get(course);if(c.title!==courseTitle)throw new Error('同一课程标识必须使用相同名称。');const anchorCell=get('anchorCell').toUpperCase();c.assessments.push({id:anchorCell,title:get('title'),anchor:{cell:anchorCell,text:String(snapshot.cells[anchorCell]?.value??'')},gradeCell:get('gradeCell').toUpperCase(),weightCell:get('weightCell').toUpperCase(),gradeMode:get('gradeMode'),weightMode:get('weightMode')});}
        const mapping=Mapping.normalizeMapping({schemaVersion:1,confirmed:true,sheetId:snapshot.sheetId,tab:snapshot.tab,courses:[...courses.values()]});const book=Mapping.bookFromSnapshot(mapping,snapshot);
        await onConfirm({selectionId:selection.selectionId,mapping,book});if(!disposed)message.textContent='映射已确认。成绩以独立加权模型计算，不使用原表汇总公式。';
      }catch(error){report(error);}finally{busy=false;if(!disposed)confirm.disabled=!snapshot;}};
    return Object.freeze({dispose(){disposed=true;generation++;box.remove();}});
  }
  return Object.freeze({mount});
}));
