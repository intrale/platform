// =============================================================================
// pulpo-liveness.js — Lógica de decisión de liveness del Pulpo (#4154)
//
// Por qué este módulo existe
// --------------------------
// El watchdog (`.pipeline/watchdog.ps1`) decide si el Pulpo está vivo mirando
// SÓLO si existe un proceso `node` corriendo `pulpo.js` en el SO. Eso da por
// sano a un Pulpo zombi: proceso vivo pero loop principal colgado (no vuelve a
// iterar). Incidente 2026-06-24: hubo que reiniciar a mano.
//
// La solución (espejo de `lib/watchdog-supervisor.js`, patrón de #4077, un
// nivel abajo): el Pulpo emite un heartbeat por iteración (`last-tick.json`) y
// el watchdog verifica que sea reciente. PowerShell no es testeable con
// `node --test`, así que TODA la decisión vive acá; PowerShell sólo recolecta
// hechos del SO y ejecuta `Stop-Process`/respawn.
//
// Defensas de seguridad (de la fase de criterios, #4154):
//   SEC-1  El watchdog mata por PID del scan del SO, nunca por el PID del JSON.
//          Acá ese PID sólo se usa como CROSS-CHECK: si el pid del heartbeat no
//          coincide con el pid del scan SO (o es inválido) => no confirmar kill.
//   SEC-2  `last-tick.json` es input no confiable: parseo defensivo, fail-closed.
//          Umbral inválido => default, NUNCA "nunca stale".
//   SEC-3  Umbral de kill holgado y desacoplado del display (<30s de /salud).
//
// Cero dependencias npm. Funciones puras.
// =============================================================================

'use strict';

// Umbral de kill por default: 90s. Desacoplado del "esperado < 30s" que /salud
// usa para *mostrar* salud. 30s == 1 poll_interval del Pulpo; un ciclo lento
// (precheck de red, brazo pesado) puede rozarlo sin ser zombi. 90s = max(90,
// 3×poll_interval) evita falsos positivos (CA-4) y restart-storms (SEC-3).
const DEFAULT_KILL_SECONDS = 90;

/**
 * Valida el umbral de kill en segundos (SEC-2).
 * Debe ser entero positivo. Un valor no numérico / 0 / negativo NO debe
 * degradar el chequeo a "nunca stale": cae al default.
 *
 * @param {*} raw            valor crudo (string de env o number de config)
 * @param {number} fallback  default si raw es inválido
 * @returns {number} entero positivo (segundos)
 */
function parseKillSeconds(raw, fallback = DEFAULT_KILL_SECONDS) {
  const safeFallback =
    Number.isInteger(fallback) && fallback >= 1 ? fallback : DEFAULT_KILL_SECONDS;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 1 ? raw : safeFallback;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^[0-9]+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      if (Number.isInteger(n) && n >= 1) return n;
    }
  }
  return safeFallback;
}

/**
 * Extrae el PID del contenido (no confiable) de `last-tick.json` (SEC-2).
 * Sólo se usa para el cross-check del watchdog, NUNCA para construir el kill.
 * JSON malformado / campos faltantes / pid no entero o ≤ 0 => null (fail-closed).
 *
 * @param {*} raw  string crudo del archivo, o un objeto ya parseado
 * @returns {number|null} pid entero positivo, o null si es ilegible/ inválido
 */
function parseHeartbeatPid(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (_) {
      return null; // JSON malformado => ilegible
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const pid = obj.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

/**
 * Decide qué hacer con el Pulpo dado el estado del heartbeat y del SO.
 * Función PURA.
 *
 * IMPORTANTE: la edad del heartbeat (`hbAgeMs`) se calcula desde el mtime del
 * archivo (lo aporta el .ps1 vía env, como hace el supervisor con
 * `LastWriteTime`), NO desde el `timestamp` del contenido — el contenido es
 * input no confiable (SEC-2). El `hbPidFromContent` sólo cruza contra el SO.
 *
 * @param {object} facts
 * @param {boolean} facts.hbExists           ¿existe `last-tick.json`?
 * @param {number|null} facts.hbAgeMs        edad del heartbeat (mtime) en ms
 * @param {number|null} facts.hbPidFromContent  pid leído del contenido (cross-check)
 * @param {number|null} facts.soPid          pid del proceso pulpo.js del scan SO
 * @param {number} facts.killThresholdMs     umbral de kill en ms
 * @returns {'skip'|'kill-respawn'|'skip-log-discrepancy'}
 *   - 'skip'                 : sano, o sin heartbeat (no inventar kill).
 *   - 'kill-respawn'         : zombi confirmado (lag vencido + PID cruzado OK).
 *   - 'skip-log-discrepancy' : lag vencido pero PID no cruza => no matar, loguear.
 */
function decide(facts) {
  const f = facts || {};

  // Sin heartbeat => no inventar kill. Un proceso recién arrancado todavía no
  // escribió `last-tick.json`; un proceso ausente lo cubre el path normal del
  // watchdog (spawn por proceso inexistente). Fail-closed seguro (CA-6).
  if (!f.hbExists) return 'skip';

  const age = f.hbAgeMs;
  if (age == null || !Number.isFinite(age) || age < 0) {
    // Heartbeat existe pero su edad es ilegible (mtime raro): no matar.
    return 'skip';
  }

  const threshold = f.killThresholdMs;
  if (!Number.isFinite(threshold) || threshold <= 0) {
    // Umbral inválido => no matar (fail-closed, nunca kill por umbral degradado).
    return 'skip';
  }

  // Sano: el lag está dentro del umbral (CA-4, sin falso positivo).
  if (age <= threshold) return 'skip';

  // Zombi candidato: el proceso existe pero el lag superó el umbral.
  // SEC-1 / CA-3.1 — sólo confirmar si el pid del heartbeat coincide con el pid
  // del scan del SO. Cualquier discrepancia (pid inválido, ausente, distinto) =>
  // no matar + loguear (evita matar un proceso ajeno por PID reciclado o
  // heartbeat falsificado).
  const hbPid = f.hbPidFromContent;
  if (!Number.isInteger(hbPid) || hbPid <= 0) return 'skip-log-discrepancy';
  if (!Number.isInteger(f.soPid) || f.soPid <= 0) return 'skip-log-discrepancy';
  if (hbPid !== f.soPid) return 'skip-log-discrepancy';

  return 'kill-respawn';
}

module.exports = {
  decide,
  parseKillSeconds,
  parseHeartbeatPid,
  DEFAULT_KILL_SECONDS,
};
