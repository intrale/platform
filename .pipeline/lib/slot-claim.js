// =============================================================================
// slot-claim.js — Primitivas atómicas para cerrar dos TOCTOU del orquestador
// (issue #3939, épica EP-5 #3937):
//
//   1. claim-by-rename: propiedad exclusiva de un work file en `pendiente/`
//      antes de operar sobre él (usado en `reencolarInfraBloqueados`).
//   2. reserva atómica de slot: conteo + move+spawn dentro de una sección
//      crítica por skill, para no superar `maxConcurrencia` (brazo de
//      lanzamiento).
//   3. sweep de claims huérfanos: restaurar `*.claimed-<pid>` dejados por un
//      proceso muerto, reusando la heurística PID+startTime de `file-lock`.
//
// Diseño
// ------
//   - Cero deps npm — solo `fs`, `path` del core y `lib/file-lock`.
//   - `fs.renameSync` es atómico en POSIX y Windows: gana un solo proceso, el
//     perdedor recibe `ENOENT`/`EEXIST`. Misma garantía que `moveFile`
//     (`pulpo.js:986`).
//   - La fuente de verdad DURABLE sigue siendo el filesystem (`trabajando/`).
//     El lock de slot solo cierra la ventana de admisión entre el conteo y el
//     move — no mantiene estado de vida del agente.
//   - Inyección de `fsImpl`/`fl`/`now` para tests sin tocar disco real.
//
// Seguridad (requisitos del issue #3939)
// --------------------------------------
//   - CWE-22/CWE-59: `claimPath` se construye SOLO por template sobre el path
//     ya validado (proviene de `listWorkFiles`, confinado a `pendiente/`).
//     Nunca se deriva el sufijo de contenido no sanitizado del work file.
//   - CWE-367 (PID reciclado): el sweep reusa `file-lock._internal.isPidAlive`
//     + `STALE_AGE_MS`, NO un simple "¿el PID existe?".
//   - CWE-404/CWE-772 (self-DoS): la reserva usa `withLockSync`, que libera el
//     lock SIEMPRE en su `finally` interno (nunca `acquireLockSync` suelto).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const fileLock = require('./file-lock');

// Patrón de un archivo de claim: `<nombreCanonico>.claimed-<pid>`.
const CLAIM_RE = /^(.+)\.claimed-(\d+)$/;

/**
 * Reclama propiedad exclusiva de `filePath` renombrándolo a
 * `<filePath>.claimed-<pid>`.
 *
 * ⚠ EXCLUSIVIDAD REAL VÍA `file-lock`, NO vía el retorno de `renameSync`.
 * ----------------------------------------------------------------------------
 * En Windows (entorno target del proyecto) el valor de retorno de
 * `fs.renameSync` NO es una señal confiable de exclusión bajo concurrencia
 * real: se verificó empíricamente (8 procesos hijo alineados por IPC) que
 * VARIOS procesos reciben "éxito" para el mismo `source` aunque el filesystem
 * termina con un solo archivo físico. Confiar en `ENOENT`/`EEXIST` del rename
 * dejaría a 2+ procesos creyéndose dueños → doble reencolado (el TOCTOU que
 * este issue cierra). La decisión de ownership la toma `file-lock`
 * (`linkSync` atómico, exactamente-uno en 8/8 trials), y el rename se ejecuta
 * DENTRO de la sección crítica.
 *
 * @param {string} filePath — path del work file (ya validado/confinado).
 * @param {number} pid — pid del proceso que reclama (process.pid).
 * @param {object} [opts]
 * @param {object} [opts.fsImpl=fs] — inyectable para tests.
 * @param {object} [opts.fl=fileLock] — inyectable para tests.
 * @param {number} [opts.timeoutMs=2000] — acotado (anti self-DoS).
 * @returns {{claimed: boolean, claimPath?: string, reason?: string}}
 *   - `{ claimed: true, claimPath }` si ganó la sección crítica.
 *   - `{ claimed: false, reason: 'ENOENT'|'EEXIST' }` si otro proceso lo tomó.
 */
function claimByRename(filePath, pid, opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const fl = opts.fl || fileLock;
  const timeoutMs = opts.timeoutMs || 2000;
  // CWE-22/CWE-59: el sufijo es un template sobre `filePath`, sin datos del
  // contenido del work file. Confinado al mismo directorio.
  const claimPath = `${filePath}.claimed-${pid}`;
  let result = { claimed: false, reason: 'ENOENT' };
  fl.withLockSync(filePath, () => {
    if (!fsImpl.existsSync(filePath)) {
      // Otro proceso ya lo reclamó (lo renombró) antes de que ganáramos el lock.
      result = { claimed: false, reason: 'ENOENT' };
      return;
    }
    try {
      fsImpl.renameSync(filePath, claimPath);
      result = { claimed: true, claimPath };
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'EEXIST')) {
        result = { claimed: false, reason: e.code };
        return;
      }
      throw e;
    }
  }, { timeoutMs, component: 'slot-claim' });
  return result;
}

/**
 * Restaura un archivo reclamado a su nombre canónico (best-effort).
 * No-op si el claim ya no existe.
 *
 * @returns {boolean} true si restauró.
 */
function restoreClaim(claimPath, canonicalPath, fsImpl = fs) {
  try {
    if (!fsImpl.existsSync(claimPath)) return false;
    if (fsImpl.existsSync(canonicalPath)) {
      // Ya hay un canónico (otro proceso lo restauró/reencoló) → descartar el
      // claim para no pisarlo.
      try { fsImpl.unlinkSync(claimPath); } catch {}
      return false;
    }
    fsImpl.renameSync(claimPath, canonicalPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reserva atómica de un slot por skill. Ejecuta `onAcquired()` SOLO si, dentro
 * de la sección crítica, `countFn() < max`. El lock se libera siempre
 * (semántica de `withLockSync`).
 *
 * @param {string} slotLockFile — path base del lock (`.lock` se deriva).
 * @param {object} opts
 * @param {number} opts.max — tope de concurrencia del skill.
 * @param {() => number} opts.countFn — conteo observacional (trabajando/).
 * @param {() => void} opts.onAcquired — move+spawn; corre dentro del lock.
 * @param {number} [opts.timeoutMs=2000] — acotado para no frenar el tick.
 * @param {object} [opts.fl=fileLock] — inyectable para tests.
 * @param {(payload:object)=>void} [opts.notify] — alerta en fallo de lock.
 * @returns {boolean} true si reservó y lanzó.
 */
function reserveSlot(slotLockFile, opts) {
  const {
    max,
    countFn,
    onAcquired,
    timeoutMs = 2000,
    fl = fileLock,
    notify,
  } = opts;
  let launched = false;
  fl.withLockSync(
    slotLockFile,
    () => {
      // Re-check AUTORITATIVO dentro del lock: cierra la ventana TOCTOU entre
      // el conteo y el move+spawn. `trabajando/` es la fuente de verdad.
      if (countFn() >= max) return;
      onAcquired();
      launched = true;
    },
    { timeoutMs, component: 'slot-claim', notify },
  );
  return launched;
}

/**
 * Barre claims huérfanos (`*.claimed-<pid>`) en una lista de directorios y los
 * restaura al nombre canónico SOLO si el PID no está vivo o el claim supera
 * `STALE_AGE_MS` (CWE-367: un PID reciclado no debe revivir un huérfano).
 *
 * Un `*.claimed-<pid-vivo>` reciente NO se toca.
 *
 * @param {string[]} dirs — directorios a barrer (ej. todos los `pendiente/`).
 * @param {object} [opts]
 * @param {object} [opts.fsImpl=fs]
 * @param {object} [opts.fl=fileLock]
 * @param {() => number} [opts.now=Date.now]
 * @param {(msg:string)=>void} [opts.log]
 * @returns {{restored: number, discarded: number, skipped: number}}
 */
function sweepOrphanClaims(dirs, opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const fl = opts.fl || fileLock;
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const staleAgeMs = fl._internal.STALE_AGE_MS;

  let restored = 0;
  let discarded = 0;
  let skipped = 0;

  for (const dir of dirs) {
    let entries;
    try { entries = fsImpl.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const m = CLAIM_RE.exec(name);
      if (!m) continue;
      const canonicalName = m[1];
      const pid = parseInt(m[2], 10);
      const claimPath = path.join(dir, name);

      let ageMs = Infinity;
      try { ageMs = now() - fsImpl.statSync(claimPath).mtimeMs; } catch { continue; }

      // No tocar un claim VIVO y RECIENTE — pertenece a un proceso en curso.
      if (fl._internal.isPidAlive(pid) && ageMs < staleAgeMs) {
        skipped++;
        continue;
      }

      const canonicalPath = path.join(dir, canonicalName);
      try {
        if (fsImpl.existsSync(canonicalPath)) {
          // Ya hay un canónico → el huérfano es redundante, descartarlo.
          fsImpl.unlinkSync(claimPath);
          discarded++;
          log(`claim huérfano ${name} descartado (canónico ya existe)`);
        } else {
          fsImpl.renameSync(claimPath, canonicalPath);
          restored++;
          log(`claim huérfano ${name} (pid ${pid}, age ${Math.round(ageMs / 1000)}s) restaurado a ${canonicalName}`);
        }
      } catch (e) {
        log(`error barriendo claim huérfano ${name}: ${e.message}`);
      }
    }
  }

  return { restored, discarded, skipped };
}

module.exports = {
  claimByRename,
  restoreClaim,
  reserveSlot,
  sweepOrphanClaims,
  CLAIM_RE,
};
