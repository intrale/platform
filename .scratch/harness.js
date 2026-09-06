const fs=require('fs'),os=require('os'),path=require('path');
const {fork}=require('child_process');
const W=path.join(__dirname,'..','.pipeline','lib','__tests__','fixtures','waves-concurrency-worker.js');
function base(dir){fs.writeFileSync(path.join(dir,'waves.json'),JSON.stringify({version:'1.0',
 meta:{created_at:new Date().toISOString(),updated_at:new Date().toISOString(),updated_by:'test',source:'fixture'},
 active_wave:{number:1,name:'concurrent',started_at:new Date().toISOString(),issues:[]},
 planned_waves:[],archived_waves:[],dependencies:[]},null,2));}
function fw(dir,issue){return new Promise(res=>{const c=fork(W,[],{env:{...process.env,PIPELINE_DIR_OVERRIDE:dir,WORKER_ISSUE:String(issue),WORKER_WAVE:'1'},stdio:['ignore','pipe','pipe','ipc']});let se='';c.stderr.on('data',d=>se+=d);c.on('exit',code=>res({code,se,issue}));});}
(async()=>{
 const rounds=Number(process.argv[2]||10);
 for(let r=0;r<rounds;r++){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'h-'));
  base(dir);
  const issues=Array.from({length:10},(_,i)=>9000+i);
  const res=await Promise.all(issues.map(i=>fw(dir,i)));
  const p=JSON.parse(fs.readFileSync(path.join(dir,'waves.json'),'utf8'));
  const got=p.active_wave.issues.map(i=>i.number).sort();
  const ok=res.filter(x=>x.code===0).map(x=>x.issue).sort();
  if(got.length!==ok.length){
   console.log(`[${process.pid}] MISMATCH r${r}: issues=${got.length} exitosos=${ok.length}`);
   console.log('  perdidos:',ok.filter(i=>!got.includes(i)));
   console.log('  extra   :',got.filter(i=>!ok.includes(i)));
   for(const x of res) if(x.se.trim()) console.log(`  stderr#${x.issue}(code=${x.code}):`,x.se.trim().slice(0,300));
  }
  fs.rmSync(dir,{recursive:true,force:true});
 }
 console.log(`[${process.pid}] done ${rounds} rounds`);
})();
