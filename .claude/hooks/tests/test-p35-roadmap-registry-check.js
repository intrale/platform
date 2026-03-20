// test-p35-roadmap-registry-check.js
// Tests para roadmap-registry-check.js (#1660)
var test=require("node:test");
var assert=require("node:assert");
var fs=require("fs");
var path=require("path");
var os=require("os");

var MOD_PATH=path.resolve(__dirname,"..","roadmap-registry-check.js");
var mod=require(MOD_PATH);

function makeTempFiles(rm,reg){
  var d=fs.mkdtempSync(path.join(os.tmpdir(),"rrc-test-"));
  fs.writeFileSync(path.join(d,"roadmap.json"),JSON.stringify(rm));
  fs.writeFileSync(path.join(d,"agent-registry.json"),JSON.stringify(reg));
  return d;
}

function mkRm(stories,sprintStatus){
  sprintStatus=sprintStatus||"active";
  return {sprints:[{id:"SPR-TEST",status:sprintStatus,stories:stories||[]}]};
}

function mkReg(agents){
  var obj={};
  (agents||[]).forEach(function(a){obj[a.session_id]=a;});
  return {agents:obj};
}

test.describe("P-35.1: Estructura del modulo",function(){
  test.it("el archivo existe",function(){
    assert.ok(fs.existsSync(MOD_PATH),"No existe "+MOD_PATH);
  });
  test.it("exporta runCrossValidation",function(){
    assert.strictEqual(typeof mod.runCrossValidation,"function");
  });
  test.it("exporta normalizeIssueNumber",function(){
    assert.strictEqual(typeof mod.normalizeIssueNumber,"function");
  });
  test.it("exporta getActiveSprint",function(){
    assert.strictEqual(typeof mod.getActiveSprint,"function");
  });
  test.it("exporta getInProgressStories",function(){
    assert.strictEqual(typeof mod.getInProgressStories,"function");
  });
  test.it("exporta getActiveAgents",function(){
    assert.strictEqual(typeof mod.getActiveAgents,"function");
  });
});

test.describe("P-35.2: normalizeIssueNumber",function(){
  test.it("parsea string con hash",function(){
    assert.strictEqual(mod.normalizeIssueNumber("#1234"),1234);
  });
  test.it("parsea numero entero",function(){
    assert.strictEqual(mod.normalizeIssueNumber(1234),1234);
  });
  test.it("parsea string sin hash",function(){
    assert.strictEqual(mod.normalizeIssueNumber("1234"),1234);
  });
  test.it("retorna null para null",function(){
    assert.strictEqual(mod.normalizeIssueNumber(null),null);
  });
  test.it("retorna null para no numerico",function(){
    assert.strictEqual(mod.normalizeIssueNumber("abc"),null);
  });
});

test.describe("P-35.3: getActiveSprint",function(){
  test.it("retorna sprint activo",function(){
    var rm={sprints:[{id:"SPR-A",status:"done"},{id:"SPR-B",status:"active"}]};
    var s=mod.getActiveSprint(rm);
    assert.strictEqual(s.id,"SPR-B");
  });
  test.it("retorna null si no hay sprint activo",function(){
    var rm={sprints:[{id:"SPR-A",status:"done"}]};
    assert.strictEqual(mod.getActiveSprint(rm),null);
  });
  test.it("retorna null para roadmap null",function(){
    assert.strictEqual(mod.getActiveSprint(null),null);
  });
});

test.describe("P-35.4: getInProgressStories",function(){
  test.it("filtra solo in_progress",function(){
    var sp={stories:[
      {issue:1,status:"in_progress"},
      {issue:2,status:"planned"},
      {issue:3,status:"in_progress"}
    ]};
    var res=mod.getInProgressStories(sp);
    assert.strictEqual(res.length,2);
    assert.strictEqual(res[0].issue,1);
    assert.strictEqual(res[1].issue,3);
  });
  test.it("retorna array vacio si no hay in_progress",function(){
    var sp={stories:[{issue:1,status:"planned"}]};
    assert.strictEqual(mod.getInProgressStories(sp).length,0);
  });
  test.it("retorna array vacio para sprint null",function(){
    assert.strictEqual(mod.getInProgressStories(null).length,0);
  });
});

test.describe("P-35.5: getActiveAgents",function(){
  test.it("filtra solo active",function(){
    var reg=mkReg([
      {session_id:"s1",issue:"#10",status:"active"},
      {session_id:"s2",issue:"#11",status:"zombie"},
      {session_id:"s3",issue:"#12",status:"idle"}
    ]);
    var res=mod.getActiveAgents(reg);
    assert.strictEqual(res.length,1);
    assert.strictEqual(res[0].session_id,"s1");
  });
  test.it("retorna array vacio para registry null",function(){
    assert.strictEqual(mod.getActiveAgents(null).length,0);
  });
  test.it("retorna array vacio si agents no es objeto",function(){
    assert.strictEqual(mod.getActiveAgents({agents:[]}).length,0);
  });
});

test.describe("P-35.6: runCrossValidation sin sprint activo",function(){
  test.it("ok true y listas vacias si no hay sprint activo",function(){
    var rm=mkRm([],"done");
    var reg=mkReg([]);
    var d=makeTempFiles(rm,reg);
    var r=mod.runCrossValidation({roadmapPath:path.join(d,"roadmap.json"),registryPath:path.join(d,"agent-registry.json")});
    assert.strictEqual(r.ok,true);
    assert.strictEqual(r.zombies.length,0);
    assert.strictEqual(r.orphans.length,0);
    fs.rmSync(d,{recursive:true,force:true});
  });
});

test.describe("P-35.7: runCrossValidation deteccion zombies",function(){
  test.it("detecta 1 zombie cuando story in_progress sin agente activo",function(){
    var rm=mkRm([{issue:1234,title:"T",status:"in_progress"}]);
    var reg=mkReg([]);
    var d=makeTempFiles(rm,reg);
    var r=mod.runCrossValidation({roadmapPath:path.join(d,"roadmap.json"),registryPath:path.join(d,"agent-registry.json")});
    assert.strictEqual(r.zombies.length,1);
    assert.strictEqual(r.zombies[0].issue,1234);
    assert.strictEqual(r.zombies[0].type,"roadmap_zombie");
    assert.strictEqual(r.zombies[0].severity,"high");
    assert.ok(r.zombies[0].action==="correct_to_planned");
    assert.strictEqual(r.ok,false);
    fs.rmSync(d,{recursive:true,force:true});
  });
  test.it("no detecta zombie si agente activo para el issue",function(){
    var rm=mkRm([{issue:1234,title:"T",status:"in_progress"}]);
    var reg=mkReg([{session_id:"s1",issue:"#1234",status:"active"}]);
    var d=makeTempFiles(rm,reg);
    var r=mod.runCrossValidation({roadmapPath:path.join(d,"roadmap.json"),registryPath:path.join(d,"agent-registry.json")});
    assert.strictEqual(r.zombies.length,0);
    fs.rmSync(d,{recursive:true,force:true});
  });
  test.it("normaliza numero en registry con hash prefix",function(){
    var rm=mkRm([{issue:42,title:"T",status:"in_progress"}]);
    var reg=mkReg([{session_id:"s1",issue:"#42",status:"active"}]);
    var d=makeTempFiles(rm,reg);
    var r=mod.runCrossValidation({roadmapPath:path.join(d,"roadmap.json"),registryPath:path.join(d,"agent-registry.json")});
    assert.strictEqual(r.zombies.length,0);
    fs.rmSync(d,{recursive:true,force:true});
  });
  test.it("detecta multiples zombies",function(){
    var rm=mkRm([
      {issue:10,title:"A",status:"in_progress"},
      {issue:11,title:"B",status:"in_progress"},
      {issue:12,title:"C",status:"planned"}
    ]);
    var reg=mkReg([{session_id:"s1",issue:"#11",status:"active"}]);
    var d=makeTempFiles(rm,reg);
    var r=mod.runCrossValidation({roadmapPath:path.join(d,"roadmap.json"),registryPath:path.join(d,"agent-registry.json")});
    assert.strictEqual(r.zombies.length,1);
    assert.strictEqual(r.zombies[0].issue,10);
    fs.rmSync(d,{recursive:true,force:true});
  });
});

test.describe("P-35.8: runCrossValidation deteccion orphans",function(){
  test.it("detecta 1 orphan cuando agente activo sin story in_progress",function(){
    var rm=mkRm([{issue:99,title:"T",status:"planned"}]);
    var reg=mkReg([{session_id:"s1",issue:"#99",status:"active"}]);
    var d=makeTempFiles(rm,reg);
    var r=mod.runCrossValidation({roadmapPath:path.join(d,"roadmap.json"),registryPath:path.join(d,"agent-registry.json")});
    assert.strictEqual(r.orphans.length,1);
    assert.strictEqual(r.orphans[0].issue,99);
    assert.strictEqual(r.orphans[0].type,"roadmap_orphan");
    assert.strictEqual(r.orphans[0].severity,"medium");
    assert.strictEqual(r.ok,false);
    fs.rmSync(d,{recursive:true,force:true});
  });
  test.it("no detecta orphan si story in_progress en roadmap",function(){
    var rm=mkRm([{issue:55,title:"T",status:"in_progress"}]);
    var reg=mkReg([{session_id:"s1",issue:"#55",status:"active"}]);
    var d=makeTempFiles(rm,reg);
    var r=mod.runCrossValidation({roadmapPath:path.join(d,"roadmap.json"),registryPath:path.join(d,"agent-registry.json")});
    assert.strictEqual(r.orphans.length,0);
    fs.rmSync(d,{recursive:true,force:true});
  });
  test.it("ignora agentes zombie e idle",function(){
    var rm=mkRm([]);
    var reg=mkReg([
      {session_id:"s1",issue:"#77",status:"zombie"},
      {session_id:"s2",issue:"#78",status:"idle"}
    ]);
    var d=makeTempFiles(rm,reg);
    var r=mod.runCrossValidation({roadmapPath:path.join(d,"roadmap.json"),registryPath:path.join(d,"agent-registry.json")});
    assert.strictEqual(r.orphans.length,0);
    fs.rmSync(d,{recursive:true,force:true});
  });
});

test.describe("P-35.9: runCrossValidation manejo de errores",function(){
  test.it("retorna ok false si roadmap no existe",function(){
    var d=fs.mkdtempSync(path.join(os.tmpdir(),"rrc-err-"));
    var r=mod.runCrossValidation({roadmapPath:path.join(d,"noexiste.json"),registryPath:path.join(d,"reg.json")});
    assert.strictEqual(r.ok,false);
    assert.ok(r.error);
    fs.rmSync(d,{recursive:true,force:true});
  });
  test.it("funciona aunque registry no exista",function(){
    var rm=mkRm([{issue:1,title:"T",status:"in_progress"}]);
    var d=fs.mkdtempSync(path.join(os.tmpdir(),"rrc-noreg-"));
    fs.writeFileSync(path.join(d,"roadmap.json"),JSON.stringify(rm));
    var r=mod.runCrossValidation({roadmapPath:path.join(d,"roadmap.json"),registryPath:path.join(d,"noexiste.json")});
    assert.strictEqual(r.zombies.length,1);
    fs.rmSync(d,{recursive:true,force:true});
  });
});

test.describe("P-35.10: runCrossValidation sprint_id",function(){
  test.it("incluye sprint_id del sprint activo",function(){
    var rm=mkRm([]);
    var reg=mkReg([]);
    var d=makeTempFiles(rm,reg);
    var r=mod.runCrossValidation({roadmapPath:path.join(d,"roadmap.json"),registryPath:path.join(d,"agent-registry.json")});
    assert.strictEqual(r.sprint_id,"SPR-TEST");
    fs.rmSync(d,{recursive:true,force:true});
  });
});

test.describe("P-35.11: runCrossValidation resultado clean",function(){
  test.it("ok true cuando no hay zombies ni orphans",function(){
    var rm=mkRm([{issue:100,title:"T",status:"in_progress"}]);
    var reg=mkReg([{session_id:"s1",issue:"#100",status:"active"}]);
    var d=makeTempFiles(rm,reg);
    var r=mod.runCrossValidation({roadmapPath:path.join(d,"roadmap.json"),registryPath:path.join(d,"agent-registry.json")});
    assert.strictEqual(r.ok,true);
    assert.strictEqual(r.zombies.length,0);
    assert.strictEqual(r.orphans.length,0);
    fs.rmSync(d,{recursive:true,force:true});
  });
  test.it("incluye timestamp en el resultado",function(){
    var rm=mkRm([]);
    var reg=mkReg([]);
    var d=makeTempFiles(rm,reg);
    var r=mod.runCrossValidation({roadmapPath:path.join(d,"roadmap.json"),registryPath:path.join(d,"agent-registry.json")});
    assert.ok(r.timestamp);
    assert.ok(typeof r.timestamp==="string");
    fs.rmSync(d,{recursive:true,force:true});
  });
  test.it("auto_corrected es array vacio sin autoFix",function(){
    var rm=mkRm([{issue:200,title:"T",status:"in_progress"}]);
    var reg=mkReg([]);
    var d=makeTempFiles(rm,reg);
    var r=mod.runCrossValidation({roadmapPath:path.join(d,"roadmap.json"),registryPath:path.join(d,"agent-registry.json")});
    assert.ok(Array.isArray(r.auto_corrected));
    assert.strictEqual(r.auto_corrected.length,0);
    fs.rmSync(d,{recursive:true,force:true});
  });
});