const p = require('path'), fs = require('fs');
const M = require('../.pipeline/lib/split-orphan-reconciler.js');
const corpus = JSON.parse(fs.readFileSync('.tmp5516/corpus.json','utf8'));
// Estado PRODUCTIVO real (repo principal, NO el worktree).
const PROD = 'C:/Workspaces/Intrale/platform/.pipeline';
const wavesLib = require('C:/Workspaces/Intrale/platform/.pipeline/lib/waves.js');
const active = wavesLib.getActiveWave();
const wave = (active.issues||[]).map(i=>i&&i.number).filter(Number.isInteger);
let allow = [];
try { allow = (JSON.parse(fs.readFileSync(PROD + '/.partial-pause.json','utf8')).allowed_issues)||[]; } catch(e){ console.log('allowlist:', e.message); }
console.log('ola activa #' + active.number, '| issues en ola:', wave.length, '| allowlist:', allow.length);

console.log('\n=== VENTANA ===');
console.log(JSON.stringify(M.classifyDiscoveryWindow({pagesFetched:2,lastBatchSize:34,pageSize:100,maxPages:5,incompleteResults:false})));

console.log('\n=== DESCUBRIMIENTO (paso 2) sobre estado real ===');
const f = M.findSplitOrphans(corpus, { activeWaveIssues: wave });
console.log('orphans:', JSON.stringify(f.orphans), '| truncated:', f.truncated);
console.log('rejectedUntrusted(SO-7):', f.rejectedUntrusted.length, '| rejectedByLabel(SO-8):', f.rejectedByLabel.length);

console.log('\n=== CONVERGENCIA SO-9 (paso 5) sobre estado real ===');
const g = M.splitChildrenMissingFromAllowlist({ issues: corpus, waveIssues: wave, allowlistIssues: allow });
console.log('brecha ola->allowlist missing:', JSON.stringify(g.missing), '| truncated:', g.truncated);
console.log('rejectedByLabel:', JSON.stringify(g.rejectedByLabel.map(r=>({c:r.child,r:r.reason}))));

console.log('\n=== ESCENARIO DEL INCIDENTE: fallo parcial simulado sobre datos reales ===');
// Tomo un hijo real y simulo "ola lo tiene, allowlist no".
const victim = corpus.map(i=>({n:i.number,par:M.parentOfSplitOrphan(i)})).filter(x=>x.par && wave.includes(x.par) && wave.includes(x.n))[0];
if (victim) {
  const allowSinVictim = allow.filter(n => n !== victim.n);
  const g2 = M.splitChildrenMissingFromAllowlist({ issues: corpus, waveIssues: wave, allowlistIssues: allowSinVictim });
  console.log('victima real: #' + victim.n + ' (hijo de #' + victim.par + '), removida de la allowlist');
  console.log('  findSplitOrphans -> ', JSON.stringify(M.findSplitOrphans(corpus,{activeWaveIssues:wave}).orphans.filter(o=>o.child===victim.n)), '(vacio: el descubrimiento NO reintenta)');
  console.log('  SO-9 missing    -> ', JSON.stringify(g2.missing.filter(n=>n===victim.n)), g2.missing.includes(victim.n) ? '*** BRECHA DETECTADA, se cierra sola ***' : '*** FALLO ***');
} else { console.log('(no hay hijo real en ola+allowlist para simular)'); }
