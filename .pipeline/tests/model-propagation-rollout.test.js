'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const yaml = require('js-yaml');
const r = require('../lib/model-propagation-rollout');
const dispatcher = require('../lib/agent-launcher/dispatch-with-fallback');
const { resolveProviderForSkill } = require('../lib/agent-launcher/resolve-provider');
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-')); fs.mkdirSync(path.join(root, 'logs'), { recursive: true }); return root; }
function seed(root, rows) { fs.writeFileSync(path.join(root, 'logs', 'spawn-exit-2026-08-20.jsonl'), rows.map(x => JSON.stringify(x)).join('\n')); }
const cfg = { baseline_min_runs: 2, evaluation_min_runs: 2, thresholds: { rebound_absolute: .1, early_death_absolute: .1 }, waves: [{ actors: ['po'] }, { actors: ['pipeline-dev'] }] };
test('los escalones sólo nombran actores que el pulpo despacha', () => {
  const config = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'config.yaml'), 'utf8'));
  const full = require('../lib/config-resolver').resolve({ pipelineDir: path.join(__dirname, '..') });
  const actores = r.dispatchableActors(full);
  assert.ok(actores.size > 0, 'la config real debe exponer skills_por_fase');
  // Regresión de la review de #6274: telegram-sherlock/doc/refinar no se
  // despachan, nunca escriben spawn-exit y trababan el rollout para siempre.
  for (const nombre of ['telegram-sherlock', 'doc', 'refinar']) assert.equal(actores.has(nombre), false);
  assert.doesNotThrow(() => r.validateWaves(config.model_propagation_rollout, actores));
  const escalones = config.model_propagation_rollout.waves.map(w => w.actors);
  assert.ok(escalones.length >= 3, 'el encendido debe ser escalonado');
  assert.deepStrictEqual(escalones[0], ['guru', 'security']);
  // El último escalón es el objetivo real del épico: los devs pesados.
  for (const dev of ['backend-dev', 'pipeline-dev', 'android-dev']) assert.ok(escalones.at(-1).includes(dev));
});
test('validateWaves rechaza actores no despachables, duplicados y listas vacías', () => {
  const actores = new Set(['guru', 'po', 'pipeline-dev']);
  assert.throws(() => r.validateWaves({ waves: [{ actors: ['telegram-sherlock'] }] }, actores), /no es un skill despachado/);
  assert.throws(() => r.validateWaves({ waves: [{ actors: ['po'] }, { actors: ['po'] }] }, actores), /repetido/);
  assert.throws(() => r.validateWaves({ waves: [] }, actores), /vacio/);
  // Fail-closed: sin lista de actores no valida a ciegas.
  assert.throws(() => r.validateWaves({ waves: [{ actors: ['po'] }] }, new Set()), /a ciegas/);
});
test('enablePair rechaza escalones inválidos antes de tocar estado', () => {
  const root = fixture(); seed(root, [1, 2].map(i => ({ ts: `2026-08-20T0${i}:00:00Z`, skill: 'po', provider: 'anthropic', exit_code: 0, duration_ms: 1 })));
  r.captureBaseline(root);
  const malo = { ...cfg, waves: [{ actors: ['telegram-sherlock'] }, { actors: ['po'] }] };
  assert.throws(() => r.enablePair(root, 'po', 'anthropic', malo, { dispatchableActors: new Set(['po']) }), /no es un skill despachado/);
  assert.equal(r.shouldPropagate(root, 'po', 'anthropic'), false);
});
test('congela baseline por actor y proveedor y excluye provider-death', () => { const root = fixture(); seed(root, [
  { ts:'2026-08-20T01:00:00Z', skill:'po', provider:'anthropic', exit_code:0, duration_ms:100 },
  { ts:'2026-08-20T02:00:00Z', skill:'po', provider:'anthropic', exit_code:1, duration_ms:100, death_kind:'provider-death' }]);
  const b = r.captureBaseline(root, { until:'2026-08-21T00:00:00Z' }); assert.equal(b['po::anthropic'].n, 2); assert.equal(b['po::anthropic'].earlyDeathRate, 0);
  assert.throws(() => r.captureBaseline(root), /congelado/); });
test('fallback con fallo del agente persiste agent-death y mueve la tasa', () => { const root = fixture();
  dispatcher.onSpawnExit({ skill:'po', provider:'anthropic', source:'fallback', rawOutput:'agent rejected task',
    exitCode:1, durationMs:1000, firstByteAt:Date.now(), spawnInstrumented:true, pipelineDir:root });
  const row=JSON.parse(fs.readFileSync(dispatcher.spawnExitAuditFile(root),'utf8').trim());
  assert.equal(row.death_kind,'agent-death'); assert.equal(r.collect(root)['po::anthropic'].earlyDeathRate,1); });
test('fallback con firma real del provider persiste provider-death y no mueve la tasa', () => { const root = fixture();
  dispatcher.onSpawnExit({ skill:'po', provider:'anthropic', source:'fallback', rawOutput:'',
    exitCode:127, durationMs:1000, firstByteAt:null, spawnInstrumented:true, pipelineDir:root });
  const row=JSON.parse(fs.readFileSync(dispatcher.spawnExitAuditFile(root),'utf8').trim());
  assert.equal(row.death_kind,'provider-death'); assert.equal(r.collect(root)['po::anthropic'].earlyDeathRate,0); });
test('sólo el fallo de agente en fallback dispara rollback', () => {
  const config={...cfg,baseline_min_runs:1,evaluation_min_runs:1};
  const prepare=()=>{ const root=fixture(); seed(root,[{ts:'2026-08-20T01:00:00Z',skill:'po',provider:'anthropic',exit_code:0,duration_ms:100}]);
    r.captureBaseline(root,{until:'2026-08-20T02:00:00Z'}); r.enablePair(root,'po','anthropic',config);
    fs.unlinkSync(path.join(root,'logs','spawn-exit-2026-08-20.jsonl')); return root; };
  const agentRoot=prepare(); dispatcher.onSpawnExit({skill:'po',provider:'anthropic',source:'fallback',rawOutput:'agent rejected task',
    exitCode:1,durationMs:1000,firstByteAt:Date.parse('2026-08-20T03:00:00Z'),spawnInstrumented:true,pipelineDir:agentRoot,now:Date.parse('2026-08-20T03:00:01Z')});
  const agentObserved=r.collect(agentRoot,{from:'2026-08-20T03:00:00Z'}); assert.equal(r.evaluatePair(agentRoot,'po','anthropic',agentObserved['po::anthropic'],config).action,'rollback');
  const providerRoot=prepare(); dispatcher.onSpawnExit({skill:'po',provider:'anthropic',source:'fallback',rawOutput:'',
    exitCode:127,durationMs:1000,firstByteAt:null,spawnInstrumented:true,pipelineDir:providerRoot,now:Date.parse('2026-08-20T03:00:01Z')});
  const providerObserved=r.collect(providerRoot,{from:'2026-08-20T03:00:00Z'}); assert.equal(r.evaluatePair(providerRoot,'po','anthropic',providerObserved['po::anthropic'],config).action,'healthy');
  assert.equal(r.shouldPropagate(providerRoot,'po','anthropic'),true);
});
test('sin baseline suficiente no enciende', () => { const root=fixture(); seed(root,[{ts:'2026-08-20T01:00:00Z',skill:'po',provider:'anthropic',exit_code:0,duration_ms:1}]); r.captureBaseline(root); assert.throws(()=>r.enablePair(root,'po','anthropic',cfg),/1 corridas/); });
test('encendido es independiente por par y respeta escalones', () => { const root=fixture(); seed(root,[1,2].flatMap(i=>[
  {ts:`2026-08-20T0${i}:00:00Z`,skill:'po',provider:'anthropic',exit_code:0,duration_ms:1},
  {ts:`2026-08-20T0${i}:10:00Z`,skill:'pipeline-dev',provider:'anthropic',exit_code:0,duration_ms:1}])); r.captureBaseline(root);
  r.enablePair(root,'po','anthropic',cfg,{actor:'leo'}); assert.equal(r.shouldPropagate(root,'po','anthropic'),true); assert.equal(r.shouldPropagate(root,'pipeline-dev','anthropic'),false); assert.throws(()=>r.enablePair(root,'pipeline-dev','anthropic',cfg),/escalon/); });
test('CA-4: un escalón sin ningún actor encendido no habilita el siguiente', () => {
  const root=fixture(); const config={...cfg,waves:[{actors:['guru','security']},{actors:['pipeline-dev']}]};
  seed(root,[1,2].flatMap(i=>['guru','security','pipeline-dev'].map(skill=>
    ({ts:`2026-08-20T0${i}:00:00Z`,skill,provider:'anthropic',exit_code:0,duration_ms:1}))));
  r.captureBaseline(root);
  // Nadie del escalón 1 encendido → sin evidencia → el escalón 2 sigue cerrado.
  r.evaluateEnabled(root,config,{from:'2026-08-20T00:00:00Z'});
  assert.equal(r.readState(root).waveEvidence['0::anthropic'],undefined);
  assert.throws(()=>r.enablePair(root,'pipeline-dev','anthropic',config),/evidencia sana del escalon 1/);
});
test('CA-4: un actor del escalón en rollback bloquea el escalón siguiente', () => {
  const root=fixture(); const config={...cfg,waves:[{actors:['guru','security']},{actors:['pipeline-dev']}]};
  seed(root,[1,2].flatMap(i=>['guru','security','pipeline-dev'].map(skill=>
    ({ts:`2026-08-20T0${i}:00:00Z`,skill,provider:'anthropic',exit_code:0,duration_ms:1}))));
  r.captureBaseline(root);
  r.enablePair(root,'guru','anthropic',config); r.enablePair(root,'security','anthropic',config);
  r.evaluatePair(root,'security','anthropic',{n:2,earlyDeathRate:1,reboundRate:0},config); // rollback de security
  r.evaluateEnabled(root,config,{from:'2026-08-20T00:00:00Z'});
  assert.equal(r.readState(root).waveEvidence['0::anthropic'],undefined);
  assert.throws(()=>r.enablePair(root,'pipeline-dev','anthropic',config),/todos los actores/);
});
test('CA-4: un solo actor sano no abre la wave si otro par sigue sin evidencia', () => {
  const root=fixture(); const config={...cfg,waves:[{actors:['guru','security']},{actors:['pipeline-dev']}]};
  seed(root,[1,2].flatMap(i=>['guru','security','pipeline-dev'].flatMap(skill=>[
    {ts:`2026-08-20T0${i}:00:00Z`,skill,provider:'anthropic',exit_code:0,duration_ms:1},
    {ts:`2026-08-20T0${i}:10:00Z`,skill,provider:'openai-codex',exit_code:0,duration_ms:1},
  ])));
  r.captureBaseline(root);
  // Sólo `guru` encendido en anthropic: `security` no aporta evidencia sana.
  r.enablePair(root,'guru','anthropic',config);
  r.evaluateEnabled(root,config,{from:'2026-08-20T00:00:00Z'});
  assert.equal(r.readState(root).waveEvidence['0::anthropic'],undefined);
  assert.throws(()=>r.enablePair(root,'pipeline-dev','anthropic',config),/todos los actores/);
  r.enablePair(root,'security','anthropic',config);
  r.evaluateEnabled(root,config,{from:'2026-08-20T00:00:00Z'});
  const evidencia=r.readState(root).waveEvidence['0::anthropic'];
  assert.deepStrictEqual(evidencia.pairs,['guru::anthropic','security::anthropic']);
  assert.deepStrictEqual(evidencia.sin_evidencia,[]);
  assert.doesNotThrow(()=>r.enablePair(root,'pipeline-dev','anthropic',config));
  assert.throws(()=>r.enablePair(root,'pipeline-dev','openai-codex',config),/openai-codex/);
});
test('rollback apaga sólo el flag y notifica una vez', () => { const root=fixture(); seed(root,[1,2].map(i=>({ts:`2026-08-20T0${i}:00:00Z`,skill:'po',provider:'anthropic',exit_code:0,duration_ms:1}))); r.captureBaseline(root); r.enablePair(root,'po','anthropic',cfg); const notices=[];
  const out=r.evaluatePair(root,'po','anthropic',{n:2,earlyDeathRate:.5,reboundRate:0},cfg,{notify:x=>notices.push(x)}); assert.equal(out.action,'rollback'); assert.equal(r.shouldPropagate(root,'po','anthropic'),false); assert.equal(notices.length,1);
  assert.equal(r.evaluatePair(root,'po','anthropic',{n:2,earlyDeathRate:.5,reboundRate:0},cfg,{notify:x=>notices.push(x)}).action,'off'); assert.equal(notices.length,1); });
test('CA-3: los defaults disparan rollback y umbrales invalidos no concluyen healthy', () => {
  const prepare=()=>{ const root=fixture(); seed(root,Array.from({length:30},(_,i)=>({ts:`2026-08-20T${String(i%24).padStart(2,'0')}:00:00Z`,skill:'po',provider:'anthropic',exit_code:0,duration_ms:1})));
    r.captureBaseline(root); r.enablePair(root,'po','anthropic',{waves:[{actors:['po']}]}); return root; };
  const degraded={n:20,earlyDeathRate:1,reboundRate:1};
  const defaultRoot=prepare(); assert.equal(r.evaluatePair(defaultRoot,'po','anthropic',degraded,{}).action,'rollback');
  const invalidRoot=prepare(); assert.deepStrictEqual(r.evaluatePair(invalidRoot,'po','anthropic',degraded,{thresholds:{early_death_absolute:.1}}),
    {action:'deferred',reason:'umbrales ausentes o no numericos'});
  assert.equal(r.shouldPropagate(invalidRoot,'po','anthropic'),true);
});
test('muestra insuficiente no dispara rollback y reencendido exige humano', () => { const root=fixture(); seed(root,[1,2].map(i=>({ts:`2026-08-20T0${i}:00:00Z`,skill:'po',provider:'anthropic',exit_code:0,duration_ms:1}))); r.captureBaseline(root); r.enablePair(root,'po','anthropic',cfg); assert.equal(r.evaluatePair(root,'po','anthropic',{n:1,earlyDeathRate:1,reboundRate:1},cfg).action,'deferred'); assert.throws(()=>r.reenablePair(root,'po','anthropic',''),/--by/); });
test('reenable rechaza pares nunca encendidos o sin auto rollback', () => {
  const root=fixture(); seed(root,[1,2].map(i=>({ts:`2026-08-20T0${i}:00:00Z`,skill:'po',provider:'anthropic',exit_code:0,duration_ms:1})));
  r.captureBaseline(root);
  assert.throws(()=>r.reenablePair(root,'po','anthropic','leo'),/no fue apagado por auto_rollback/);
  r.enablePair(root,'po','anthropic',cfg,{actor:'leo'});
  assert.throws(()=>r.reenablePair(root,'po','anthropic','leo'),/no fue apagado por auto_rollback/);
  r.evaluatePair(root,'po','anthropic',{n:2,earlyDeathRate:1,reboundRate:0},cfg);
  assert.doesNotThrow(()=>r.reenablePair(root,'po','anthropic','leo'));
});
test('el comando de spawn queda idéntico apagado, propaga encendido y omite tras rollback', () => {
  const root=fixture(); seed(root,[1,2].map(i=>({ts:`2026-08-20T0${i}:00:00Z`,skill:'po',provider:'anthropic',exit_code:0,duration_ms:1})));
  r.captureBaseline(root); const resolution={provider:'anthropic',model:'claude-sonnet-4-6'}; const original=['-p','hola'];
  assert.deepStrictEqual(r.applyToSpawn(root,'po',resolution,original,{PIPELINE_ISSUE:'1'}),{args:original,env:{PIPELINE_ISSUE:'1'},propagated:false});
  r.enablePair(root,'po','anthropic',cfg); assert.deepStrictEqual(r.applyToSpawn(root,'po',resolution,original,{}).args,[...original,'--model','claude-sonnet-4-6']);
  r.evaluatePair(root,'po','anthropic',{n:2,earlyDeathRate:1,reboundRate:0},cfg);
  assert.deepStrictEqual(r.applyToSpawn(root,'po',resolution,original,{}).args,original);
});
test('el rebote se atribuye al actor rebotado y la evaluación automática lo consume', () => {
  const root=fixture();
  seed(root,[1,2].flatMap(i=>[
    {ts:`2026-08-20T0${i}:00:00Z`,issue:77,skill:'pipeline-dev',provider:'anthropic',exit_code:0,duration_ms:1},
    {ts:`2026-08-20T0${i}:05:00Z`,issue:77,skill:'review',provider:'openai-codex',exit_code:0,duration_ms:1},
  ]));
  r.markReboundProducerLive(root,{now:'2026-08-20T00:00:00Z'});
  const config={...cfg,waves:[{actors:['pipeline-dev']}]};
  r.captureBaseline(root,{from:'2026-08-20T00:00:00Z',until:'2026-08-20T02:30:00Z'});
  r.enablePair(root,'pipeline-dev','anthropic',config);
  // El actor rebotado es el dev que vuelve a correr, NO el evaluador `review`.
  const out=r.recordRebound(root,{issue:77,skill:'pipeline-dev',ts:'2026-08-20T03:00:00Z',
    rechazado_en_fase:'aprobacion',evaluadores:['review']});
  assert.equal(out.recorded,true);
  assert.equal(out.row.skill,'pipeline-dev');
  assert.equal(out.row.provider,'anthropic'); // provider del dev, no el del review
  assert.deepStrictEqual(out.row.evaluadores,['review']);
  r.recordRebound(root,{issue:77,skill:'pipeline-dev',ts:'2026-08-20T04:00:00Z'});
  const result=r.evaluateEnabled(root,config,{from:'2026-08-20T00:00:00Z'});
  assert.equal(result['pipeline-dev::anthropic'].action,'rollback');
  assert.equal(r.shouldPropagate(root,'pipeline-dev','anthropic'),false);
  assert.equal(r.recordRebound(root,{issue:77,skill:undefined}).recorded,false);
});
test('la tasa de rebotes es null antes del productor y no dispara rollback falso', () => {
  const root=fixture();
  seed(root,[1,2].map(i=>({ts:`2026-08-20T0${i}:00:00Z`,skill:'po',provider:'anthropic',exit_code:0,duration_ms:1})));
  // Baseline histórico: el productor de rebotes todavía no existía.
  const base=r.captureBaseline(root,{from:'2026-08-20T00:00:00Z',until:'2026-08-20T02:30:00Z'});
  assert.equal(base['po::anthropic'].reboundRate,null,'null != 0: la métrica no era medible');
  r.enablePair(root,'po','anthropic',{...cfg,waves:[{actors:['po']}]});
  // Observado con rebotes al 100%: no puede rollbackear contra un baseline no medido.
  const sano=r.evaluatePair(root,'po','anthropic',{n:2,earlyDeathRate:0,reboundRate:1},cfg);
  assert.equal(sano.action,'healthy'); assert.equal(sano.reboundArmed,false);
  // Las muertes tempranas sí siguen armadas mientras tanto.
  assert.equal(r.evaluatePair(root,'po','anthropic',{n:2,earlyDeathRate:1,reboundRate:null},cfg).action,'rollback');
});
test('baseline-rebotes completa la métrica faltante sin re-medir lo congelado', () => {
  const root=fixture();
  seed(root,[1,2].map(i=>({ts:`2026-08-20T0${i}:00:00Z`,skill:'po',provider:'anthropic',exit_code:0,duration_ms:1})));
  r.captureBaseline(root,{from:'2026-08-20T00:00:00Z',until:'2026-08-20T02:30:00Z'});
  assert.throws(()=>r.captureReboundBaseline(root,cfg,{from:'2026-08-21T00:00:00Z'}),/todavia no arranco/);
  r.markReboundProducerLive(root,{now:'2026-08-21T00:00:00Z'});
  assert.throws(()=>r.captureReboundBaseline(root,cfg,{from:'2026-08-20T00:00:00Z'}),/en o despues de/);
  fs.writeFileSync(path.join(root,'logs','spawn-exit-2026-08-21.jsonl'),[1,2].map(i=>
    JSON.stringify({ts:`2026-08-21T0${i}:00:00Z`,issue:9,skill:'po',provider:'anthropic',exit_code:0,duration_ms:1})).join('\n'));
  r.recordRebound(root,{issue:9,skill:'po',ts:'2026-08-21T02:30:00Z'});
  const out=r.captureReboundBaseline(root,cfg,{from:'2026-08-21T00:00:00Z',until:'2026-08-21T23:00:00Z'});
  assert.equal(out.medidos['po::anthropic'],0.5);
  const base=r.readState(root).baselines['po::anthropic'];
  assert.equal(base.reboundRate,0.5); assert.equal(base.n,2,'la muestra original no se re-mide');
  assert.equal(base.reboundWindow.from,'2026-08-21T00:00:00Z');
  // Idempotente: un segundo llamado no pisa lo ya medido.
  assert.throws(()=>r.captureReboundBaseline(root,cfg,{from:'2026-08-21T00:00:00Z'}),/ningun par quedo medible/);
  // Con ambos lados medidos, la comparación de rebotes queda armada.
  assert.equal(r.evaluatePair(root,'po','anthropic',{n:2,earlyDeathRate:0,reboundRate:0},cfg).action,'off');
});
test('el resolver real propaga el model_override de los actores primarios', () => {
  const pipelineDir=path.join(__dirname,'..');
  for (const [actor, expectedModel] of [['telegram-sherlock','claude-haiku-4-5'],['po','claude-sonnet-4-6']]) {
    const resolution=resolveProviderForSkill(actor,{pipelineDir});
    assert.equal(resolution.provider,'anthropic'); assert.equal(resolution.model,expectedModel);
    const root=fixture(); seed(root,[1,2].map(i=>({ts:`2026-08-20T0${i}:00:00Z`,skill:actor,provider:'anthropic',exit_code:0,duration_ms:1})));
    r.captureBaseline(root); r.enablePair(root,actor,'anthropic',{...cfg,waves:[{actors:[actor]}]});
    assert.deepStrictEqual(r.applyToSpawn(root,actor,resolution,['-p','hola'],{}).args,['-p','hola','--model',expectedModel]);
  }
});
