'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const r = require('../lib/model-propagation-rollout');
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-')); fs.mkdirSync(path.join(root, 'logs'), { recursive: true }); return root; }
function seed(root, rows) { fs.writeFileSync(path.join(root, 'logs', 'spawn-exit-2026-08-20.jsonl'), rows.map(x => JSON.stringify(x)).join('\n')); }
const cfg = { baseline_min_runs: 2, evaluation_min_runs: 2, thresholds: { rebound_absolute: .1, early_death_absolute: .1 }, waves: [{ actors: ['po'] }, { actors: ['pipeline-dev'] }] };
test('congela baseline por actor y proveedor y excluye provider-death', () => { const root = fixture(); seed(root, [
  { ts:'2026-08-20T01:00:00Z', skill:'po', provider:'anthropic', exit_code:0, duration_ms:100 },
  { ts:'2026-08-20T02:00:00Z', skill:'po', provider:'anthropic', exit_code:1, duration_ms:100, death_kind:'provider-death' }]);
  const b = r.captureBaseline(root, { until:'2026-08-21T00:00:00Z' }); assert.equal(b['po::anthropic'].n, 2); assert.equal(b['po::anthropic'].earlyDeathRate, 0);
  assert.throws(() => r.captureBaseline(root), /congelado/); });
test('sin baseline suficiente no enciende', () => { const root=fixture(); seed(root,[{ts:'2026-08-20T01:00:00Z',skill:'po',provider:'anthropic',exit_code:0,duration_ms:1}]); r.captureBaseline(root); assert.throws(()=>r.enablePair(root,'po','anthropic',cfg),/1 corridas/); });
test('encendido es independiente por par y respeta escalones', () => { const root=fixture(); seed(root,[1,2].flatMap(i=>[
  {ts:`2026-08-20T0${i}:00:00Z`,skill:'po',provider:'anthropic',exit_code:0,duration_ms:1},
  {ts:`2026-08-20T0${i}:10:00Z`,skill:'pipeline-dev',provider:'anthropic',exit_code:0,duration_ms:1}])); r.captureBaseline(root);
  r.enablePair(root,'po','anthropic',cfg,{actor:'leo'}); assert.equal(r.shouldPropagate(root,'po','anthropic'),true); assert.equal(r.shouldPropagate(root,'pipeline-dev','anthropic'),false); assert.throws(()=>r.enablePair(root,'pipeline-dev','anthropic',cfg),/escalón/); });
test('rollback apaga sólo el flag y notifica una vez', () => { const root=fixture(); seed(root,[1,2].map(i=>({ts:`2026-08-20T0${i}:00:00Z`,skill:'po',provider:'anthropic',exit_code:0,duration_ms:1}))); r.captureBaseline(root); r.enablePair(root,'po','anthropic',cfg); const notices=[];
  const out=r.evaluatePair(root,'po','anthropic',{n:2,earlyDeathRate:.5,reboundRate:0},cfg,{notify:x=>notices.push(x)}); assert.equal(out.action,'rollback'); assert.equal(r.shouldPropagate(root,'po','anthropic'),false); assert.equal(notices.length,1);
  assert.equal(r.evaluatePair(root,'po','anthropic',{n:2,earlyDeathRate:.5,reboundRate:0},cfg,{notify:x=>notices.push(x)}).action,'off'); assert.equal(notices.length,1); });
test('muestra insuficiente no dispara rollback y reencendido exige humano', () => { const root=fixture(); seed(root,[1,2].map(i=>({ts:`2026-08-20T0${i}:00:00Z`,skill:'po',provider:'anthropic',exit_code:0,duration_ms:1}))); r.captureBaseline(root); r.enablePair(root,'po','anthropic',cfg); assert.equal(r.evaluatePair(root,'po','anthropic',{n:1,earlyDeathRate:1,reboundRate:1},cfg).action,'deferred'); assert.throws(()=>r.reenablePair(root,'po','anthropic',''),/--by/); });
