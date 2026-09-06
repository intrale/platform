'use strict';
const path=require('path');
const root=path.join(__dirname,'..','.pipeline','lib');
const lock=require(path.join(root,'file-lock.js'));
const span={issue:process.env.WORKER_ISSUE,pid:process.pid,depth:0,nested:0};
let depth=0;
const now=()=>performance.timeOrigin+performance.now();
const orig=lock.withLockSync;
lock.withLockSync=function(fp,fn,opts){
  return orig.call(lock,fp,function(){
    depth++; if(depth===1){span.enter=now();} else {span.nested++;}
    try{ return fn(); } finally{ if(depth===1){span.exit=now();} depth--; }
  },opts);
};
const waves=require(path.join(root,'waves.js'));
const issue=Number(process.env.WORKER_ISSUE);
let code=0;
try{ waves.addIssueToWave(Number(process.env.WORKER_WAVE),{number:issue,status:'pending'},
  {updated_by:`worker-${process.pid}`,source:'concurrency-test',note:`add #${issue}`}); }
catch(e){ span.err=(e.code||'')+' '+e.message; code=1; }
try{ process.send({span}); }catch{}
setTimeout(()=>process.exit(code),0);
