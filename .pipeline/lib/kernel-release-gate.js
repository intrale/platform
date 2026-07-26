'use strict';
/**
 * kernel-release-gate.js — Transformación y verificación fail-closed del gate
 * humano del workflow de release del kernel (#4695 · CA-C0/CA-C1).
 *
 * Contexto (auditoría 2026-07-26, finding CRITICAL-1): la transformación
 * `--gate=dispatch` se hacía con dos regex que exigían `\n` literal. El YAML está
 * guardado con CRLF, así que el regex del trigger NO matcheaba (el `on: push` por
 * tag sobrevivía) y el del environment SÍ (el gate humano se borraba). Resultado:
 * se quitaba el gate y se conservaba el auto-publish — exactamente al revés — y el
 * script imprimía `[ok] gate = disparo manual`, así que el fallo era silencioso.
 *
 * Este módulo separa las dos responsabilidades:
 *   · applyGate()        — edición textual tolerante a CRLF (preserva comentarios).
 *   · assertGateSafety() — verificación estructural sobre el YAML parseado. Es la
 *                          red fail-closed: si la transformación no dejó un gate
 *                          efectivo, tira y el llamador NO debe escribir el archivo.
 *
 * Los dos modos de gate:
 *   environment — el job `publish` queda detrás de `environment: release` con
 *                 required reviewers. GitHub pausa el job hasta la aprobación.
 *   dispatch    — se elimina el trigger por push de tag: el workflow sólo corre por
 *                 `workflow_dispatch`. El acto humano de dispararlo ES el gate.
 *                 Fallback para planes de GitHub sin environments protegidos.
 *
 * En AMBOS modos tiene que ser imposible que un push de tag publique solo.
 */

const GATES = ['environment', 'dispatch'];

/** Normaliza CRLF/CR a LF. Todo lo demás asume LF. */
function normalizeEol(yml) {
  return String(yml).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Borra una clave hija de un mapping de primer nivel, con todo su sub-bloque.
 * Ej: dropChildBlock(yml, 'on', 'push') elimina `  push:` y sus líneas indentadas.
 * Devuelve `{ yml, removed }` — `removed` es false si la clave no estaba.
 */
function dropChildBlock(yml, parentKey, childKey) {
  const lines = normalizeEol(yml).split('\n');
  const parentIdx = lines.findIndex((l) => new RegExp(`^${parentKey}:\\s*(#.*)?$`).test(l));
  if (parentIdx === -1) return { yml, removed: false };

  let childIdx = -1;
  let childIndent = 0;
  for (let i = parentIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break; // salimos del mapping del padre
    if (new RegExp(`^\\s+${childKey}:\\s*(#.*)?$`).test(line)) {
      childIdx = i;
      childIndent = indent;
      break;
    }
  }
  if (childIdx === -1) return { yml, removed: false };

  let end = childIdx + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (/^\s*$/.test(line)) { end++; continue; }
    const indent = line.length - line.trimStart().length;
    if (indent <= childIndent) break;
    end++;
  }
  lines.splice(childIdx, end - childIdx);
  return { yml: lines.join('\n'), removed: true };
}

/** Comenta la línea `environment: <x>` del job indicado. */
function commentOutEnvironment(yml, note) {
  const lines = normalizeEol(yml).split('\n');
  const idx = lines.findIndex((l) => /^\s+environment:\s*release\b/.test(l));
  if (idx === -1) return { yml: lines.join('\n'), removed: false };
  const indent = lines[idx].slice(0, lines[idx].length - lines[idx].trimStart().length);
  lines[idx] = `${indent}# ${note}`;
  return { yml: lines.join('\n'), removed: true };
}

/**
 * Aplica el modo de gate al YAML. Siempre devuelve LF.
 * No verifica nada: la verificación es responsabilidad de assertGateSafety().
 */
function applyGate(yml, gate) {
  if (!GATES.includes(gate)) throw new Error(`gate invalido: ${gate}`);
  let out = normalizeEol(yml);
  if (gate === 'dispatch') {
    const dropped = dropChildBlock(out, 'on', 'push');
    out = dropped.yml;
    out = commentOutEnvironment(out, 'gate humano = disparo manual (workflow_dispatch)').yml;
  }
  return out;
}

function loadYaml(yml) {
  // eslint-disable-next-line global-require
  const jsYaml = require('js-yaml');
  const doc = jsYaml.load(normalizeEol(yml));
  if (!doc || typeof doc !== 'object') throw new Error('el workflow no parsea como mapping YAML');
  // YAML 1.1 interpreta `on` como booleano true; js-yaml 4 (core schema) no, pero
  // no dependemos de eso: aceptamos las dos formas.
  const triggers = Object.prototype.hasOwnProperty.call(doc, 'on') ? doc.on : doc[true];
  return { doc, triggers };
}

/**
 * Verificación fail-closed del resultado. Tira Error con TODOS los problemas
 * encontrados. El llamador no debe escribir ni commitear si esto tira.
 */
function assertGateSafety(yml, gate) {
  if (!GATES.includes(gate)) throw new Error(`gate invalido: ${gate}`);
  const problems = [];
  const { doc, triggers } = loadYaml(yml);

  if (!triggers || typeof triggers !== 'object') {
    problems.push('el workflow no declara triggers (`on:`)');
  }
  const jobs = doc.jobs || {};
  const publish = jobs.publish;
  if (!publish) problems.push('no existe el job `publish`');

  const hasPushTrigger = !!(triggers && triggers.push);
  const hasDispatch = !!(triggers && Object.prototype.hasOwnProperty.call(triggers, 'workflow_dispatch'));

  if (gate === 'dispatch') {
    // El gate ES el disparo manual ⇒ ningún trigger automático puede sobrevivir.
    if (hasPushTrigger) {
      problems.push('gate=dispatch pero el trigger `on.push` sigue presente: un push de tag publicaria SOLO');
    }
    if (!hasDispatch) {
      problems.push('gate=dispatch pero no hay `workflow_dispatch`: el workflow quedaria sin forma de dispararse');
    }
    const autoTriggers = Object.keys(triggers || {}).filter((k) => k !== 'workflow_dispatch');
    if (autoTriggers.length) {
      problems.push(`gate=dispatch con triggers automaticos remanentes: ${autoTriggers.join(', ')}`);
    }
  } else {
    // El gate es el environment protegido ⇒ tiene que estar en el job publish.
    if (publish && publish.environment !== 'release' && (publish.environment || {}).name !== 'release') {
      problems.push('gate=environment pero el job `publish` no declara `environment: release`');
    }
  }

  // Invariantes comunes a los dos modos.
  if (doc.permissions && doc.permissions.contents && doc.permissions.contents !== 'read') {
    problems.push(`permisos de workflow demasiado amplios: contents=${doc.permissions.contents}`);
  }
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of (job && job.steps) || []) {
      if (typeof step.run === 'string' && step.run.includes('${{')) {
        problems.push(`inyeccion: el step "${step.name || step.id || '?'}" del job ${jobName} interpola \${{ }} dentro de run:`);
      }
      if (typeof step.uses === 'string' && step.uses.includes('@') && !/@[0-9a-f]{40}$/.test(step.uses)) {
        problems.push(`action sin pin por SHA en el job ${jobName}: ${step.uses}`);
      }
    }
  }

  if (problems.length) {
    const err = new Error(`El workflow transformado NO es seguro (gate=${gate}):\n  - ${problems.join('\n  - ')}`);
    err.problems = problems;
    throw err;
  }
  return true;
}

module.exports = { GATES, normalizeEol, dropChildBlock, applyGate, assertGateSafety };
