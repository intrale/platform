// Verificación empírica del rebote de #5516 (2026-08-10).
// Corre el clasificador NUEVO contra datos REALES de GitHub y contra la ola
// activa PRODUCTIVA (repo principal, no el worktree del agente).
'use strict';
const fs = require('fs');
const sor = require('../.pipeline/lib/split-orphan-reconciler');

const WAVES = 'C:/Workspaces/Intrale/platform/.pipeline/waves.json';
const w = JSON.parse(fs.readFileSync(WAVES, 'utf8'));
const active = w.active_wave || {};
const wave = (active.issues || []).map((i) => i.number).filter(Number.isInteger);
console.log(`OLA ACTIVA PRODUCTIVA: #${active.number} "${active.name}" — ${wave.length} issues`);

function load(prefix, max) {
  const out = [];
  let pages = 0, last = 0;
  for (let p = 1; p <= max; p++) {
    const f = `.tmp5516/${prefix}${p}.json`;
    if (!fs.existsSync(f)) break;
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const batch = Array.isArray(raw) ? raw : raw.items;
    if (!Array.isArray(batch)) break;
    pages = p; last = batch.length;
    for (const it of batch) if (it && it.pull_request === undefined) out.push(it);
    if (batch.length < 100) break;
  }
  return { issues: out, pages, last };
}

// --- A) VENTANA VIEJA: REST 3 páginas ----------------------------------------
const old = load('p', 3);
const oldWin = sor.classifyDiscoveryWindow({
  pagesFetched: old.pages, lastBatchSize: old.last, pageSize: 100, maxPages: 3,
});
const oldRes = sor.findSplitOrphans(old.issues, { activeWaveIssues: wave });
console.log(`\n--- VENTANA VIEJA (REST, 3 pags) ---`);
console.log(`  issues=${old.issues.length} paginas=${old.pages} ultima=${old.last}`);
console.log(`  classifyDiscoveryWindow -> ${JSON.stringify(oldWin)}   <-- ANTES esto no existia (silencioso)`);
console.log(`  orphans=${oldRes.orphans.length}`, JSON.stringify(sor.groupByParent(oldRes.orphans)));

// --- B) VENTANA NUEVA: search in:title split ---------------------------------
const neu = load('sr', 5);
const newWin = sor.classifyDiscoveryWindow({
  pagesFetched: neu.pages, lastBatchSize: neu.last, pageSize: 100, maxPages: 5,
});
const newRes = sor.findSplitOrphans(neu.issues, { activeWaveIssues: wave });
console.log(`\n--- VENTANA NUEVA (search in:title split, tope 5 pags) ---`);
console.log(`  issues=${neu.issues.length} paginas=${neu.pages} ultima=${neu.last}`);
console.log(`  classifyDiscoveryWindow -> ${JSON.stringify(newWin)}`);
console.log(`  orphans=${newRes.orphans.length}`, JSON.stringify(sor.groupByParent(newRes.orphans)));
console.log(`  truncated=${newRes.truncated} reason=${newRes.reason}`);

// --- C) SO-8 sobre datos reales ----------------------------------------------
console.log(`\n--- SO-8: excluidos por label (datos reales) ---`);
if (newRes.rejectedByLabel.length === 0) console.log('  (ninguno en alcance)');
for (const r of newRes.rejectedByLabel) {
  console.log(`  #${r.child} (padre #${r.parent}) -> ${r.reason} ${JSON.stringify(r.labels)}`);
}

// --- D) Control: ¿que pasaria SIN el guard SO-8? ------------------------------
const sinGuard = sor.findSplitOrphans(neu.issues, {
  activeWaveIssues: wave, blockingLabels: [],
});
const conGuard = new Set(newRes.orphans.map((o) => o.child));
const bloqueados = sinGuard.orphans.map((o) => o.child).filter((c) => !conGuard.has(c));
console.log(`\n--- CONTROL: hijos que ENTRABAN antes del guard y ahora NO ---`);
console.log(`  sin guard=${sinGuard.orphans.length}  con guard=${newRes.orphans.length}  frenados=[${bloqueados.join(', ')}]`);
for (const c of bloqueados) {
  const it = neu.issues.find((i) => i.number === c);
  console.log(`  #${c} labels=${JSON.stringify((it.labels || []).map((l) => l.name))}`);
}

// --- D2) ESCENARIO DEL INCIDENTE: ola SIN el backfill manual -------------------
// Hoy la ola #10 ya tiene los huerfanos incorporados a mano, asi que la
// idempotencia los saltea antes de llegar a SO-8. Para ejercitar el guard con
// datos REALES reconstruimos la ola como estaba ANTES del backfill: se quitan de
// la ola los issues cuyo titulo es un split canonico (o sea, los hijos).
const RE0 = sor.SPLIT_TITLE_RE;
const titleOf = new Map(neu.issues.map((i) => [i.number, i.title || '']));
const wavePre = wave.filter((n) => !RE0.test(titleOf.get(n) || ''));
console.log(`\n--- ESCENARIO INCIDENTE: ola sin backfill (${wavePre.length} de ${wave.length} issues) ---`);

const preConGuard = sor.findSplitOrphans(neu.issues, { activeWaveIssues: wavePre });
const preSinGuard = sor.findSplitOrphans(neu.issues, { activeWaveIssues: wavePre, blockingLabels: [] });
const setCon = new Set(preConGuard.orphans.map((o) => o.child));
const frenados = preSinGuard.orphans.map((o) => o.child).filter((c) => !setCon.has(c));

console.log(`  SIN guard SO-8: ${preSinGuard.orphans.length} hijos se incorporaban`);
console.log(`  CON guard SO-8: ${preConGuard.orphans.length} hijos se incorporan`);
console.log(`  FRENADOS por SO-8: [${frenados.join(', ')}]`);
for (const c of frenados) {
  const it = neu.issues.find((i) => i.number === c);
  console.log(`    #${c} labels=${JSON.stringify((it.labels || []).map((l) => l.name))}`);
}
console.log(`  rejectedByLabel reportados: ${preConGuard.rejectedByLabel.length}`);
for (const r of preConGuard.rejectedByLabel) {
  console.log(`    #${r.child} (padre #${r.parent}) ${r.reason} ${JSON.stringify(r.labels)}`);
}
// Los 3 que el PO midio el 2026-08-07 + el caso vivo de hoy.
// El guard depende del ESTADO ACTUAL de labels: si el issue ya fue destrabado
// (le sacaron `needs-human`), incorporarlo es lo CORRECTO. Lo que se verifica es
// la equivalencia: bloqueado por label <=> excluido.
console.log(`\n  Coherencia label <-> exclusion (todos los hijos en alcance):`);
let coherente = true;
for (const n of [5209, 5421, 5462, 5426]) {
  const it = neu.issues.find((i) => i.number === n);
  if (!it) { console.log(`    #${n}: no esta en la ventana`); continue; }
  const labels = (it.labels || []).map((l) => l.name);
  const bloq = sor.blockingLabelsOf(it) || [];
  const excluido = !setCon.has(n);
  const ok = (bloq.length > 0) === excluido;
  if (!ok) coherente = false;
  console.log(`    #${n} bloqueantes=${JSON.stringify(bloq)} excluido=${excluido} -> ${ok ? 'COHERENTE' : 'INCOHERENTE'}`);
  console.log(`         labels actuales: ${JSON.stringify(labels)}`);
}
// Chequeo global sobre TODOS los candidatos en alcance.
for (const o of preSinGuard.orphans) {
  const it = neu.issues.find((i) => i.number === o.child);
  const bloq = it ? (sor.blockingLabelsOf(it) || []) : [];
  const excluido = !setCon.has(o.child);
  if ((bloq.length > 0) !== excluido) {
    coherente = false;
    console.log(`    !! INCOHERENTE #${o.child} bloq=${JSON.stringify(bloq)} excluido=${excluido}`);
  }
}
console.log(`  => coherencia global sobre ${preSinGuard.orphans.length} candidatos: ${coherente ? 'OK' : 'FALLA'}`);

// --- E) Cobertura: hijos con titulo canonico en cada ventana ------------------
const RE = sor.SPLIT_TITLE_RE;
const kidsOld = old.issues.filter((i) => RE.test(i.title || '')).length;
const kidsNew = neu.issues.filter((i) => RE.test(i.title || '')).length;
console.log(`\n--- COBERTURA (hijos con titulo canonico alcanzados) ---`);
console.log(`  ventana VIEJA (300 issues): ${kidsOld}`);
console.log(`  ventana NUEVA (search):     ${kidsNew}`);
