#!/usr/bin/env node
// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// cli.js — Inventario, NOTICE y gate de licencias de terceros (#7592)
//
//   node scripts/licenses/cli.js generate   → escribe NOTICE, reporte e inventario
//   node scripts/licenses/cli.js check      → política + aprobación de excepciones
//                                             + drift; exit ≠ 0 ante cualquier hallazgo
//
// Requiere haber corrido antes `./gradlew licensesInventory --no-daemon`.
//
// Fail-closed (CA-1 / SR-4): exit ≠ 0 si un colector falla, si el inventario
// sale vacío, si algún ecosistema tiene 0 dependencias o si falta el
// artifacts.json de un módulo Gradle esperado.
//
// Todas las dependencias externas (fs, now, git, labels, env, salida) son
// inyectables vía run(argv, deps) para testear sin red ni Gradle.
// =============================================================================
'use strict';

const nodeFs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const sanitize = require('./sanitize');
const { buildAliasIndex } = require('./spdx');
const { collectGradle } = require('./collect-gradle');
const { collectNpm } = require('./collect-npm');
const { extractCopyright } = require('./read-license-file');
const { evaluate, activeExceptions, licenseLabel } = require('./policy');
const { checkExceptionApproval, fetchPrLabelsFromEnv, POLICY_PATH } = require('./exceptions-diff');
const { renderInventoryJson, renderNotice, renderReport } = require('./render');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const FILES = Object.freeze({
  policy: POLICY_PATH,
  copyrights: 'config/licenses/npm-copyrights.json',
  notice: 'NOTICE',
  report: 'docs/legal/third-party-licenses.md',
  inventory: 'docs/legal/third-party-inventory.json',
});
const REGENERATE_CMD = 'npm run licenses:generate';
const MAX_DRIFT_LINES = 20;

class InventoryError extends Error {}

function readJson(fs, abs, what) {
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    throw new InventoryError(`no se pudo leer ${what}: ${e.code || e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new InventoryError(`${what} no es JSON válido: ${e.message}`);
  }
}

function loadPolicy(fs, root) {
  const policy = readJson(fs, path.join(root, FILES.policy), FILES.policy);
  if (!policy || !Array.isArray(policy.exceptions)) throw new InventoryError(`${FILES.policy}: falta "exceptions"`);
  return policy;
}

function loadCopyrights(fs, root) {
  const abs = path.join(root, FILES.copyrights);
  if (!fs.existsSync(abs)) return {};
  const data = readJson(fs, abs, FILES.copyrights);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

/** Junta Gradle + npm. Lanza InventoryError ante cualquier falla (CA-1). */
function collectAll({ fs, root, policy }) {
  const aliasIndex = buildAliasIndex(policy.aliases);
  let gradle;
  let npm;
  try {
    gradle = collectGradle({
      rootDir: root,
      modules: policy.gradle && policy.gradle.modulos,
      hostVariants: policy.gradle && policy.gradle.variantes_por_host,
      aliasIndex,
      fs,
    });
  } catch (e) {
    throw new InventoryError(`colector Gradle: ${e.message}`);
  }
  try {
    npm = collectNpm({ rootDir: root, lockfiles: policy.npm && policy.npm.lockfiles, aliasIndex, fs });
  } catch (e) {
    throw new InventoryError(`colector npm: ${e.message}`);
  }
  const entries = [...gradle.entries, ...npm.entries];
  const counts = { gradle: gradle.entries.length, npm: npm.entries.length };
  if (entries.length === 0) throw new InventoryError('el inventario salió vacío: no se escaneó ninguna dependencia');
  for (const [eco, n] of Object.entries(counts)) {
    if (n === 0) throw new InventoryError(`el ecosistema ${eco} tiene 0 dependencias: el escaneo no es confiable`);
  }
  return { entries, counts, stats: { gradle: gradle.stats, npm: npm.stats } };
}

/** Refresca el caché de copyright leyendo node_modules (sólo en generate). */
function refreshCopyrights({ fs, root, entries, previous }) {
  const next = {};
  for (const e of entries) {
    // Sólo lo distribuido lleva copyright en el NOTICE.
    if (e.ecosystem !== 'npm' || e.scope !== 'distribuido') continue;
    const key = `${e.coordinate}@${e.version}`;
    let found = null;
    for (const dir of e.installDirs || []) {
      const abs = path.join(root, dir);
      if (!fs.existsSync(abs)) continue;
      found = extractCopyright(abs, { fs });
      if (found) break;
    }
    if (found) next[key] = found;
    else if (typeof previous[key] === 'string') next[key] = previous[key];
  }
  const sorted = {};
  for (const k of Object.keys(next).sort()) sorted[k] = next[k];
  return sorted;
}

function renderAll(entries, policy, copyrights) {
  return {
    [FILES.notice]: renderNotice(entries, policy, copyrights),
    [FILES.report]: renderReport(entries, policy),
    [FILES.inventory]: renderInventoryJson(entries),
  };
}

function normalizeEol(s) {
  return String(s).replace(/\r\n/g, '\n');
}

function entryKey(row) {
  return `${row.ecosistema}|${row.coordenada}@${row.version}`;
}

/** Diferencias entre dos inventarios JSON (filas agregadas / quitadas / con licencia cambiada). */
function diffInventories(baseRows, headRows) {
  const base = new Map((baseRows || []).map((r) => [entryKey(r), r]));
  const head = new Map((headRows || []).map((r) => [entryKey(r), r]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, r] of head) {
    if (!base.has(k)) added.push(r);
    else if ((base.get(k).licencia_spdx || base.get(k).licencia_declarada) !== (r.licencia_spdx || r.licencia_declarada)) changed.push({ before: base.get(k), after: r });
  }
  for (const [k, r] of base) if (!head.has(k)) removed.push(r);
  return { added, removed, changed };
}

function formatFinding(f) {
  const parts = [sanitize.forLog(f.coordinate)];
  if (f.license) parts.push(sanitize.forLog(f.license));
  if (f.rule) parts.push(`regla ${sanitize.forLog(f.rule)}`);
  if (f.detail) parts.push(sanitize.forLog(f.detail, 300));
  const lines = [`${f.type}: ${parts.join(' — ')}`];
  if (f.action) lines.push(`  → ${f.action}`);
  return lines.join('\n');
}

function summaryLine(findings, counts) {
  const n = (t) => findings.filter((f) => f.type === t).length;
  const total = counts.gradle + counts.npm;
  return `Gate de licencias: ${n('LICENCIA PROHIBIDA')} prohibidas · ${n('LICENCIA DESCONOCIDA')} desconocidas · `
    + `${n('EXCEPCIÓN VENCIDA')} excepciones vencidas · ${n('EXCEPCIÓN INVÁLIDA')} inválidas · `
    + `${n('EXCEPCIÓN SIN APROBAR')} sin aprobar · ${n('DRIFT')} drift — `
    + `${total} dependencias revisadas (gradle ${counts.gradle} · npm ${counts.npm})`;
}

function stepSummary({ findings, counts, baseDiff, active, approval }) {
  const md = sanitize.forMarkdown;
  const out = [];
  const total = counts.gradle + counts.npm;
  if (findings.length) out.push(`## ❌ Gate de licencias en rojo — ${findings.length} problema(s)`);
  else out.push(`## ✅ Gate de licencias en verde — ${total} dependencias revisadas`);
  out.push('');
  out.push(`Gradle: ${counts.gradle} · npm: ${counts.npm}`);
  out.push('');
  if (findings.length) {
    out.push('### Qué hay que resolver');
    out.push('');
    out.push('| Dependencia | Licencia | Problema | Acción |');
    out.push('| --- | --- | --- | --- |');
    for (const f of findings) {
      out.push(`| ${md(f.coordinate)} | ${md(f.license || '—')} | ${md(f.type)}: ${md(f.detail || '', 300)} | ${md(f.action || '')} |`);
    }
    out.push('');
  }
  out.push('### Cambios respecto de la base');
  out.push('');
  if (!baseDiff) {
    out.push('_Sin rama base para comparar (corrida programada, push o manual), o la base no tiene inventario._');
  } else if (!baseDiff.added.length && !baseDiff.removed.length && !baseDiff.changed.length) {
    out.push('_Sin dependencias nuevas, quitadas ni con licencia cambiada._');
  } else {
    out.push('| Cambio | Dependencia | Licencia |');
    out.push('| --- | --- | --- |');
    for (const r of baseDiff.added) out.push(`| nueva | ${md(`${r.coordenada}@${r.version}`)} | ${md(r.licencia_spdx || r.licencia_declarada)} |`);
    for (const c of baseDiff.changed) out.push(`| licencia cambiada | ${md(`${c.after.coordenada}@${c.after.version}`)} | ${md(c.before.licencia_spdx || c.before.licencia_declarada)} → ${md(c.after.licencia_spdx || c.after.licencia_declarada)} |`);
    for (const r of baseDiff.removed) out.push(`| quitada | ${md(`${r.coordenada}@${r.version}`)} | ${md(r.licencia_spdx || r.licencia_declarada)} |`);
  }
  out.push('');
  out.push('### Excepciones vigentes');
  out.push('');
  if (!active.length) out.push('_No hay excepciones vigentes._');
  else {
    out.push('| Paquete | Licencia | Revisar antes | Estado |');
    out.push('| --- | --- | --- | --- |');
    for (const x of active) {
      out.push(`| ${md(x.paquete)} | ${md(x.licencia)} | ${md(x.revisar_antes, 20)} | ${x.vence_pronto ? `⚠️ vence en ≤30 días (${x.dias})` : 'vigente'} |`);
    }
  }
  if (approval && approval.note) {
    out.push('');
    out.push(`_Aprobación de excepciones: ${md(approval.note, 300)}._`);
  }
  out.push('');
  return out.join('\n');
}

function defaultExecGit(root) {
  return (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
}

function parseArgs(argv) {
  const args = { cmd: argv[0], root: null };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--root') args.root = argv[++i];
    else if (argv[i] === '--base') args.base = argv[++i];
  }
  return args;
}

async function runGenerate({ fs, root, out, err }) {
  const policy = loadPolicy(fs, root);
  const { entries, counts } = collectAll({ fs, root, policy });
  const copyrights = refreshCopyrights({ fs, root, entries, previous: loadCopyrights(fs, root) });
  const files = {
    [FILES.copyrights]: JSON.stringify(copyrights, null, 2) + '\n',
    ...renderAll(entries, policy, copyrights),
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    out(`escrito ${rel}`);
  }
  out(`Inventario: ${counts.gradle + counts.npm} dependencias (gradle ${counts.gradle} · npm ${counts.npm}).`);
  void err;
  return 0;
}

async function runCheck({ fs, root, now, env, execGit, fetchLabels, out, baseOverride }) {
  const policy = loadPolicy(fs, root);
  const { entries, counts } = collectAll({ fs, root, policy });
  const copyrights = loadCopyrights(fs, root);

  const { findings } = evaluate(entries, policy, { now });

  const baseRef = baseOverride || env.LICENSES_BASE_REF || env.GITHUB_BASE_REF || null;
  const approval = await checkExceptionApproval({ headPolicy: policy, baseRef, execGit, fetchLabels });
  findings.push(...approval.findings);

  // Drift (CA-2): lo versionado tiene que ser exactamente lo que genera el inventario actual.
  const expected = renderAll(entries, policy, copyrights);
  const drifted = [];
  for (const [rel, content] of Object.entries(expected)) {
    let current = null;
    try { current = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { current = null; }
    if (current === null || normalizeEol(current) !== normalizeEol(content)) drifted.push({ rel, current });
  }
  if (drifted.length) {
    const invCurrent = drifted.find((d) => d.rel === FILES.inventory);
    let detail = `difieren: ${drifted.map((d) => d.rel).join(', ')}`;
    if (invCurrent && invCurrent.current) {
      try {
        const d = diffInventories(JSON.parse(invCurrent.current), JSON.parse(expected[FILES.inventory]));
        const lines = [
          ...d.added.map((r) => `+ ${r.coordenada}@${r.version}`),
          ...d.removed.map((r) => `- ${r.coordenada}@${r.version}`),
          ...d.changed.map((c) => `~ ${c.after.coordenada}@${c.after.version}`),
        ];
        if (lines.length) {
          const shown = lines.slice(0, MAX_DRIFT_LINES).join(', ');
          detail += `; entradas: ${shown}${lines.length > MAX_DRIFT_LINES ? ` (+${lines.length - MAX_DRIFT_LINES} más)` : ''}`;
        }
      } catch { /* inventario versionado ilegible: alcanza con la lista de archivos */ }
    }
    findings.push({
      type: 'DRIFT',
      coordinate: 'NOTICE / reporte de licencias',
      detail: `el NOTICE no coincide con las dependencias actuales (${detail})`,
      action: `Ejecutá: ${REGENERATE_CMD}`,
    });
  }

  // Cambios respecto de la base (sólo informativo, Step Summary).
  let baseDiff = null;
  if (baseRef) {
    try {
      const baseInv = JSON.parse(execGit(['show', `origin/${baseRef}:${FILES.inventory}`]));
      baseDiff = diffInventories(baseInv, JSON.parse(expected[FILES.inventory]));
    } catch { baseDiff = null; }
  }

  for (const f of findings) out(formatFinding(f));
  out(summaryLine(findings, counts));

  if (env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, stepSummary({
        findings, counts, baseDiff, active: activeExceptions(policy, now), approval,
      }) + '\n', 'utf8');
    } catch { /* el Step Summary es accesorio: nunca cambia el veredicto */ }
  }
  return findings.length ? 1 : 0;
}

/**
 * @param {string[]} argv
 * @param {object} [deps]  { fs, now, env, execGit, fetchLabels, stdout, stderr, root }
 * @returns {Promise<number>} exit code
 */
async function run(argv, deps = {}) {
  const args = parseArgs(argv);
  const fs = deps.fs || nodeFs;
  const root = path.resolve(args.root || deps.root || DEFAULT_ROOT);
  const env = deps.env || process.env;
  const out = deps.stdout || ((s) => process.stdout.write(s + '\n'));
  const err = deps.stderr || ((s) => process.stderr.write(s + '\n'));
  const now = deps.now !== undefined ? deps.now : new Date();
  const execGit = deps.execGit || defaultExecGit(root);
  const fetchLabels = deps.fetchLabels || (() => fetchPrLabelsFromEnv({ env, fs }));

  try {
    if (args.cmd === 'generate') return await runGenerate({ fs, root, out, err });
    if (args.cmd === 'check') {
      return await runCheck({ fs, root, now, env, execGit, fetchLabels, out, baseOverride: args.base });
    }
    err('Uso: node scripts/licenses/cli.js <generate|check> [--root <dir>] [--base <rama>]');
    return 2;
  } catch (e) {
    const msg = e instanceof InventoryError ? e.message : `error inesperado: ${e && e.message}`;
    err(`INVENTARIO: ${sanitize.forLog(msg, 500)}`);
    err('  → Revisá que haya corrido ./gradlew licensesInventory --no-daemon y que existan los lockfiles de la política');
    return 1;
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { FILES, run, diffInventories, formatFinding, summaryLine, licenseLabel };
