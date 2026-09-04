// Stress harness: reproduce el lost-update de CA-8 bajo saturación de CPU.
'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),{fork}=require('child_process');
const ROOT='C:/Workspaces/Intrale/platform.agent-6459-pipeline-dev';
const WORKER=path.join(ROOT,'.pipeline/lib/__tests__/fixtures/waves-concurrency-worker.js');
const ROUNDS=Number(process.env.ROUNDS||15), N=Number(process.env.N||10);
const DIAG=path.join(ROOT,'.scratch','stale-diag.log');
try{fs.unlinkSync(DIAG);}catch{}

function base(dir){fs.writeFileSync(path.join(dir,'waves.json'),JSON.stringify({
 version:'1.0',meta:{created_at:new Date().toISOString(),updated_at:new Date().toISOString(),updated_by:'test',source:'fixture'},
 active_wave:{number:1,name:'concurrent',started_at:new Date().toISOString(),issues:[]},
 planned_waves:[],archived_waves:[],dependencies:[]},null,2));}

function run(dir,issue){return new Promise(res=>{
 const c=fork(WORKER,[],{env:{...process.env,PIPELINE_DIR_OVERRIDE:dir,WORKER_ISSUE:String(issue),WORKER_WAVE:'1',LOCK_DIAG_FILE:DIAG},stdio:['ignore','pipe','pipe','ipc']});
 let e='';c.stderr.on('data',d=>e+=d);c.on('exit',code=>res({code,e}));});}

(async()=>{
 let bad=0;
 for(let r=0;r<ROUNDS;r++){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stress-waves-'));
  base(dir);
  const issues=Array.from({length:N},(_,i)=>9000+i);
  const out=await Promise.all(issues.map(i=>run(dir,i)));
  const ok=out.filter(x=>x.code===0).length;
  const parsed=JSON.parse(fs.readFileSync(path.join(dir,'waves.json'),'utf8'));
  const got=parsed.active_wave.issues.length;
  const lost=ok-got;
  if(lost!==0){bad++;console.log(`round ${r}: LOST-UPDATE issues=${got} exitosos=${ok} (lost=${lost})`);
    out.filter(x=>x.e).slice(0,3).forEach(x=>console.log('   stderr:',x.e.trim().split('\n')[0]));}
  else console.log(`round ${r}: ok issues=${got} exitosos=${ok}`);
  fs.rmSync(dir,{recursive:true,force:true});
 }
 console.log(`\n== rounds con lost-update: ${bad}/${ROUNDS}`);
 if(fs.existsSync(DIAG))console.log('\n== stale-steals registrados ==\n'+fs.readFileSync(DIAG,'utf8'));
 else console.log('\n== sin stale-steals registrados ==');
})();
