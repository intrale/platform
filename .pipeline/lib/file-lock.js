// =============================================================================
// file-lock.js — Lock cooperativo basado en filesystem para writes destructivos
// del control plane (waves.json, .partial-pause.json) — issue #3518.
//
// Diseño
// ------
// Un lock = un archivo `<target>.lock` cuyo CONTENIDO es JSON enriquecido:
//
//   {
//     "pid": 12847,
//     "startTime": "2026-05-26T13:42:18.123Z",   // ISO del proceso holder
//     "hostname": "intrale-host",
//     "version": "1.0",
//     "acquired_at": "2026-05-26T13:42:18.999Z"  // ISO de adquisición
//   }
//
// El archivo se publica vía `linkSync(tmp, lockPath)` (atomic create-if-not-
// exists tanto en POSIX como Windows). El meta se escribe primero a un tmp
// privado y RECIÉN DESPUÉS se publica con el link atómico, así nunca hay una
// ventana donde el lockfile exista visible pero vacío. La estrategia anterior
// (`openSync(path, 'wx')` + `writeSync(meta)`) tenía esa ventana y bajo
// contención CPU severa permitía a otros workers robar el lock pensando que
// estaba corrupto (issue #3721 — CA-8 N=10 workers concurrentes, hardening).
// Si dos procesos llegan a la vez, solo uno gana — el otro recibe `EEXIST`
// y reintenta con backoff.
//
// Stale detection (security req #1, requiere las DOS condiciones)
// ----------------------------------------------------------------
//   (a) PID no existe (process.kill(pid, 0) tira ESRCH), O
//   (b) el archivo de lock tiene > 60s de antigüedad Y la heurística
//       (process.kill(0)+startTime) sugiere que el PID fue reciclado.
//
// Política de reintentos (security req #2)
// -----------------------------------------
//   timeout: 5000ms total (boundary primaria — el loop termina cuando se
//            agota este presupuesto, no antes).
//   max retries: 3 (informativo / soft signal — usado para reporting en el
//                   mensaje de error; el loop NO termina solo por agotarlo).
//   jitter: 50-200ms entre intentos. Bajo contención de N workers, varios
//           reintentos son normales: 10 workers × ~80ms cada uno serializado
//           = ~800ms bajo lock + jitter. El timeout de 5000ms cubre ~50 retries
//           en el peor caso, que es lo que necesitamos para que todos converjan
//           antes de tirar ELOCK_TIMEOUT.
//   en fallo final: notifica Telegram + tira excepción (NUNCA esperar inf).
//
// Permisos (security req #6)
// ---------------------------
//   POSIX: mode 0o600 explícito al crear (no confiar en umask).
//   Windows: el mode lo ignora el SO; ACLs del directorio gobiernan acceso.
//
// API
// ---
//   withLock(filePath, fn, opts?) → Promise<ret> de fn
//     - filePath: ruta del archivo destino (NO el .lock, ese se deriva)
//     - fn: función async que se ejecuta con el lock adquirido
//     - opts: { timeoutMs, maxRetries, notify, lockVersion, onStaleDetected }
//
// Reglas inquebrantables
// ----------------------
//   - Cero deps npm — solo `fs`, `path`, `os`, `crypto` del core.
//   - Liberación siempre en `finally`. Si el unlink falla, log + continúa
//     (otro proceso recuperará el lock por stale-detection eventualmente).
//   - Idempotente: re-adquirir un lock que ya tenemos NO debe deadlockear
//     ni romper. La política es: si encuentra un lock con NUESTRO pid+startTime,
//     entra como reentrancia (sin liberar el lock externo al salir).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Versión interna del schema del lock. Si se rompe el contrato a futuro,
// procesos con versión vieja deben tratarlo como stale (defensivo).
const LOCK_SCHEMA_VERSION = '1.0';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RETRIES = 3;
const STALE_AGE_MS = 60 * 1000; // 60s — umbral de stale post-PID-reuse
const POSIX_LOCK_MODE = 0o600;   // -rw-------

// Cache del startTime del proceso actual (estable hasta exit).
const PROCESS_START_ISO = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

function logWarn(msg) {
    console.warn(`[file-lock] ${msg}`);
}

function logInfo(msg) {
    console.log(`[file-lock] ${msg}`);
}

function lockPathOf(filePath) {
    return filePath + '.lock';
}

function jitter(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Intenta leer + parsear el contenido del lock. Devuelve null si:
 *   - el archivo no existe (ENOENT)
 *   - el contenido no es JSON válido
 *   - el shape no matchea (pid faltante, no-objeto, etc.)
 */
function readLockMeta(lockPath) {
    let raw;
    try {
        raw = fs.readFileSync(lockPath, 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return null;
        logWarn(`No se pudo leer lock ${lockPath}: ${err.message}`);
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        logWarn(`Lock ${lockPath} corrupto: ${err.message}. Tratando como stale.`);
        return { _corrupt: true };
    }
    if (!parsed || typeof parsed !== 'object' || !Number.isInteger(parsed.pid)) {
        return { _corrupt: true };
    }
    return parsed;
}

/**
 * Verifica si un PID está vivo. En POSIX usa `process.kill(pid, 0)`.
 * En Windows también funciona (Node mapea a OpenProcess + check).
 * Devuelve true si vive, false si ESRCH, throws (defensivo) si EPERM
 * (vive pero no podemos señalarlo — lo tratamos como vivo para no romper).
 */
function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        if (err && err.code === 'ESRCH') return false;
        if (err && err.code === 'EPERM') return true; // existe, no podemos firmar
        return false;
    }
}

/**
 * Devuelve true si el lock referenciado por `meta` se considera stale.
 *
 * Requiere ambas condiciones (security req #1):
 *   - meta._corrupt === true, O
 *   - (PID no vive), O
 *   - (PID vive PERO el lock tiene > STALE_AGE_MS Y startTime no matchea
 *     uno de los procesos activos plausibles — heurística para PID reciclado).
 *
 * En la práctica, sin un mecanismo cross-process para enumerar startTime real
 * por PID (sería platform-specific), aproximamos así: si el lock tiene > 60s
 * Y la antigüedad del propio proceso vivo con ese PID es MENOR que la
 * antigüedad del lock, el PID es reciclado → stale.
 *
 * Solo aplica el "PID reciclado" cuando el PID del lock ES nuestro proceso
 * y nuestro startTime difiere. Para PIDs ajenos no tenemos cómo verificar
 * el startTime sin acceso al /proc — caemos a la heurística temporal pura
 * (lock > 60s + PID vivo asumimos NO stale, conservador).
 */
function isStale(meta, lockPath) {
    if (!meta) return false;
    if (meta._corrupt) {
        // CRÍTICO: distinguir "lock corrupto antiguo" de "lock recién creado
        // sin contenido todavía". Hay una ventana entre `openSync('wx')` y
        // `writeSync(meta)` donde otro proceso ve un archivo vacío. Si lo
        // tratamos como stale + unlink, robamos un lock que está siendo
        // adquirido legítimamente por otro proceso → ambos pasan, corrupción.
        //
        // Heurística: si el lock fue modificado hace < 1s, probablemente es
        // un race durante la creación → NO stale (esperar y reintentar).
        let lockMtimeMs;
        try { lockMtimeMs = fs.statSync(lockPath).mtimeMs; } catch { return true; }
        const lockAgeMs = Date.now() - lockMtimeMs;
        if (lockAgeMs < 1000) return false; // race transitoria, no stale
        return true;
    }
    if (!isPidAlive(meta.pid)) return true;

    // PID vive — caso conservador. Solo declarar stale si el lock es VIEJO
    // (>60s) Y se cumple alguna heurística de PID reciclado.
    let lockMtimeMs;
    try {
        lockMtimeMs = fs.statSync(lockPath).mtimeMs;
    } catch {
        return true; // si el lock desapareció, no es ours problem
    }
    const lockAgeMs = Date.now() - lockMtimeMs;
    if (lockAgeMs < STALE_AGE_MS) return false;

    // Si es el mismo PID que el nuestro pero startTime distinto → claramente
    // un PID nuestro fue reciclado o el lock quedó huérfano de una corrida
    // anterior.
    if (meta.pid === process.pid && meta.startTime !== PROCESS_START_ISO) {
        return true;
    }
    return false;
}

/**
 * Adquiere atómicamente el lock vía **linkSync atomic publish** (issue #3721
 * CA-8 hardening). El método anterior usaba `openSync(lockPath, 'wx')` seguido
 * de `writeSync(meta)` — entre esos dos syscalls había una ventana donde el
 * lockfile existía pero estaba vacío. Bajo contención CPU severa (8+ procesos
 * Node spawneados en paralelo en la misma máquina), esa ventana podía exceder
 * el grace de 1s de `isStale`, y otros workers robaban el lock pensando que
 * estaba corrupto. Resultado: lost-update — dos workers terminan corriendo
 * "bajo el lock" simultáneamente.
 *
 * Estrategia nueva:
 *   1. Escribir meta a `<lockPath>.<pid>.<rand>.tmp` (NO visible como lock).
 *   2. `linkSync(tmp, lockPath)` — atómico create-if-not-exists.
 *   3. Unlink tmp.
 *
 * Si linkSync falla con EEXIST → otro proceso tiene el lock (con contenido
 * válido garantizado, porque cualquier publisher pasó por el mismo flujo).
 *
 * Devuelve `{ acquired: true, reentrant: bool }` o tira excepción si no pudo
 * en el timeout configurado.
 */
function _buildMeta() {
    return {
        pid: process.pid,
        startTime: PROCESS_START_ISO,
        hostname: os.hostname(),
        version: LOCK_SCHEMA_VERSION,
        acquired_at: new Date().toISOString(),
    };
}

/**
 * Escribe meta a un tmp file y devuelve el path. El tmp se ubica en el mismo
 * directorio que `lockPath` para que linkSync funcione cross-filesystem
 * (linkSync requiere mismo device).
 */
function _writeMetaTmp(lockPath, meta) {
    const dir = path.dirname(lockPath);
    const base = path.basename(lockPath);
    const tmp = path.join(
        dir,
        `${base}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    const fd = fs.openSync(tmp, 'wx', POSIX_LOCK_MODE);
    try {
        fs.writeSync(fd, JSON.stringify(meta));
        try { fs.fsyncSync(fd); } catch { /* fsync no siempre soportado */ }
    } finally {
        fs.closeSync(fd);
    }
    return tmp;
}

function _cleanupTmp(tmpPath) {
    try { fs.unlinkSync(tmpPath); } catch {}
}

/**
 * Intenta una adquisición atómica. Devuelve uno de:
 *   - { ok: true, reentrant: false }   — adquirido
 *   - { ok: true, reentrant: true }    — ya teníamos el lock
 *   - { ok: false, retry: true }       — holder vivo o tmp falló, reintentar
 *   - { ok: false, retry: false, err } — error no recuperable (propagar)
 */
function _tryAcquireOnce(lockPath) {
    const meta = _buildMeta();
    let tmp;
    try {
        tmp = _writeMetaTmp(lockPath, meta);
    } catch (err) {
        // No deberíamos competir por nuestro tmp único; cualquier error acá
        // (ENOSPC, EACCES sobre directorio, etc) lo propagamos al caller.
        return { ok: false, retry: false, err };
    }
    try {
        fs.linkSync(tmp, lockPath);
        // Éxito atómico — el lockfile tiene nuestro meta desde su nacimiento.
        return { ok: true, reentrant: false };
    } catch (err) {
        if (err && err.code === 'EEXIST') {
            const holder = readLockMeta(lockPath);
            if (holder
                && holder.pid === process.pid
                && holder.startTime === PROCESS_START_ISO) {
                return { ok: true, reentrant: true };
            }
            if (isStale(holder, lockPath)) {
                try { fs.unlinkSync(lockPath); } catch {}
                return { ok: false, retry: true, lastErr: err, stale: true };
            }
            return { ok: false, retry: true, lastErr: err };
        }
        // Errores no-EEXIST (EPERM, EACCES, ENOSPC, etc.) — propagar.
        return { ok: false, retry: false, err };
    } finally {
        _cleanupTmp(tmp);
    }
}

/**
 * Variante síncrona de acquireLock. Misma lógica que la async pero usando
 * busy-wait corto para el jitter. Ideal para callsites que históricamente
 * eran sync (ej. partial-pause.setPartialPause) y romperían contrato al
 * convertirse en async.
 *
 * Costo: el busy-wait ocupa CPU durante la espera. Es aceptable porque:
 *   - jitter máximo es 200ms por intento, max 3 intentos = 600ms peor caso.
 *   - los writes de partial-pause son raros (humano por Telegram).
 *   - alternativas como Atomics.wait requieren SharedArrayBuffer y agregan
 *     complejidad sin beneficio real a esta escala.
 */
function acquireLockSync(filePath, opts) {
    const lockPath = lockPathOf(filePath);
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    // maxRetries es informativo (aparece en el mensaje de error para reporting).
    // El loop NO termina por agotarlo; solo por agotar el budget de timeoutMs.
    // Bajo contención de N workers concurrentes, varios reintentos son esperables
    // y forzar un cap bajo causa lock-starvation espuria (CA-8 regression).
    const maxRetries = opts.maxRetries != null ? opts.maxRetries : DEFAULT_MAX_RETRIES;
    const startedAt = Date.now();
    let attempts = 0;
    let lastErr = null;

    while (Date.now() - startedAt <= timeoutMs) {
        const res = _tryAcquireOnce(lockPath);
        if (res.ok) {
            return { acquired: true, reentrant: res.reentrant, lockPath };
        }
        if (!res.retry) {
            throw res.err;
        }
        lastErr = res.lastErr || res.err || lastErr;
        // Si robamos un lock stale, reintento inmediato sin jitter (la ventana
        // estaba sucia, queremos publicar ya). Si era holder vivo, esperamos.
        if (res.stale) continue;

        attempts++;
        const remaining = timeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) break;
        const wait = Math.min(jitter(50, 200), remaining);
        const deadline = Date.now() + wait;
        while (Date.now() < deadline) { /* busy wait */ }
    }

    const elapsed = Date.now() - startedAt;
    const errMsg = lastErr ? lastErr.message : 'timeout sin error específico';
    const meta = readLockMeta(lockPath) || {};
    const e = new Error(
        `withLockSync: timeout ${timeoutMs}ms tras ${attempts} reintentos (elapsed=${elapsed}ms, maxRetries=${maxRetries}) — `
        + `holder pid=${meta.pid || '?'} host=${meta.hostname || '?'} start=${meta.startTime || '?'}. `
        + `Último error: ${errMsg}`,
    );
    e.code = 'ELOCK_TIMEOUT';
    e.lockPath = lockPath;
    e.holder = meta;
    throw e;
}

/**
 * Wrapper sync. Misma semántica que withLock, pero la función `fn` debe ser
 * síncrona (no Promise). Útil para callsites legacy que históricamente eran
 * sync.
 *
 * @param {string} filePath
 * @param {() => T} fn — función SÍNCRONA
 * @param {object} [opts] — mismas opciones que withLock
 * @returns {T}
 */
function withLockSync(filePath, fn, opts = {}) {
    const component = opts.component || 'file-lock';
    let acquisition;
    try {
        acquisition = acquireLockSync(filePath, opts);
    } catch (err) {
        if (typeof opts.notify === 'function') {
            try {
                opts.notify({
                    level: 'error',
                    component,
                    message: `timeout adquiriendo lock sobre ${path.basename(filePath)}`,
                    diag: `cat ${err.lockPath || filePath + '.lock'}`,
                    detail: err.message,
                    holder: err.holder || null,
                });
            } catch {}
        }
        throw err;
    }
    try {
        return fn();
    } finally {
        if (!acquisition.reentrant) {
            releaseLock(filePath);
        }
    }
}

async function acquireLock(filePath, opts) {
    const lockPath = lockPathOf(filePath);
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    // maxRetries informativo (ver acquireLockSync). El loop usa timeoutMs como
    // boundary primaria; maxRetries solo aparece en el error final para diag.
    const maxRetries = opts.maxRetries != null ? opts.maxRetries : DEFAULT_MAX_RETRIES;
    const startedAt = Date.now();
    let attempts = 0;
    let lastErr = null;

    while (Date.now() - startedAt <= timeoutMs) {
        const res = _tryAcquireOnce(lockPath);
        if (res.ok) {
            return { acquired: true, reentrant: res.reentrant, lockPath };
        }
        if (!res.retry) {
            throw res.err;
        }
        lastErr = res.lastErr || res.err || lastErr;
        if (res.stale) {
            logWarn(`Lock stale detectado en ${lockPath}. Removido + reintento inmediato.`);
            continue; // retry sin jitter
        }
        // Holder vivo — esperar con jitter y reintentar.
        attempts++;
        const remaining = timeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) break;
        const wait = Math.min(jitter(50, 200), remaining);
        await new Promise((r) => setTimeout(r, wait));
    }

    const elapsed = Date.now() - startedAt;
    const errMsg = lastErr ? lastErr.message : 'timeout sin error específico';
    const meta = readLockMeta(lockPath) || {};
    const e = new Error(
        `withLock: timeout ${timeoutMs}ms tras ${attempts} reintentos (elapsed=${elapsed}ms, maxRetries=${maxRetries}) — `
        + `holder pid=${meta.pid || '?'} host=${meta.hostname || '?'} start=${meta.startTime || '?'}. `
        + `Último error: ${errMsg}`,
    );
    e.code = 'ELOCK_TIMEOUT';
    e.lockPath = lockPath;
    e.holder = meta;
    throw e;
}

/**
 * Libera el lock SI Y SOLO SI somos los dueños. No-op si el lock ya no existe
 * o pertenece a otro proceso (no robar locks ajenos).
 */
function releaseLock(filePath) {
    const lockPath = lockPathOf(filePath);
    const meta = readLockMeta(lockPath);
    if (!meta) return false;
    if (meta._corrupt) {
        try { fs.unlinkSync(lockPath); } catch {}
        return true;
    }
    if (meta.pid === process.pid && meta.startTime === PROCESS_START_ISO) {
        try { fs.unlinkSync(lockPath); return true; } catch (err) {
            logWarn(`No se pudo liberar lock ${lockPath}: ${err.message}`);
            return false;
        }
    }
    return false;
}

/**
 * Wrapper principal. Ejecuta `fn` bajo el lock asociado a `filePath` y libera
 * en finally. Si falla la adquisición → llama a `opts.notify` (si está
 * provisto) y propaga la excepción.
 *
 * @param {string} filePath
 * @param {() => (Promise<T>|T)} fn
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000]
 * @param {number} [opts.maxRetries=3]
 * @param {(payload: object) => void} [opts.notify] — invoked en fallo final
 *        con { level, component, message, diag }.
 * @param {string} [opts.component='file-lock']
 * @returns {Promise<T>}
 */
async function withLock(filePath, fn, opts = {}) {
    const component = opts.component || 'file-lock';
    let acquisition;
    try {
        acquisition = await acquireLock(filePath, opts);
    } catch (err) {
        // Alerta Telegram OBLIGATORIA en fallo final (security req #2).
        if (typeof opts.notify === 'function') {
            try {
                opts.notify({
                    level: 'error',
                    component,
                    message: `timeout adquiriendo lock sobre ${path.basename(filePath)}`,
                    diag: `cat ${err.lockPath || filePath + '.lock'}`,
                    detail: err.message,
                    holder: err.holder || null,
                });
            } catch {} // notify NUNCA debe romper la propagación del error real
        }
        throw err;
    }

    try {
        return await fn();
    } finally {
        // En reentrancia, NO liberamos: el frame externo lo hará.
        if (!acquisition.reentrant) {
            releaseLock(filePath);
        }
    }
}

module.exports = {
    withLock,
    withLockSync,
    acquireLock,
    acquireLockSync,
    releaseLock,
    // Helpers expuestos para tests:
    _internal: {
        readLockMeta,
        isPidAlive,
        isStale,
        lockPathOf,
        PROCESS_START_ISO,
        LOCK_SCHEMA_VERSION,
        STALE_AGE_MS,
        POSIX_LOCK_MODE,
    },
};
