const fs=require('fs'),os=require('os'),path=require('path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clobber-'));
process.env.PIPELINE_DIR_OVERRIDE=dir;
const f=path.join(dir,'waves.json');
fs.writeFileSync(f,JSON.stringify({version:'1.0',
  meta:{created_at:new Date().toISOString(),updated_at:new Date().toISOString(),updated_by:'t',source:'fx'},
  active_wave:{number:1,name:'w',started_at:new Date().toISOString(),
    issues:[{number:9001},{number:9002},{number:9003},{number:9004},{number:9005}]},
  planned_waves:[],archived_waves:[],dependencies:[]},null,2));
const waves=require('../.pipeline/lib/waves.js');
console.log('ANTES issues =', JSON.parse(fs.readFileSync(f,'utf8')).active_wave.issues.map(i=>i.number));

// Simular lectura transitoriamente fallida (EPERM/EBUSY de Windows durante rename concurrente)
const realRead=fs.readFileSync;
let armed=true;
fs.readFileSync=function(p,...a){
  if(armed && String(p).endsWith('waves.json')){ armed=false; const e=new Error('EPERM: operation not permitted'); e.code='EPERM'; throw e; }
  return realRead.call(fs,p,...a);
};
let r;
try{ r=waves.addIssueToWave(1,{number:9099,status:'pending'},{updated_by:'worker-X',source:'repro'}); }
catch(e){ console.log('THREW:',e.code||e.message); process.exit(0);}
fs.readFileSync=realRead;
console.log('addIssueToWave devolvio ->', JSON.stringify(r));
console.log('DESPUES issues =', JSON.parse(fs.readFileSync(f,'utf8')).active_wave.issues.map(i=>i.number));
