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
const CONFIG_PATH = path.join(PIPELINE_DIR, 'config.yaml');

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
 * Lee el bloque `watchdog:` de config.yaml. Fail-soft a defaults si js-yaml no
 * está disponible (worktree sin node_modules) o el archivo está corrupto.
 */
function loadWatchdogConfig() {
  try {
    // eslint-disable-next-line global-require
    const yaml = require('js-yaml');
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = yaml.load(raw);
    if (cfg && typeof cfg === 'object' && cfg.watchdog && typeof cfg.watchdog === 'object') {
      return cfg.watchdog;
    }
  } catch (_) {
    /* fail-soft */
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
