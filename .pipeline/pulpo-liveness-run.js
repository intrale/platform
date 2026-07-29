#!/usr/bin/env node
// =============================================================================
// pulpo-liveness-run.js — Orquestador del liveness del Pulpo (#4154)
//
// Lo invoca `watchdog.ps1` cuando detecta que el proceso de `pulpo.js` EXISTE
// (el path de proceso ausente ya lo cubre el spawn normal del watchdog).
// PowerShell recolecta los hechos del SO y los pasa por variables de entorno;
// este script toma la decisión (vía lib/pulpo-liveness.js) y devuelve la acción
// por stdout para que PowerShell ejecute `Stop-Process` + respawn cuando
// corresponda.
//
// Por qué la lógica vive en Node y no en PowerShell
// -------------------------------------------------
// `node --test` cubre la decisión (sano / zombi / discrepancia de PID /
// fail-closed). PowerShell queda como capa fina de SO (leer heartbeat,
// consultar el proceso, matar+respawnear). Una sola fuente de verdad, testeada.
//
// Hechos esperados por env (los setea el .ps1):
//   PLV_HB_EXISTS        '1' | '0'   ¿existe last-tick.json?
//   PLV_HB_AGE_MS        edad del heartbeat (mtime) en ms (entero) | '' si no existe
//   PLV_HB_CONTENT       contenido crudo de last-tick.json (para cross-check de pid) | ''
//   PLV_SO_PID           pid del proceso pulpo.js detectado por el scan SO (entero) | ''
//   PULPO_LIVENESS_KILL_SECONDS  override opcional del umbral (entero positivo)
//
// Salida stdout (una línea, la lee PowerShell):
//   ACTION:kill-respawn | ACTION:skip
//   (la discrepancia de PID se loguea pero se mapea a skip: nunca matamos sin
//    cross-check; mantener el contrato binario para el .ps1)
//
// Fail-soft: cualquier error interno => ACTION:skip (no inventar kills por un
// bug del orquestador) + log. NUNCA emite secrets ni paths sensibles.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const PIPELINE_DIR = __dirname;
const LOG_DIR = process.env.PLV_LOG_DIR || path.join(PIPELINE_DIR, 'logs');
const RUN_LOG = path.join(LOG_DIR, 'pulpo-liveness.log');

const liveness = require('./lib/pulpo-liveness');

function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(RUN_LOG, `[${ts}] ${msg}\n`);
  } catch (_) {
    /* fail-soft: si no podemos loguear, seguimos */
  }
}

/**
 * Lee el bloque `watchdog:` de config.yaml vía el punto ÚNICO de lectura
 * (#5172: `lib/config-resolver.js`, que parsea, valida contra el schema y lanza
 * errores tipados YA redactados).
 *
 * #5172 · CASO G-3 — por qué el require es LAZY y no está en el tope:
 *   `config-resolver` requiere `js-yaml` y `ajv` en su tope. Este runner corre
 *   en worktrees que PUEDEN no tener `node_modules`; un require en el tope del
 *   archivo mataría el proceso EN EL IMPORT, antes de llegar a cualquier
 *   política, y el fallo sería MUDO (el .ps1 se quedaría sin línea ACTION). Por
 *   eso se requiere dentro del `try` y `MODULE_NOT_FOUND` es fail-soft.
 *
 * #5172 · La degradación a defaults se LOGUEA siempre (nunca es silenciosa):
 *   el propósito del issue es matar el `catch {}` mudo que convertía
 *   "no pude leer la config" en "el umbral es el default" sin dejar traza.
 *
 * #5172 · `pipelineDir` va EXPLÍCITO: este runner fija su raíz a `__dirname` y
 *   no usa env vars. Si dependiera de la cadena de env del resolver, heredar
 *   `PIPELINE_REPO_ROOT` del entorno del pulpo le movería la raíz del worktree
 *   al repo principal, en silencio.
 */
function loadWatchdogConfig() {
  try {
    // eslint-disable-next-line global-require
    const configResolver = require('./lib/config-resolver');
    const cfg = configResolver.resolve({ pipelineDir: PIPELINE_DIR });
    if (cfg && typeof cfg === 'object' && cfg.watchdog && typeof cfg.watchdog === 'object') {
      return cfg.watchdog;
    }
    // #5172 / D-4: sección `watchdog:` ausente NO es corrupción; default seguro.
    log('config.yaml sin sección `watchdog:` — se usan los defaults del liveness');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      // G-3: worktree sin node_modules. Degradación EXPLÍCITA, no silenciosa.
      log(
        'DEGRADACION: config-resolver no cargable (worktree sin node_modules o módulo ausente) — ' +
          'se usan los defaults del liveness; el umbral de config.yaml NO se aplicó'
      );
    } else {
      // SEC-1: el error tipado ya viene redactado ({archivo, causa, linea,
      // columna}); NUNCA se loguea el `.message` crudo de js-yaml.
      log(
        `DEGRADACION: config.yaml ilegible o inválido (causa=${(err && err.causa) || 'desconocida'}` +
          `${err && err.linea != null ? `, linea=${err.linea}` : ''}` +
          `${err && err.columna != null ? `, columna=${err.columna}` : ''}) — ` +
          'se usan los defaults del liveness'
      );
    }
  }
  return {};
}

function envFlag(name) {
  return process.env[name] === '1';
}

function envInt(name) {
  const v = process.env[name];
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function main() {
  const cfg = loadWatchdogConfig();
  // Override por env tiene prioridad; luego config; luego default (SEC-2).
  const killSeconds = liveness.parseKillSeconds(
    process.env.PULPO_LIVENESS_KILL_SECONDS,
    liveness.parseKillSeconds(cfg.pulpo_liveness_kill_seconds, liveness.DEFAULT_KILL_SECONDS)
  );
  const killThresholdMs = killSeconds * 1000;

  const hbExists = envFlag('PLV_HB_EXISTS');
  const hbAgeMs = envInt('PLV_HB_AGE_MS');
  const hbPidFromContent = liveness.parseHeartbeatPid(process.env.PLV_HB_CONTENT || '');
  const soPid = envInt('PLV_SO_PID');

  const action = liveness.decide({
    hbExists,
    hbAgeMs,
    hbPidFromContent,
    soPid,
    killThresholdMs,
  });

  log(
    `decision=${action} hbExists=${hbExists} hbAgeMs=${hbAgeMs} ` +
      `hbPid=${hbPidFromContent} soPid=${soPid} killSeconds=${killSeconds}`
  );

  if (action === 'skip-log-discrepancy') {
    // SEC-1: lag vencido pero el PID del heartbeat no cruza con el del SO.
    // No matamos (evita kill de proceso ajeno por PID reciclado/falsificado).
    log(
      `DISCREPANCIA PID: heartbeat vencido (lag ${hbAgeMs}ms > umbral ${killThresholdMs}ms) ` +
        `pero hbPid=${hbPidFromContent} != soPid=${soPid}. No se mata.`
    );
    process.stdout.write('ACTION:skip\n');
    return;
  }

  // 'kill-respawn' o 'skip' van directo al .ps1.
  process.stdout.write(`ACTION:${action}\n`);
}

try {
  main();
} catch (err) {
  log(`ERROR inesperado en pulpo-liveness-run: ${err && err.message}`);
  // Fail-soft: ante un bug del orquestador, no inventamos kills.
  process.stdout.write('ACTION:skip\n');
}
