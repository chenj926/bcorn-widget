/* Explicit, bounded mappings for human-authored templates. No layout inference. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('../grade-book'),require('./grade-sync'),require('../sync-coordinator'));
  else root.SheetMapping=factory(root.GradeBook,root.GradeSync,root.BcornSync);
}(typeof globalThis!=='undefined'?globalThis:this,function(Grades,GradeSync,Sync){
  'use strict';
  const fail=(code,message)=>{throw Sync.syncError(code,message);};
  const clone=v=>JSON.parse(JSON.stringify(v));
  const same=(a,b)=>Sync.canonical(a)===Sync.canonical(b);
  const percent=n=>{const [mantissa,exponent='0']=String(n).split('e');return Number(mantissa+'e'+(Number(exponent)+2));};
  const CELL=/^[A-Z]{1,2}[1-9][0-9]{0,2}$/;
  function coordinate(a1){
    if(typeof a1!=='string'||!CELL.test(a1))fail('invalid-mapping','Use a single A1 cell address.');
    const [,letters,row]=a1.match(/^([A-Z]+)(\d+)$/);let col=0;for(const c of letters)col=col*26+c.charCodeAt(0)-64;
    if(col>26||Number(row)>200)fail('limit-exceeded','Preview and mapping are limited to A1:Z200.');
    return {row:Number(row)-1,col:col-1};
  }
  function cell(snapshot,a1){coordinate(a1);return snapshot.cells[a1]||{value:''};}
  function normalizeMapping(input){
    if(!input||input.schemaVersion!==1||input.confirmed!==true||!Number.isInteger(input.sheetId)||input.sheetId<0||typeof input.tab!=='string'||!input.tab||input.tab.length>100||!Array.isArray(input.courses)||!input.courses.length)fail('mapping-required','Explicitly select a tab and map assessment cells.');
    const m=clone(input),used=new Set();
    const book={schemaVersion:1,courses:m.courses.map(c=>({...c,assessments:(c.assessments||[]).map(a=>{
      if(!['ratio','percentage','fraction'].includes(a.gradeMode)||!['ratio','percentage'].includes(a.weightMode))fail('mapping-required','Choose score and weight units explicitly.');
      for(const key of ['gradeCell','weightCell']){coordinate(a[key]);if(used.has(a[key]))fail('invalid-mapping','Mapped cells must be unique.');used.add(a[key]);}
      if(!a.anchor||typeof a.anchor.text!=='string'||!a.anchor.text.trim())fail('mapping-required','Each assessment needs a label anchor to detect moved rows.');coordinate(a.anchor.cell);
      return {id:a.id,title:a.title,weight:0,status:'ungraded',score:null};
    })}))};
    Grades.normalizeBook(book);
    for(const c of m.courses)for(const a of c.assessments)if(used.has(a.anchor.cell))fail('invalid-mapping','Labels cannot be write targets.');
    return m;
  }
  function validateSnapshot(m,snapshot){
    if(!snapshot||snapshot.sheetId!==m.sheetId||snapshot.tab!==m.tab||!snapshot.cells||snapshot.complete!==true)fail('relink-required','The selected tab changed or preview is incomplete.');
    for(const c of m.courses)for(const a of c.assessments){
      if(cell(snapshot,a.anchor.cell).value!==a.anchor.text)fail('mapping-stale','Assessment labels moved or changed. Review the mapping again.');
      for(const key of ['gradeCell','weightCell'])if(cell(snapshot,a[key]).formula||cell(snapshot,a[key]).protected)fail('formula-protected','Formula or protected cells cannot be mapped for writing.');
    }
  }
  function bookFromSnapshot(input,snapshot){
    const m=normalizeMapping(input);validateSnapshot(m,snapshot);
    return Grades.normalizeBook({schemaVersion:1,courses:m.courses.map(c=>({id:c.id,title:c.title,termId:c.termId,rules:c.rules,assessments:c.assessments.map(a=>{
      const raw=cell(snapshot,a.gradeCell).value,weight=cell(snapshot,a.weightCell).value;
      const parsed=Grades.parseGradeInput(raw,a.gradeMode==='percentage'?'percentage':undefined);
      const wp=Grades.parseGradeInput(weight,a.weightMode==='percentage'?'percentage':undefined);
      if(!parsed.ok||!wp.ok||!wp.score)fail('invalid-remote','Mapped grades or weights are invalid; nothing was overwritten.');
      const ratio=s=>s.mode==='points'?s.earned/s.possible:s.value;
      return {id:a.id,title:a.title,weight:ratio(wp.score),status:parsed.score?'graded':'ungraded',score:parsed.score};
    })}))});
  }
  function writePlan(input,snapshot,{id,value,expected}){
    const m=normalizeMapping(input),records=GradeSync.recordsFromBook(bookFromSnapshot(m,snapshot));
    const current=records.find(r=>r.id===id);
    if(!current)fail('mapping-required','Additions and deletions require remapping; no cells were changed.');
    if(!same(current.value,expected))fail('conflict','The mapped assessment changed remotely.');
    if(same(current.value,value))return [];
    if(!value||current.value.kind!=='assessment'||value.kind!=='assessment')fail('mapping-required','Template structure is read-only.');
    const a=m.courses.find(c=>c.id===value.courseId)?.assessments.find(a=>a.id===value.assessmentId);
    if(!a||['courseId','assessmentId','title','kind'].some(k=>value[k]!==current.value[k])||value.status==='exempt')fail('mapping-required','Only mapped scores and weights can change. Exemptions require explicit template support.');
    const check=Grades.validateCourse({id:value.courseId,rules:{kind:'weighted'},assessments:[{...value,id:value.assessmentId}]});
    if(!check.ok)fail('invalid-local','Invalid score or weight.');
    const score=value.score;
    const grade=value.status!=='graded'?'':score.mode==='points'?`${score.earned}/${score.possible}`:(a.gradeMode==='percentage'?percent(score.value):score.value);
    // Fraction scores are stored as literal text under RAW; never interpreted as dates or formulas.
    const writes=[];
    if(!same(current.value.score,value.score)||current.value.status!==value.status)writes.push({cell:a.gradeCell,value:grade});
    if(current.value.weight!==value.weight)writes.push({cell:a.weightCell,value:(a.weightMode==='percentage'?percent(value.weight):value.weight)});
    return writes;
  }
  /** Native transport returns sanitized grid snapshots and validates stored mapping again.
   * commitMappedCells must reject stale expected snapshots, formulas, nonmapped cells,
   * changed connection IDs, and unauthorized files; never accepts arbitrary API paths.
   */
  function createAdapter({mapping,readSnapshot,commitMappedCells,authorizationStatus,getVersion}){
    const m=normalizeMapping(mapping);
    async function status(){return {state:typeof readSnapshot==='function'&&typeof commitMappedCells==='function'&&typeof authorizationStatus==='function'?await authorizationStatus():'not-configured',automaticInbound:false};}
    let cached=null;
    async function read(force){if((await status()).state!=='ready')fail('authorization-required','Select a file with Google Picker first.');let version=null;if(typeof getVersion==='function'){const metadata=await getVersion();if(!metadata||typeof metadata.version!=='string'||!metadata.version)fail('invalid-response','Remote version could not be verified.');version=metadata.version;if(!force&&cached&&cached.version===version)return clone(cached.snapshot);}
      const snapshot=await readSnapshot();validateSnapshot(m,snapshot);if(version!==null)cached={version,snapshot:clone(snapshot)};return snapshot;}
    return Object.freeze({status,async read(){return GradeSync.recordsFromBook(bookFromSnapshot(m,await read()));},async write(change){
      const before=await read(true),writes=writePlan(m,before,change);if(!writes.length)return change.value;
      cached=null;await commitMappedCells({mapping:m,expectedSnapshot:before,writes});
      const verified=GradeSync.recordsFromBook(bookFromSnapshot(m,await read(true))).find(r=>r.id===change.id);
      if(!verified||!same(verified.value,change.value))fail('verification-failed','Remote edit could not be verified; review the conflict.');return verified.value;
    }});
  }
  function template(course){
    const book=Grades.normalizeBook({schemaVersion:1,courses:[course]});const c=book.courses[0];
    if(c.assessments.some(a=>a.status==='exempt'))fail('mapping-required','This template cannot represent exemptions; resolve the syllabus exemption rule before creating it.');
    if(!c.assessments.length)fail('mapping-required','Add syllabus assessments and weights first.');
    if(c.assessments.length>190)fail('limit-exceeded','Use at most 190 assessments per template.');
    const rows=[['Assessment','Weight','Grade','Contribution'],...c.assessments.map(a=>[a.title,a.weight,a.status==='graded'?(a.score.mode==='points'?`${a.score.earned}/${a.score.possible}`:a.score.value):'',''])];
    // Do not execute formulas or derive authority from a preexisting calculated total.
    return {title:c.title,tab:'Grades',values:rows,mapping:{schemaVersion:1,confirmed:true,sheetId:0,tab:'Grades',courses:[{...c,assessments:c.assessments.map((a,i)=>({id:a.id,title:a.title,gradeCell:`C${i+2}`,weightCell:`B${i+2}`,gradeMode:'ratio',weightMode:'ratio',anchor:{cell:`A${i+2}`,text:a.title}}))}]}};
  }
  return Object.freeze({coordinate,normalizeMapping,validateSnapshot,bookFromSnapshot,writePlan,createAdapter,template});
}));
