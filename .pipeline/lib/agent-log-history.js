// =============================================================================
// agent-log-history.js — Persistencia y consulta de logs de agentes por intento
// Issue #4444.
//
// Contexto: hoy el log de cada agente se escribe en un único archivo por
// `(issue, skill)` (`${issue}-${skill}.log`) que se TRUNCA al inicio de cada
// ejecución (`pulpo.js`). Cuando un agente rebota y se re-ejecuta sobre el mismo
// issue, el intento anterior se pierde. Este módulo centraliza la lógica —
// reusable y testeable — para:
//
//   1. derivar el nº de intento efectivo de los contadores de rebote del YAML,
//   2. nombrar los archivos por intento (`${issue}-${skill}.attempt-N.log`) y el
//      alias del intento vigente (`${issue}-${skill}.log`, compat con dashboard),
//   3. listar las ejecuciones históricas derivando de un glob dentro de LOG_DIR
//      (NO de input del cliente — REQ-SEC-1),
//   4. servir logs con un tope de bytes por request (REQ-SEC-4, anti-DoS),
//   5. aplicar una política de retención acotada (REQ-SEC-4).
//
// El módulo NO redacta secrets por sí mismo: la redacción vive en
// `createLogFileWriter` (persistencia) y en `redactLogText()` (al servir). Este
// módulo solo maneja naming, listado, tope de bytes y retención.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// Escapa metacaracteres de regex. Defensa en profundidad: issue/skill ya vienen
// validados por el caller, pero nunca interpolamos crudo en un RegExp.
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deriva el nº de intento efectivo a partir de los contadores de rebote del
 * YAML del ciclo. Intento base (sin rebotes) = 1.
 *
 * El pulpo trackea tres contadores independientes (`rebote_numero`,
 * `rebote_numero_infra`, `rebote_numero_crossphase`). El intento efectivo es
 * `max(los tres) + 1`.
 *
 * @param {object|null|undefined} yamlData YAML del archivo de trabajo parseado.
 * @returns {number} intento >= 1
 */
function deriveAttemptNumber(yamlData) {
  const d = yamlData || {};
  const n = Math.max(
    Number(d.rebote_numero) || 0,
    Number(d.rebote_numero_infra) || 0,
    Number(d.rebote_numero_crossphase) || 0,
  );
  return (Number.isFinite(n) && n > 0 ? n : 0) + 1;
}

/** Nombre de archivo del log de un intento puntual. */
function attemptLogName(issue, skill, attempt) {
  return `${issue}-${skill}.attempt-${attempt}.log`;
}

/** Nombre del alias del intento vigente (compat con refs existentes de dashboard). */
function aliasLogName(issue, skill) {
  return `${issue}-${skill}.log`;
}

/**
 * Lista los intentos persistidos para `(issue, skill)` derivando de un glob
 * dentro de `logDir` (REQ-SEC-1: NO de input del cliente). Orden ascendente por
 * nº de intento. `skill` debe venir ya validado/allowlisted por el caller.
 *
 * @returns {Array<{intento:number,file:string,bytes:number,mtime:number}>}
 */
function listAttempts(logDir, issue, skill) {
  const rx = new RegExp(`^${escapeRegex(issue)}-${escapeRegex(skill)}\\.attempt-(\\d+)\\.log$`);
  let files;
  try {
    files = fs.readdirSync(logDir);
  } catch {
    return [];
  }
  return files
    .map((f) => {
      const m = f.match(rx);
      return m ? { intento: Number(m[1]), file: f } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.intento - b.intento)
    .map((it) => {
      let bytes = 0;
      let mtime = 0;
      try {
        const st = fs.statSync(path.join(logDir, it.file));
        bytes = st.size;
        mtime = st.mtimeMs;
      } catch { /* archivo borrado en carrera: bytes/mtime quedan en 0 */ }
      return { intento: it.intento, file: it.file, bytes, mtime };
    });
}

/**
 * Lista las ejecuciones históricas para `(issue, skill)` que consume el
 * dashboard. Deriva del glob `listAttempts`, con FALLBACK al alias
 * `${issue}-${skill}.log` cuando no hay archivos `attempt-N` — así los issues
 * que completaron ANTES de #4444 (que sólo tienen el alias, sin per-intento)
 * siguen exponiendo su único log (CA-F6). Orden ascendente por intento.
 *
 * @returns {Array<{intento:number,file:string,bytes:number,mtime:number,legacy?:boolean}>}
 */
function listExecutions(logDir, issue, skill) {
  const attempts = listAttempts(logDir, issue, skill);
  if (attempts.length > 0) return attempts;
  // Fallback legacy: alias del intento vigente sin per-intento persistido.
  const alias = aliasLogName(issue, skill);
  try {
    const st = fs.statSync(path.join(logDir, alias));
    return [{ intento: 1, file: alias, bytes: st.size, mtime: st.mtimeMs, legacy: true }];
  } catch {
    return [];
  }
}

/**
 * Resuelve la config de retención con defaults conservadores.
 * @param {object} [raw] sección `logs_history` de config.yaml
 */
function resolveRetentionConfig(raw) {
  const c = raw || {};
  const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : def);
  return {
    enabled: c.enabled !== false,
    // Máx. de intentos retenidos por `(issue, skill)`. Sobre eso se podan los más viejos.
    max_attempts_per_agent: num(c.max_attempts_per_agent, 20),
    // Tope de bytes servidos por request en el endpoint de log completo (anti-DoS).
    max_bytes_per_log: num(c.max_bytes_per_log, 5 * 1024 * 1024),
    // TTL de retención en días. 0 = sin TTL.
    retention_days: num(c.retention_days, 30),
  };
}

/**
 * Poda intentos viejos de un `(issue, skill)` según la política de retención:
 *   - por overflow de `max_attempts_per_agent` (borra los más viejos primero),
 *   - por antigüedad > `retention_days` (si > 0).
 * NUNCA borra el intento vigente (el de mayor número). Best-effort: los errores
 * de unlink no tiran.
 *
 * @returns {string[]} nombres de archivos borrados.
 */
function pruneAttempts(logDir, issue, skill, cfg, now = Date.now()) {
  const conf = resolveRetentionConfig(cfg);
  if (!conf.enabled) return [];
  const attempts = listAttempts(logDir, issue, skill);
  if (attempts.length <= 1) return [];

  // Preservar siempre el intento vigente (mayor número = último de la lista ordenada).
  const vigente = attempts[attempts.length - 1];
  const candidatos = attempts.slice(0, -1);
  const aBorrar = new Set();

  // 1) Overflow de cantidad: borrar los más viejos hasta cumplir el tope.
  const overflow = attempts.length - conf.max_attempts_per_agent;
  if (overflow > 0) {
    for (const it of candidatos.slice(0, overflow)) aBorrar.add(it.file);
  }

  // 2) TTL por antigüedad (nunca el vigente).
  if (conf.retention_days > 0) {
    const cutoff = now - conf.retention_days * 24 * 60 * 60 * 1000;
    for (const it of candidatos) {
      if (it.mtime > 0 && it.mtime < cutoff) aBorrar.add(it.file);
    }
  }

  const removed = [];
  for (const file of aBorrar) {
    if (file === vigente.file) continue; // defensa redundante
    try {
      fs.unlinkSync(path.join(logDir, file));
      removed.push(file);
    } catch { /* ya no existe o permiso: ignorar */ }
  }
  return removed;
}

/**
 * Lee un log con tope de bytes por request (REQ-SEC-4). Devuelve la COLA del
 * archivo (los últimos `maxBytes`), que es lo relevante para auditar el cierre
 * de un intento; si se truncó, antepone un marcador legible.
 *
 * @returns {{ text:string, truncated:boolean, totalBytes:number }}
 */
function readLogCapped(logPath, maxBytes) {
  const cap = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
    ? Number(maxBytes)
    : 5 * 1024 * 1024;
  const st = fs.statSync(logPath);
  const total = st.size;
  if (total <= cap) {
    return { text: fs.readFileSync(logPath, 'utf8'), truncated: false, totalBytes: total };
  }
  const start = total - cap;
  const fd = fs.openSync(logPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(cap);
    fs.readSync(fd, buf, 0, cap, start);
    const omitidos = start;
    const marker = `--- [log recortado: se omitieron ${omitidos} bytes iniciales de ${total} totales; mostrando los últimos ${cap} bytes por política de retención] ---\n`;
    return { text: marker + buf.toString('utf8'), truncated: true, totalBytes: total };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  deriveAttemptNumber,
  attemptLogName,
  aliasLogName,
  listAttempts,
  listExecutions,
  resolveRetentionConfig,
  pruneAttempts,
  readLogCapped,
};
