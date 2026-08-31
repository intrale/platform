'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const yaml = require('js-yaml');
const r = require('../lib/model-propagation-rollout');
const dispatcher = require('../lib/agent-launcher/dispatch-with-fallback');
const { resolveProviderForSkill } = require('../lib/agent-launcher/resolve-provider');
const modelPropagation = require('../lib/model-propagation');
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
  assert.deepStrictEqual(r.applyToSpawn(root,'po',resolution,original,{PIPELINE_ISSUE:'1'}),{args:original,env:{PIPELINE_ISSUE:'1'},propagated:false,plan:null});
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

// --- Campos ausentes: no medibles (regresion de la review de #6274) --------
// `Number(null)` es 0, asi que antes una fila sin codigo de salida se contaba
// como EXITO y una sin duracion entraba como 0 ms. Ambos campos faltan
// exactamente cuando el proceso murio mal, o sea que el sesgo era optimista
// justo donde importa. La regla es descartar, nunca interpretar.
test('exit_code null no cuenta como exito y queda fuera de N', () => {
  const filas = [
    { ts:'2026-08-20T01:00:00Z', skill:'po', provider:'anthropic', exit_code:0, duration_ms:100000 },
    { ts:'2026-08-20T02:00:00Z', skill:'po', provider:'anthropic', exit_code:null, duration_ms:1811016 },
  ];
  const m = r.rates(filas);
  assert.equal(m.nRaw, 2, 'se vieron dos filas');
  assert.equal(m.n, 1, 'solo una es medible: la de exit_code null sale de N');
  assert.equal(m.nUnmeasurable, 1, 'el descarte queda consultable');
  // Con la coercion vieja esto daba 1 (100%): la fila null se sumaba como exito.
  assert.equal(m.successRate, 1, 'la unica fila medible fue exitosa');
  assert.equal(r.isMeasurable(filas[1]), false);
  // Una ventana entera de filas sin codigo de salida no es 100% de exito: no es
  // medible en absoluto.
  const soloNulas = r.rates([filas[1], { ...filas[1] }]);
  assert.equal(soloNulas.n, 0);
  assert.equal(soloNulas.successRate, 0, 'sin muestra medible no se inventa exito');
  assert.equal(soloNulas.earlyDeathRate, 0);
});
test('duration_ms null no entra como 0 ms ni marca muerte temprana falsa', () => {
  const filas = [
    { ts:'2026-08-20T01:00:00Z', skill:'po', provider:'anthropic', exit_code:0, duration_ms:100000 },
    { ts:'2026-08-20T02:00:00Z', skill:'po', provider:'anthropic', exit_code:1, duration_ms:null },
  ];
  const m = r.rates(filas);
  assert.equal(m.n, 1);
  assert.equal(m.nUnmeasurable, 1);
  // Con la coercion vieja: Number(null)=0 pasaba Number.isFinite, entraba como
  // 0 ms al percentil y como 0 < 15000 marcaba muerte temprana. Esa es la
  // metrica que dispara el rollback, asi que el falso positivo era caro.
  assert.equal(m.earlyDeathRate, 0, 'una duracion ausente no es una muerte temprana');
  assert.equal(m.durationP50Ms, 100000, 'el percentil no se hunde con un 0 fantasma');
  assert.equal(m.durationP95Ms, 100000);
  assert.equal(r.isMeasurable(filas[1]), false);
});
test('campos ausentes, negativos o no numericos nunca son medibles', () => {
  const base = { ts:'2026-08-20T01:00:00Z', skill:'po', provider:'anthropic', exit_code:0, duration_ms:10 };
  assert.equal(r.isMeasurable(base), true);
  for (const roto of [
    { ...base, exit_code: null }, { ...base, exit_code: undefined },
    { ...base, exit_code: '0' }, { ...base, exit_code: NaN },
    { ...base, duration_ms: null }, { ...base, duration_ms: undefined },
    { ...base, duration_ms: '10' }, { ...base, duration_ms: NaN },
    { ...base, duration_ms: -1 },
  ]) assert.equal(r.isMeasurable(roto), false, `deberia ser no medible: ${JSON.stringify(roto)}`);
  // Sin exit_code ni duration_ms la fila tampoco entra por descarte.
  const { exit_code, duration_ms, ...sinCampos } = base;
  assert.equal(r.isMeasurable(sinCampos), false);
});
test('filas no medibles no completan el minimo de baseline (fail-closed)', () => {
  const root = fixture();
  seed(root, [
    { ts:'2026-08-20T01:00:00Z', skill:'po', provider:'anthropic', exit_code:0, duration_ms:100 },
    { ts:'2026-08-20T02:00:00Z', skill:'po', provider:'anthropic', exit_code:null, duration_ms:100 },
  ]);
  const base = r.captureBaseline(root, { until:'2026-08-21T00:00:00Z' })['po::anthropic'];
  assert.equal(base.n, 1, 'la fila no medible no engrosa la muestra congelada');
  assert.equal(base.nUnmeasurable, 1);
  // cfg exige 2 corridas: con una sola medible el encendido sigue trabado.
  assert.throws(() => r.enablePair(root, 'po', 'anthropic', cfg), /baseline con 1 corridas/);
  assert.equal(r.shouldPropagate(root, 'po', 'anthropic'), false);
});
test('filas no medibles no completan el minimo de evaluacion', () => {
  const root = fixture();
  seed(root, [1,2].map(i => ({ ts:`2026-08-20T0${i}:00:00Z`, skill:'po', provider:'anthropic', exit_code:0, duration_ms:100 })));
  r.captureBaseline(root, { until:'2026-08-20T03:00:00Z' });
  r.enablePair(root, 'po', 'anthropic', cfg);
  // Ventana de evaluacion: una corrida medible sana + una basura. cfg pide 2.
  const observado = r.rates([
    { exit_code:1, duration_ms:10 },
    { exit_code:null, duration_ms:null },
  ]);
  assert.equal(observado.n, 1);
  const out = r.evaluatePair(root, 'po', 'anthropic', observado, cfg);
  assert.equal(out.action, 'deferred', 'ruido no habilita un veredicto');
  assert.match(out.reason, /muestra 1\/2/);
  assert.equal(r.shouldPropagate(root, 'po', 'anthropic'), true, 'no se apaga por ruido');
});
test('regresion: la fila real de produccion con exit_code null no infla el baseline', () => {
  // Forma textual de una fila real de `spawn-exit-*.jsonl` (2357 filas, 33 asi).
  const real = { ts:'2026-08-19T13:18:06.918Z', skill:'po', provider:'anthropic',
    error_class:'transient_5xx', should_fallback:true, retriable:true,
    exit_code:null, timed_out:false, duration_ms:1811016 };
  const exitosa = { ts:'2026-08-19T14:00:00.000Z', skill:'po', provider:'anthropic', exit_code:0, duration_ms:5000 };
  const fallida = { ts:'2026-08-19T15:00:00.000Z', skill:'po', provider:'anthropic', exit_code:1, duration_ms:5000 };
  const m = r.rates([real, exitosa, fallida]);
  assert.equal(m.nRaw, 3);
  assert.equal(m.n, 2, 'la fila de fallo sin codigo de salida no es muestra');
  // Antes: 2/3 = 0.666 (el fallo contaba como exito). Ahora: 1/2 = 0.5.
  assert.equal(m.successRate, 0.5);
  assert.notEqual(m.successRate, 2/3);
});
// Metacaracteres de cmd.exe que jamas deben viajar crudos ni al argv ni al log.
const RE_METACARACTERES=new RegExp('["&|<>^$' + String.fromCharCode(96) + ']');

// --- Bloqueante 1 de la review de #6274 -----------------------------------
// El rollout empujaba `--model` con `String(model)` sin pasar por la whitelist
// de `sanitizeModelId`, o sea que anulaba el control SR-A.1 justo en el argv
// que ese control existe para proteger (`detectLauncher` puede devolver
// shell:true en los tiers cmd-shim / path-fallback, y ahi un metacaracter
// escala a cmd.exe). Ahora la decision la toma `modelPropagation.plan()`.
test('un id de modelo con metacaracteres NO llega al argv: lo corta la whitelist', () => {
  const root=fixture(); seed(root,[1,2].map(i=>({ts:`2026-08-20T0${i}:00:00Z`,skill:'po',provider:'anthropic',exit_code:0,duration_ms:1})));
  r.captureBaseline(root); r.enablePair(root,'po','anthropic',cfg);
  const original=['-p','x'];
  const out=r.applyToSpawn(root,'po',{provider:'anthropic',model:'claude-3 " && echo PWNED'},original,{});
  assert.deepStrictEqual(out.args,original,'el argv queda byte-identico: no se propaga nada');
  assert.equal(out.propagated,false);
  assert.equal(out.plan.rejectedReason,'failed_whitelist','la razon es TIPADA, no un silencio');
  assert.match(out.plan.trace,/RECHAZADO por whitelist/);
  // El id rechazado se imprime NEUTRALIZADO (safeForLog): ningun metacaracter
  // de cmd.exe sobrevive a la traza que va al log / Telegram / PDF.
  assert.match(out.plan.trace,/claude-3/,'el operador igual reconoce el id');
  assert.equal(RE_METACARACTERES.test(out.plan.trace),false,'la traza no reproduce metacaracteres crudos');
  // Misma respuesta que la frontera designada: una sola fuente de verdad.
  assert.equal(modelPropagation.sanitizeModelId('claude-3 " && echo PWNED').model,null);
});

// --- Bloqueante 2 de la review de #6274 -----------------------------------
// `kimi-moonshot` corre sobre el launcher `claude` y recibe el modelo por
// `--model` (esta en ARG_MODEL_PROVIDERS), pero el rollout solo contemplaba
// `provider === 'anthropic'` y lo devolvia como `propagated:false` mudo con el
// par en `enabled:true`. Al delegar en `resolveTarget`, el canal sale del mismo
// catalogo que usa el launcher.
test('kimi-moonshot propaga por --model igual que anthropic (no es un no-op mudo)', () => {
  const root=fixture(); seed(root,[1,2].map(i=>({ts:`2026-08-20T0${i}:00:00Z`,skill:'guru',provider:'kimi-moonshot',exit_code:0,duration_ms:1})));
  r.captureBaseline(root);
  const config={...cfg,waves:[{actors:['guru']}]};
  r.enablePair(root,'guru','kimi-moonshot',config);
  assert.equal(r.shouldPropagate(root,'guru','kimi-moonshot'),true);
  const out=r.applyToSpawn(root,'guru',{provider:'kimi-moonshot',model:'kimi-k2-6'},['-p','hola'],{});
  assert.deepStrictEqual(out.args,['-p','hola','--model','kimi-k2-6']);
  assert.equal(out.propagated,true);
});

// Los providers que reciben el modelo por env salen de PROVIDER_MODEL_ENV
// (lib/build-child-env.js), no de una copia local: la tabla duplicada que
// tenia el rollout ya no existe.
test('el canal env sale de PROVIDER_MODEL_ENV, sin tabla duplicada en el rollout', () => {
  const root=fixture(); seed(root,[1,2].map(i=>({ts:`2026-08-20T0${i}:00:00Z`,skill:'guru',provider:'openai-codex',exit_code:0,duration_ms:1})));
  r.captureBaseline(root);
  r.enablePair(root,'guru','openai-codex',{...cfg,waves:[{actors:['guru']}]});
  const out=r.applyToSpawn(root,'guru',{provider:'openai-codex',model:'gpt-5-codex'},['-p','hola'],{});
  assert.deepStrictEqual(out.args,['-p','hola'],'el canal env no toca argv');
  assert.equal(out.env[modelPropagation.PROVIDER_MODEL_ENV['openai-codex']],'gpt-5-codex');
  assert.equal(out.propagated,true);
  assert.equal(Object.keys(r).includes('MODEL_ENV_BY_PROVIDER'),false,'la tabla duplicada no vuelve');
});

// Un provider sin canal de modelo declarado no puede quedar `enabled:true`:
// seria un par activo que nunca propaga, consume evidencia de escalon y puede
// comerse un auto_rollback con notificacion por una degradacion que su modelo
// jamas causo.
test('encender un provider sin canal de modelo es error explicito, no un no-op', () => {
  const root=fixture(); seed(root,[1,2].map(i=>({ts:`2026-08-20T0${i}:00:00Z`,skill:'guru',provider:'deterministic',exit_code:0,duration_ms:1})));
  r.captureBaseline(root);
  assert.throws(()=>r.enablePair(root,'guru','deterministic',{...cfg,waves:[{actors:['guru']}]}),
    /no declara canal de modelo/);
  assert.equal(r.shouldPropagate(root,'guru','deterministic'),false,'no queda estado a medias');
});

// El flag por par es PRECONDICION de `plan()`, no un canal paralelo: encendido
// en los dos lugares a la vez, `--model` aparece UNA sola vez.
test('el par encendido y model_propagation encendido aplican una sola vez', () => {
  const config={pipeline:{model_propagation:{enabled:true,default_mode:'on'}}};
  const conRollout=modelPropagation.plan({provider:'anthropic',skill:'po',model:'claude-sonnet-4-6',config,rolloutEnabled:true});
  const sinRollout=modelPropagation.plan({provider:'anthropic',skill:'po',model:'claude-sonnet-4-6',config,rolloutEnabled:false});
  assert.equal(conRollout.apply,true); assert.equal(sinRollout.apply,true);
  assert.equal(conRollout.modeSource,'rollout-pair');
  assert.equal(conRollout.model,sinRollout.model,'una sola decision, un solo --model');
  // Y con el interruptor grueso apagado (default vigente) el par igual enciende.
  const soloRollout=modelPropagation.plan({provider:'anthropic',skill:'po',model:'claude-sonnet-4-6',config:{},rolloutEnabled:true});
  assert.equal(soloRollout.apply,true); assert.equal(soloRollout.target,'arg');
  // `rolloutEnabled` truthy-pero-no-booleano NO enciende (fail-closed).
  assert.equal(modelPropagation.plan({provider:'anthropic',skill:'po',model:'claude-sonnet-4-6',config:{},rolloutEnabled:'si'}).apply,false);
});
