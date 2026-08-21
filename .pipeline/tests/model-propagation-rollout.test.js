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
test('configura los escalones en el orden obligatorio de CA-4', () => {
  const config = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'config.yaml'), 'utf8'));
  assert.deepStrictEqual(config.model_propagation_rollout.waves.map(wave => wave.actors), [
    ['telegram-sherlock'],
    ['doc', 'refinar', 'po'],
    ['backend-dev', 'pipeline-dev', 'android-dev'],
  ]);
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
  r.enablePair(root,'po','anthropic',cfg,{actor:'leo'}); assert.equal(r.shouldPropagate(root,'po','anthropic'),true); assert.equal(r.shouldPropagate(root,'pipeline-dev','anthropic'),false); assert.throws(()=>r.enablePair(root,'pipeline-dev','anthropic',cfg),/escalón/); });
test('rollback apaga sólo el flag y notifica una vez', () => { const root=fixture(); seed(root,[1,2].map(i=>({ts:`2026-08-20T0${i}:00:00Z`,skill:'po',provider:'anthropic',exit_code:0,duration_ms:1}))); r.captureBaseline(root); r.enablePair(root,'po','anthropic',cfg); const notices=[];
  const out=r.evaluatePair(root,'po','anthropic',{n:2,earlyDeathRate:.5,reboundRate:0},cfg,{notify:x=>notices.push(x)}); assert.equal(out.action,'rollback'); assert.equal(r.shouldPropagate(root,'po','anthropic'),false); assert.equal(notices.length,1);
  assert.equal(r.evaluatePair(root,'po','anthropic',{n:2,earlyDeathRate:.5,reboundRate:0},cfg,{notify:x=>notices.push(x)}).action,'off'); assert.equal(notices.length,1); });
test('muestra insuficiente no dispara rollback y reencendido exige humano', () => { const root=fixture(); seed(root,[1,2].map(i=>({ts:`2026-08-20T0${i}:00:00Z`,skill:'po',provider:'anthropic',exit_code:0,duration_ms:1}))); r.captureBaseline(root); r.enablePair(root,'po','anthropic',cfg); assert.equal(r.evaluatePair(root,'po','anthropic',{n:1,earlyDeathRate:1,reboundRate:1},cfg).action,'deferred'); assert.throws(()=>r.reenablePair(root,'po','anthropic',''),/--by/); });
test('el comando de spawn queda idéntico apagado, propaga encendido y omite tras rollback', () => {
  const root=fixture(); seed(root,[1,2].map(i=>({ts:`2026-08-20T0${i}:00:00Z`,skill:'po',provider:'anthropic',exit_code:0,duration_ms:1})));
  r.captureBaseline(root); const resolution={provider:'anthropic',model:'claude-sonnet-4-6'}; const original=['-p','hola'];
  assert.deepStrictEqual(r.applyToSpawn(root,'po',resolution,original,{PIPELINE_ISSUE:'1'}),{args:original,env:{PIPELINE_ISSUE:'1'},propagated:false});
  r.enablePair(root,'po','anthropic',cfg); assert.deepStrictEqual(r.applyToSpawn(root,'po',resolution,original,{}).args,[...original,'--model','claude-sonnet-4-6']);
  r.evaluatePair(root,'po','anthropic',{n:2,earlyDeathRate:1,reboundRate:0},cfg);
  assert.deepStrictEqual(r.applyToSpawn(root,'po',resolution,original,{}).args,original);
});
test('produce rebote asociado al provider real y la evaluación automática lo consume', () => {
  const root=fixture(); seed(root,[1,2].map(i=>({ts:`2026-08-20T0${i}:00:00Z`,issue:77,skill:'po',provider:'anthropic',exit_code:0,duration_ms:1})));
  r.captureBaseline(root); r.enablePair(root,'po','anthropic',cfg);
  assert.equal(r.recordRebound(root,{issue:77,skill:'po',ts:'2026-08-20T03:00:00Z'}).recorded,true);
  assert.equal(r.recordRebound(root,{issue:77,skill:'po',ts:'2026-08-20T04:00:00Z'}).recorded,true);
  const result=r.evaluateEnabled(root,cfg,{from:'2026-08-20T00:00:00Z'});
  assert.equal(result['po::anthropic'].action,'rollback'); assert.equal(r.shouldPropagate(root,'po','anthropic'),false);
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
