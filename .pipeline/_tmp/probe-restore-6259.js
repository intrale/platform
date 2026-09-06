const VARS=['PULPO_NO_AUTOSTART','PULPO_SKIP_AGENT_MODELS_VALIDATE','PULPO_SKIP_DATA_RESIDENCY_VALIDATE','PIPELINE_STALENESS_HOURS','PIPELINE_ROOT_OVERRIDE','PIPELINE_DIR_OVERRIDE'];
const before={}; VARS.forEach(v=>before[v]= (v in process.env)? process.env[v] : '<ausente>');
const real=process.reallyExit.bind(process); let done=false;
const rep=()=>{ if(done) return; done=true;
  VARS.forEach(v=>{ const after=(v in process.env)? process.env[v] : '<ausente>';
    console.error(`RESTORE>> ${v} antes=${before[v]} despues=${after} ${before[v]===after?'OK':'*** ALTERADA ***'}`);});};
process.reallyExit=(c)=>{rep();real(c);};
require(process.argv[2]);
process.on('exit',rep);
