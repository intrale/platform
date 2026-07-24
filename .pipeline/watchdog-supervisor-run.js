#!/usr/bin/env node
// =============================================================================
// watchdog-supervisor-run.js — Orquestador del supervisor del watchdog (#4077)
//
// Lo invoca `watchdog-supervisor.ps1` (2da tarea de Task Scheduler). PowerShell
// recolecta los hechos del SO y los pasa por variables de entorno; este script
// toma la decisión (vía lib/watchdog-supervisor.js), persiste el estado,
// encola la alerta a Telegram y devuelve la acción por stdout para que
// PowerShell ejecute `Start-ScheduledTask` cuando corresponda.
//
// Por qué la lógica vive en Node y no en PowerShell
// -------------------------------------------------
// `node --test` cubre la decisión (stale/cooldown/cap/fail-closed). PowerShell
// queda como capa fina de SO (leer heartbeat, consultar la tarea, relanzar).
// Una sola fuente de verdad para la decisión, testeada de verdad.
//
// Hechos esperados por env (los setea el .ps1):
//   WDS_HB_EXISTS     '1' | '0'
//   WDS_HB_AGE_MS     edad del heartbeat en ms (entero) | '' si no existe
//   WDS_TASK_HEALTHY  '1' (viva) | '0' (no viva) | '' (desconocido)
//   WATCHDOG_STALE_MINUTES  override opcional del umbral (entero positivo)
//
// Salida stdout (una línea, la lee PowerShell):
//   ACTION:relaunch | ACTION:skip | ACTION:escalate
//
// Fail-soft: cualquier error interno => ACTION:skip (no inventar relanzamientos
// por un bug del orquestador) + log. NUNCA lanza secrets ni paths sensibles.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const PIPELINE_DIR = __dirname;
// Paths overridables por env sólo para tests herméticos (default = producción).
// No exponen nada sensible: apuntan a logs/estado locales.
const LOG_DIR = process.env.WDS_LOG_DIR || path.join(PIPELINE_DIR, 'logs');
const STATE_FILE = process.env.WDS_STATE_FILE || path.join(LOG_DIR, 'watchdog-supervisor-state.json');
const SUP_LOG = path.join(LOG_DIR, 'watchdog-supervisor.log');
const CONFIG_PATH = path.join(PIPELINE_DIR, 'config.yaml');

const supervisor = require('./lib/watchdog-supervisor');

function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(SUP_LOG, `[${ts}] ${msg}\n`);
  } catch (_) {
    /* fail-soft: si no podemos loguear, seguimos */
  }
}

/**
 * Lee el bloque `watchdog:` de config.yaml. Fail-soft a defaults si js-yaml
 * no está disponible o el archivo está corrupto/ausente.
 */
function loadWatchdogConfig() {
  try {
    // js-yaml puede no estar en un worktree sin node_modules: fail-soft.
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

function envTaskHealthy() {
  const v = process.env.WDS_TASK_HEALTHY;
  if (v === '1') return true;
  if (v === '0') return false;
  return null; // desconocido => no cuenta para el cross-check
}

function envHeartbeatAgeMs() {
  const v = process.env.WDS_HB_AGE_MS;
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Encola la alerta a Telegram (SEC-5: sin red directa, sin secrets, sin paths
 * absolutos). Reutiliza lib/notify-telegram.js. Fail-soft.
 */
function notify(level, message, action, context) {
  try {
    // eslint-disable-next-line global-require
    const { notifyTelegram } = require('./lib/notify-telegram');
    notifyTelegram({
      level,
      component: 'watchdog-supervisor',
      message,
      action,
      context,
    });
  } catch (err) {
    log(`WARN no se pudo encolar alerta Telegram: ${err && err.message}`);
  }
}

function downtimeText(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'desconocido';
  const min = Math.round(ageMs / 60000);
  if (min < 1) return 'menos de 1 minuto';
  if (min === 1) return '1 minuto';
  return `${min} minutos`;
}

function main() {
  const cfg = loadWatchdogConfig();
  const staleMinutes = supervisor.parseStaleMinutes(
    process.env.WATCHDOG_STALE_MINUTES,
    supervisor.parseStaleMinutes(cfg.stale_minutes, supervisor.DEFAULT_STALE_MINUTES)
  );
  const maxRestarts = supervisor.parsePositiveInt(cfg.supervisor_max_restarts, supervisor.DEFAULT_MAX_RESTARTS);
  const cooldownSeconds = supervisor.parsePositiveInt(cfg.supervisor_cooldown_seconds, supervisor.DEFAULT_COOLDOWN_SECONDS);
  const windowMinutes = supervisor.parsePositiveInt(cfg.supervisor_window_minutes, supervisor.DEFAULT_WINDOW_MINUTES);

  const now = Date.now();
  const heartbeatExists = envFlag('WDS_HB_EXISTS');
  const heartbeatAgeMs = envHeartbeatAgeMs();
  const taskHealthy = envTaskHealthy();
  const state = supervisor.loadState(STATE_FILE);

  const decision = supervisor.decide({
    heartbeatExists,
    heartbeatAgeMs,
    taskHealthy,
    now,
    state,
    staleMinutes,
    maxRestarts,
    cooldownSeconds,
    windowMinutes,
  });

  log(
    `decision=${decision.action} reason=${decision.reason} stale=${decision.stale} ` +
      `hbExists=${heartbeatExists} hbAgeMs=${heartbeatAgeMs} taskHealthy=${taskHealthy} ` +
      `staleMin=${staleMinutes} restartsInWindow=${decision.restartsInWindow ?? 0}`
  );

  if (decision.action === 'relaunch') {
    const newState = supervisor.recordRelaunch(state, now, windowMinutes);
    supervisor.saveStateAtomic(STATE_FILE, newState);
    notify(
      'warn',
      `Watchdog stale (${decision.staleReason}), relanzando la tarea principal`,
      'Verificar servicios del pipeline tras la recuperación automática',
      { caido_hace: downtimeText(heartbeatAgeMs), motivo: decision.staleReason }
    );
  } else if (decision.action === 'escalate') {
    // Dedup de la alerta de escalada: a lo sumo 1 por ventana, para no spamear.
    const windowMs = windowMinutes * 60 * 1000;
    if (!state.lastEscalationTs || now - state.lastEscalationTs >= windowMs) {
      const newState = supervisor.recordEscalation(state, now);
      supervisor.saveStateAtomic(STATE_FILE, newState);
      notify(
        'error',
        `Watchdog sigue stale tras ${decision.restartsInWindow} relanzamientos: cap alcanzado`,
        'Escalado a needs-human — intervención manual requerida en el pipeline',
        { relanzamientos_en_ventana: decision.restartsInWindow, motivo: decision.staleReason }
      );
    } else {
      log('escalada ya alertada dentro de la ventana — no se repite alerta');
    }
  }

  process.stdout.write(`ACTION:${decision.action}\n`);
}

try {
  main();
} catch (err) {
  log(`ERROR inesperado en supervisor-run: ${err && err.message}`);
  // Fail-soft: ante un bug del orquestador, no inventamos relanzamientos.
  process.stdout.write('ACTION:skip\n');
}
