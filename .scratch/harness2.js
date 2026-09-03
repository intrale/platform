const fs=require('fs'),os=require('os'),path=require('path');const {fork}=require('child_process');
const W=path.join(__dirname,'worker-instr.js');
(async()=>{
for(let r=0;r<Number(process.argv[2]||10);r++){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'h2-'));
 fs.writeFileSync(path.join(dir,'waves.json'),JSON.stringify({version:'1.0',
  meta:{created_at:new Date().toISOString(),updated_at:new Date().toISOString(),updated_by:'test',source:'fixture'},
  active_wave:{number:1,name:'concurrent',started_at:new Date().toISOString(),issues:[]},
  planned_waves:[],archived_waves:[],dependencies:[]},null,2));
 const issues=Array.from({length:10},(_,i)=>9000+i);
 const res=await Promise.all(issues.map(i=>new Promise(rs=>{
  const c=fork(W,[],{env:{...process.env,PIPELINE_DIR_OVERRIDE:dir,WORKER_ISSUE:String(i),WORKER_WAVE:'1'},stdio:['ignore','ignore','pipe','ipc']});
  let se='',sp=null;c.stderr.on('data',d=>se+=d);c.on('message',m=>{sp=m.span});c.on('exit',code=>rs({code,se,issue:i,span:sp}));})));
 const p=JSON.parse(fs.readFileSync(path.join(dir,'waves.json'),'utf8'));
 const got=p.active_wave.issues.map(i=>i.number);
 const ok=res.filter(x=>x.code===0).map(x=>x.issue);
 if(got.length!==ok.length){
  console.log(`MISMATCH r${r}: issues=${got.length} exitosos=${ok.length} perdidos=[${ok.filter(i=>!got.includes(i))}]`);
  const arr=res.filter(x=>x.span&&x.span.enter).map(x=>x.span).sort((a,b)=>a.enter-b.enter);
  let ov=0;
  for(let a=0;a<arr.length;a++)for(let b=a+1;b<arr.length;b++)
   if(arr[b].enter<arr[a].exit){ov++;console.log(`  OVERLAP: #${arr[a].issue}[${arr[a].enter}..${arr[a].exit}] ∩ #${arr[b].issue}[${arr[b].enter}..${arr[b].exit}]`);}
  console.log(`  overlaps=${ov}`);
  res.filter(x=>x.span&&x.span.err).forEach(x=>console.log(`  ERR #${x.issue}: ${x.span.err}`));
  res.filter(x=>!x.span||!x.span.enter).forEach(x=>console.log(`  SIN-SPAN #${x.issue} code=${x.code} se=${x.se.slice(0,200)}`));
  process.exit(0);
 }
 fs.rmSync(dir,{recursive:true,force:true});
}
console.log('sin mismatch');})();
