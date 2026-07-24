// roadmap-registry-check.js
// Validacion cruzada roadmap.json vs agent-registry.json (#1660)
// ZOMBIE: story in_progress sin agente active en registry
// ORPHAN: agente active sin story in_progress en roadmap activo

var fs=require("fs");
var path=require("path");

var HOOKS_DIR=path.dirname(module.filename);
var REPO_ROOT=process.env.CLAUDE_PROJECT_DIR||path.resolve(HOOKS_DIR,"../..");
var SCRIPTS_DIR=path.join(REPO_ROOT,"scripts");
var LOG_FILE=path.join(HOOKS_DIR,"hook-debug.log");
var ROADMAP_FILE=path.join(SCRIPTS_DIR,"roadmap.json");
var REGISTRY_FILE=path.join(HOOKS_DIR,"agent-registry.json");

function log(msg){try{fs.appendFileSync(LOG_FILE,"["+new Date().toISOString()+"] roadmap-registry-check: "+msg+String.fromCharCode(10));}catch(e){}}

function readJson(p){try{if(!fs.existsSync(p))return null;return JSON.parse(fs.readFileSync(p,"utf8"));}catch(e){log("Error leyendo "+p+": "+e.message);return null;}}

function normalizeIssueNumber(raw){if(raw==null)return null;var n=parseInt(String(raw).replace(/^#/,"").trim(),10);return isNaN(n)?null:n;}

function getActiveSprint(rm){if(!rm||!Array.isArray(rm.sprints))return null;return rm.sprints.find(function(s){return s.status==="active";})||null;}

function getInProgressStories(sp){if(!sp||!Array.isArray(sp.stories))return[];return sp.stories.filter(function(s){return s.status==="in_progress";});}

function getActiveAgents(reg){if(!reg||typeof reg.agents!=="object")return[];return Object.values(reg.agents).filter(function(a){return a&&a.status==="active";});}

function runCrossValidation(opts){
  opts=opts||{};
  var rmp=opts.roadmapPath||ROADMAP_FILE;
  var rgp=opts.registryPath||REGISTRY_FILE;
  var roadmap=readJson(rmp);
  var registry=readJson(rgp);
  var result={zombies:[],orphans:[],auto_corrected:[],timestamp:new Date().toISOString(),sprint_id:null,ok:true};
  if(!roadmap){result.ok=false;result.error="roadmap.json no disponible";log(result.error);return result;}
  var sp=getActiveSprint(roadmap);
  if(!sp){log("Sin sprint activo");return result;}
  result.sprint_id=sp.id;
  var ips=getInProgressStories(sp);
  var aas=getActiveAgents(registry||{agents:{}});
  var aabi={};
  aas.forEach(function(a){var n=normalizeIssueNumber(a.issue);if(n!==null)aabi[n]=a;});
  var ipbi={};
  ips.forEach(function(s){var n=normalizeIssueNumber(s.issue);if(n!==null)ipbi[n]=s;});
  ips.forEach(function(story){
    var num=normalizeIssueNumber(story.issue);
    if(num===null)return;
    if(!aabi[num]){
      result.zombies.push({type:"roadmap_zombie",severity:"high",issue:num,sprint_id:sp.id,story_title:story.title||"",message:"Issue #"+num+" esta in_progress en roadmap pero no tiene agente activo en agent-registry",action:"correct_to_planned"});
      log("ZOMBIE detectado: issue #"+num);
    }
  });
  aas.forEach(function(agent){
    var num=normalizeIssueNumber(agent.issue);
    if(num===null)return;
    if(!ipbi[num]){
      result.orphans.push({type:"roadmap_orphan",severity:"medium",issue:num,sprint_id:sp.id,session_id:agent.session_id||"",agent_status:agent.status,message:"Agente "+(agent.session_id||"?")+" activo para issue #"+num+" sin story in_progress en roadmap sprint "+sp.id,action:"investigate"});
      log("ORPHAN detectado: issue #"+num);
    }
  });
  if(opts.autoFix&&result.zombies.length>0){
    var sd=null;
    try{sd=require("./sprint-data");}catch(e){try{sd=require(path.join(SCRIPTS_DIR,"sprint-data"));}catch(e2){}}
    if(sd&&sd.updateStoryStatus&&sd.writeRoadmap){
      result.zombies.forEach(function(z){
        try{
          var fr=readJson(rmp);
          if(!fr)return;
          var ok=sd.updateStoryStatus(fr,sp.id,z.issue,"planned",null);
          if(ok){var wr=sd.writeRoadmap(fr,"roadmap-registry-check");if(wr){result.auto_corrected.push({issue:z.issue,from:"in_progress",to:"planned",reason:"zombie_no_active_agent"});log("AUTO-FIX: issue #"+z.issue+" -> planned");}}
        }catch(e){log("AUTO-FIX ERROR: "+e.message);}
      });
    }else{log("AUTO-FIX: sprint-data no disponible");}
  }
  result.ok=result.zombies.length===0&&result.orphans.length===0;
  return result;
}

if(require.main===module){
  var af=process.argv.slice(2).indexOf("--auto-fix")>=0;
  var res=runCrossValidation({autoFix:af});
  console.log(JSON.stringify(res,null,2));
  process.exit(res.ok?0:1);
}

module.exports={runCrossValidation:runCrossValidation,normalizeIssueNumber:normalizeIssueNumber,getActiveSprint:getActiveSprint,getInProgressStories:getInProgressStories,getActiveAgents:getActiveAgents};
