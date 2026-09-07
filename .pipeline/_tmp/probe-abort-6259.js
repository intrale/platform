const V=['PULPO_NO_AUTOSTART','PULPO_SKIP_AGENT_MODELS_VALIDATE','PULPO_SKIP_DATA_RESIDENCY_VALIDATE'];
require(process.argv[2]);
process.on('exit',()=>console.error('POST-ABORT>>', V.map(v=>`${v}=${(v in process.env)?process.env[v]:'<ausente>'}`).join(' | ')));
setImmediate(()=>{ throw new Error('ABORTO SIMULADO'); });
