const fs=require('fs'),path=require('path'),os=require('os');
const sweep=require('../../.pipeline/lib/commander/orphan-sweep.js');
const inflight=require('../../.pipeline/lib/commander/inflight-fallback.js');
const audit=require('../../.pipeline/lib/audit-log.js');
const NOW=1787700000000, T=NOW-3*3600*1000;
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'chain6459-'));
const logDir=path.join(tmp,'logs'); fs.mkdirSync(logDir,{recursive:true});
fs.writeFileSync(path.join(logDir,`commander--1001-${T}.stages.jsonl`),
 [JSON.stringify({etapa:'transcripción',boot_id:'B0',chat_id:'-1001'}),JSON.stringify({etapa:'envío',correlation_id:'cA'})].join('\n')+'\n');
fs.writeFileSync(path.join(logDir,`commander--1002-${T+1}.stages.jsonl`),
 [JSON.stringify({etapa:'transcripción',boot_id:'B0',chat_id:'-1002'}),JSON.stringify({etapa:'envío',correlation_id:'cB'})].join('\n')+'\n');
fs.writeFileSync(path.join(tmp,'commander-history.jsonl'),'');
sweep.runOrphanSweep({logDir,pipelineDir:tmp,nowMs:NOW,currentBootId:'B1',deps:{
 outboundStatus:(h,c)=>c==='cA'?'enviado':'fallido',
 noteFallbackDeliveryResolved:inflight.noteFallbackDeliveryResolved}});
const f=fs.readdirSync(path.join(tmp,'logs')).find(x=>x.startsWith('commander-dispatch'));
const p=path.join(tmp,'logs',f);
console.log('archivo audit:',f);
console.log('verifyChain =',JSON.stringify(audit.verifyChain(p)));
