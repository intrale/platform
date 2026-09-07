'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),{fork}=require('child_process');
const ROOT='C:/Workspaces/Intrale/platform.agent-6459-pipeline-dev';
const WORKER=path.join(ROOT,'.pipeline/lib/__tests__/fixtures/waves-concurrency-worker.js');
const N=Number(process.env.N||14), TAG=process.env.TAG||'x';
function base(dir){fs.writeFileSync(path.join(dir,'waves.json'),JSON.stringify({
 version:'1.0',meta:{created_at:new Date().toISOString(),updated_at:new Date().toISOString(),updated_by:'test',source:'fixture'},
 active_wave:{number:1,name:'concurrent',started_at:new Date().toISOString(),issues:[]},
 planned_waves:[],archived_waves:[],dependencies:[]},null,2));}
function run(dir,issue,diag){return new Promise(res=>{
 const c=fork(WORKER,[],{env:{...process.env,PIPELINE_DIR_OVERRIDE:dir,WORKER_ISSUE:String(issue),WORKER_WAVE:'1',LOCK_DIAG_FILE:diag},stdio:['ignore','pipe','pipe','ipc']});
 let e='';c.stderr.on('data',d=>e+=d);c.on('exit',code=>res({code,e,issue}));});}
(async()=>{
 for(let r=0;r<Number(process.env.ROUNDS||8);r++){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'s1-'));
  const diag=path.join(dir,'diag.log'); base(dir);
  const issues=Array.from({length:N},(_,i)=>9000+i);
  const out=await Promise.all(issues.map(i=>run(dir,i,diag)));
  const ok=out.filter(x=>x.code===0).length;
  const got=JSON.parse(fs.readFileSync(path.join(dir,'waves.json'),'utf8')).active_wave.issues.length;
  if(ok!==got){
   console.log(`\n### ${TAG} r${r}: LOST issues=${got} exitosos=${ok}`);
   const lines=fs.readFileSync(diag,'utf8').trim().split('\n').map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
   const w=lines.filter(x=>x.ev==='write');
   console.log('writes(pid,issues):',w.map(x=>`${x.pid}:${x.issues}`).join(' '));
   const seen={};w.forEach(x=>{seen[x.issues]=(seen[x.issues]||0)+1});
   console.log('conteos duplicados:',Object.entries(seen).filter(([k,v])=>v>1).map(([k,v])=>`issues=${k} x${v}`).join(', ')||'ninguno');
   console.log('--- timeline ---');
   lines.forEach(x=>{ if(x.ev==='write') console.log(`  ${x.t} pid=${x.by} WRITE issues=${x.issues}`);
     else if(x.ev==='read') console.log(`  ${x.t} pid=${x.by} READ  issues=${x.issues}`);
     else console.log(`  ${x.t} pid=${x.by} ${x.reason}${x.reason&&x.reason.startsWith('ACQ')?'':' holder='+x.holder}`); });
   out.filter(x=>x.e).slice(0,2).forEach(x=>console.log('stderr:',x.e.trim().split('\n')[0]));
   fs.rmSync(dir,{recursive:true,force:true}); process.exit(0);
  }
  fs.rmSync(dir,{recursive:true,force:true});
 }
 console.log(`${TAG}: sin repro`);
})();
