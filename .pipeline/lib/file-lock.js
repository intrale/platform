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
// El archivo se crea con `O_CREAT | O_EXCL` (`fs.openSync(path, 'wx')`), atómico
// en POSIX y Windows. Si dos procesos llegan a la vez, solo uno gana — el otro
// recibe `EEXIST` y reintenta con backoff.
//
// Stale detection (security req #1 + #6145)
// ----------------------------------------------------------------
// Reclamar un lock ajeno es ROBARLO: si el holder sigue vivo, los dos procesos
// escriben sobre la misma base y uno pisa al otro en silencio. Por eso las tres
// ramas de reclamo son conservadoras y ninguna reclama por una sola señal:
//
//   (a) PID no existe (sonda ESRCH) Y el lock tiene > DEAD_PID_GRACE_MS (2s)
//       Y una SEGUNDA sonda lo confirma. Éste es el camino de recuperación
//       tras un crash del holder.
//   (b) lock ilegible/vacío (`_corrupt`) Y > 60s de antigüedad — un lock vacío
//       más joven se asume "creación en curso" (#3735).
//   (c) PID vive PERO el lock tiene > 60s Y la heurística (startTime) sugiere
//       que el PID fue reciclado.
//
// La sonda de PID es FAIL-CLOSED (#6145): sólo ESRCH prueba que el proceso no
// existe; cualquier otro código de error significa "no pude preguntar" y se
// asume vivo. Ver el comentario largo en `isPidAlive()`.
//
// Verificación de salida (#6145)
// ------------------------------
// `withLock`/`withLockSync` comprueban al terminar `fn()` que el lock sigue
// siendo nuestro. Si no lo es, la exclusión mutua fue violada y tiran
// `ELOCK_STOLEN` en vez de reportar éxito sobre una escritura posiblemente
// pisada. Fail-closed: preferimos perder el write a corromper en silencio.
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
// #6145 — Gracia mínima antes de reclamar un lock cuyo PID se leyó como MUERTO.
// Un holder que crashea deja su lock y hay que recuperarlo (por eso no usamos
// los 60s de STALE_AGE_MS acá: bloquearía el control plane demasiado tiempo).
// Pero una sonda de PID que responde mal sobre un lock recién creado roba el
// lock a un holder VIVO. 2s separan las dos cosas: un crash real se recupera
// dentro del presupuesto de timeout (5s default, 15s en waves), y un lock de
// milisegundos nunca se roba por una lectura dudosa.
const DEAD_PID_GRACE_MS = 2000;
const POSIX_LOCK_MODE = 0o600;   // -rw-------
const LOCK_CONTENTION_CODES = new Set(['EEXIST', 'EBUSY', 'EPERM', 'EACCES']);

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

// Buffer compartido (4 bytes) reutilizado por sleepSync. Es de solo lectura para
// nuestro uso (nunca hacemos Atomics.notify), así que un único buffer global
// alcanza — Atomics.wait sobre un valor que nunca cambia siempre retorna
// 'timed-out' tras el tiempo pedido.
const SLEEP_SHARED = new Int32Array(new SharedArrayBuffer(4));

/**
 * Sleep SÍNCRONO que CEDE la CPU (a diferencia de un busy-wait `while`).
 *
 * Causa raíz que esto elimina (rebote #3961 / regresión CA-8 #3518)
 * ----------------------------------------------------------------------
 * El backoff sync previo era un busy-wait (`while (Date.now() < deadline) {}`)
 * que NO libera el core. Bajo fork-storm (la suite forkea ~375 files + 10
 * workers de waves-concurrency en paralelo) la CPU se satura: los N
 * contendientes giran en busy-wait quemando ciclos y el holder del lock NUNCA
 * se schedulea para terminar su read-modify-write y liberar. Resultado: la
 * mayoría timeoutea a los 5000ms (ELOCK_TIMEOUT → worker exit 1) y la cuota de
 * éxito cae por debajo del 50% que tolera el test (síntoma: "solo 4/10
 * workers exitosos").
 *
 * `Atomics.wait` bloquea el hilo de forma cooperativa (el SO puede schedulear
 * al holder), sin SharedArrayBuffer compartido entre procesos ni notify: lo
 * usamos puramente como "sleep que cede CPU". En Node está permitido sobre el
 * main thread (a diferencia del browser). Si por alguna razón no estuviera
 * disponible, caemos al busy-wait original (degradación, no rotura).
 */
function sleepSync(ms) {
    if (!(ms > 0)) return;
    try {
        Atomics.wait(SLEEP_SHARED, 0, 0, ms);
    } catch {
        // Fallback defensivo: busy-wait acotado si Atomics.wait no está disponible.
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) { /* busy wait */ }
    }
}

// Contador por proceso para nombres de tmp únicos (JS es single-thread, así
// que un counter + pid + random alcanza para no colisionar entre procesos).
let lockTmpSeq = 0;

/**
 * Construye el meta del lock para el proceso actual.
 */
function buildLockMeta() {
    return {
        pid: process.pid,
        startTime: PROCESS_START_ISO,
        hostname: os.hostname(),
        version: LOCK_SCHEMA_VERSION,
        acquired_at: new Date().toISOString(),
    };
}

/**
 * Crea el lock de forma ATÓMICA con su contenido ya escrito — sin ventana de
 * archivo vacío.
 *
 * Causa raíz que esto elimina (rebote #3731 / regresión #3518 CA-8)
 * ---------------------------------------------------------------------
 * El patrón previo `openSync(lockPath,'wx')` + `writeSync(meta)` deja el
 * archivo de lock VACÍO entre la creación y la escritura del meta. Bajo
 * saturación de CPU (N workers en busy-wait), el holder puede tardar > 1s en
 * escribir el meta; durante esa ventana otro contendiente lee el archivo como
 * `_corrupt` (sin pid), lo considera stale por antigüedad y lo UNLINKEA —
 * robándole el lock a un holder vivo. Resultado: dos procesos creen tener el
 * lock → lost-update (workers salen 0 pero su write se pisa).
 *
 * Estrategia: escribir el meta completo a un tmp único y luego `linkSync` el
 * tmp al lockPath. `linkSync` (hard link) es atómico y tira EEXIST si el
 * destino ya existe — misma garantía de exclusión mutua que `openSync('wx')`,
 * pero el archivo de lock SIEMPRE aparece con contenido completo. Nunca hay
 * estado `_corrupt` para un lock vivo.
 *
 * @returns {boolean} true si creamos el lock, false si ya existía (EEXIST).
 */
function atomicCreateLock(lockPath, meta) {
    const tmp = `${lockPath}.tmp-${process.pid}-${++lockTmpSeq}-${crypto.randomBytes(4).toString('hex')}`;
    let fd;
    try {
        fd = fs.openSync(tmp, 'wx', POSIX_LOCK_MODE);
        try {
            fs.writeSync(fd, JSON.stringify(meta));
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
    } catch (err) {
        // El tmp lleva pid+seq+random; una colisión es esencialmente imposible.
        try { fs.unlinkSync(tmp); } catch {}
        throw err;
    }
    try {
        fs.linkSync(tmp, lockPath); // atómico; EEXIST si el lock ya está tomado
        return true;
    } catch (err) {
        // En Windows el antivirus/indexador puede retener por milisegundos el
        // tmp o el destino y `linkSync` responde EBUSY/EPERM/EACCES. Esos
        // códigos representan contención transitoria igual que EEXIST: el loop
        // exterior conserva el timeout y el jitter, sin perder fail-closed.
        if (err && LOCK_CONTENTION_CODES.has(err.code)) return false;
        throw err;
    } finally {
        // El lock vive bajo lockPath (hard link al mismo inode); el tmp ya no
        // hace falta. Si falla el unlink, queda un huérfano inofensivo.
        try { fs.unlinkSync(tmp); } catch {}
    }
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
 * Verifica si un PID está vivo con `process.kill(pid, 0)` (en Windows Node lo
 * mapea a OpenProcess + check).
 *
 * FAIL-CLOSED (#6145): sólo `ESRCH` prueba que el proceso no existe. Cualquier
 * otro código de error (EPERM, EACCES, ENOMEM, EMFILE, EINVAL, UNKNOWN…)
 * significa "la sonda no pudo responder" y devuelve `true`. Un falso "vivo"
 * sólo retrasa la recuperación de un lock huérfano; un falso "muerto" le roba
 * el lock a un holder activo y corrompe el estado en silencio.
 *
 * @returns {boolean} true si vive o no se pudo determinar; false sólo con ESRCH.
 */
function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // #6145 (regresión CA-8 #3518, tercera vuelta) — FAIL-CLOSED.
        //
        // Causa raíz del rebote: el `return false` catch-all de antes hacía que
        // CUALQUIER código distinto de ESRCH/EPERM se leyera como "el holder
        // está muerto". `isStale()` reclamaba entonces el lock SIN chequeo de
        // antigüedad, y el contendiente unlinkeaba el lock de un holder VIVO
        // que acababa de crearlo → dual-hold → los dos procesos hacen su
        // read-modify-write sobre la misma base y el segundo pisa al primero.
        // Los dos salen con código 0 y el write perdido no deja rastro
        // (síntoma observado: `issues=5, exitosos=10` — 10 workers exit 0 y 5
        // writes clobbereados).
        //
        // Por qué pega en Windows y no en el test aislado: `process.kill(pid, 0)`
        // baja a `OpenProcess()`. Bajo fork-storm de la suite completa (~375
        // archivos de test en paralelo, batches de `node --test`) esa llamada
        // falla de formas variadas y transitorias que NO son ESRCH —
        // EACCES/ENOMEM/EMFILE/EINVAL/UNKNOWN según presión de handles,
        // antivirus o indexador. Todas caían en el catch-all.
        //
        // Regla nueva: sólo ESRCH PRUEBA que el proceso no existe. Todo lo
        // demás es "la sonda no pudo responder" y se trata como VIVO. El costo
        // del fail-closed es un lock huérfano que tarda un poco más en
        // recuperarse (lo cubre el umbral de antigüedad); el costo del
        // fail-open era corromper el estado en silencio.
        if (err && err.code === 'ESRCH') return false;
        return true;
    }
}

/**
 * Antigüedad del archivo de lock en ms, o `null` si no se puede stat-ear
 * (típicamente porque ya no existe).
 */
function readLockAgeMs(lockPath) {
    try {
        return Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
        return null;
    }
}

/**
 * Devuelve true si el lock referenciado por `meta` se considera stale.
 *
 * Requiere ambas condiciones (security req #1):
 *   - meta._corrupt === true Y el lock tiene > STALE_AGE_MS (#3735), O
 *   - (PID no vive Y el lock tiene > DEAD_PID_GRACE_MS Y una segunda sonda lo
 *     confirma — #6145), O
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
        // #3735 (regresión CA-8 #3518): el umbral original de 1s era demasiado
        // agresivo. Bajo fork-storm extremo (la suite completa forkea 252 files
        // y satura la CPU), el holder puede quedar descheduleado MÁS de 1s entre
        // el `openSync('wx')` y el `writeSync(meta)`. Otro acquirer veía el lock
        // vacío con mtime > 1s, lo declaraba stale, lo borraba y entraba en
        // paralelo → dual-hold → lost-update silencioso (síntoma observado:
        // `issues=2, exitosos=7` — 7 workers exit 0 pero 5 writes clobbered).
        //
        // Fix: usar el MISMO umbral conservador (STALE_AGE_MS = 60s) que para un
        // PID vivo. Un lock vacío más joven que 60s se trata como creación en
        // curso → el acquirer espera/reintenta. Si el holder estaba simplemente
        // descheduleado, termina su write en ms y el acquirer entra normal; si
        // el holder crasheó EXACTO en esa ventana (probabilidad ínfima), el
        // acquirer falla fuerte con ELOCK_TIMEOUT (exit 1, contado como NO
        // exitoso) en vez de clobberear en silencio, y el próximo intento lo
        // recupera por antigüedad > 60s. Nunca más lost-update silencioso.
        let lockMtimeMs;
        try { lockMtimeMs = fs.statSync(lockPath).mtimeMs; } catch { return true; }
        const lockAgeMs = Date.now() - lockMtimeMs;
        if (lockAgeMs < STALE_AGE_MS) return false; // creación en curso, NO stale
        return true;
    }
    if (!isPidAlive(meta.pid)) {
        // #6145 — El reclamo por PID muerto es el camino legítimo de
        // recuperación tras un crash del holder, pero era el ÚNICO de los tres
        // que reclamaba SIN mirar la antigüedad del lock: una sola lectura
        // dudosa sobre un lock de milisegundos alcanzaba para robárselo a un
        // holder vivo. Con `isPidAlive` fail-closed eso ya es mucho más raro;
        // estas dos guardas lo vuelven inalcanzable en la práctica.
        const ageMs = readLockAgeMs(lockPath);
        // El lock ya no está (lo liberó o lo reclamó otro): no hay nada que
        // proteger y el acquirer reintenta el create igual.
        if (ageMs === null) return true;
        // Guarda 1 — antigüedad: un lock más joven que la gracia NO se reclama.
        // Un holder que crashea deja el lock quieto y se recupera a los 2s; un
        // holder vivo que acaba de crearlo nunca lo pierde.
        if (ageMs < DEAD_PID_GRACE_MS) return false;
        // Guarda 2 — segunda sonda: si la primera lectura fue transitoria, ésta
        // la contradice y el lock se respeta. Cuesta un syscall y sólo corre en
        // el camino de reclamo (nunca en el camino caliente).
        if (isPidAlive(meta.pid)) return false;
        return true;
    }

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
 * Adquiere atómicamente el lock. Devuelve `{ acquired: true, reentrant: bool }`
 * o tira excepción si no pudo en el timeout configurado.
 *
 * Estrategia:
 *   1. Intenta `fs.openSync(lockPath, 'wx')`.
 *   2. Si éxito: escribe meta + cierra fd → lock adquirido.
 *   3. Si EEXIST: lee meta del holder. Si es ours (mismo pid+startTime),
 *      retorna reentrant. Si es stale → unlink + reintentar. Si está vivo →
 *      esperar (jitter) y reintentar hasta agotar.
 */
/**
 * Variante síncrona de acquireLock. Misma lógica que la async pero usando
 * busy-wait corto para el jitter. Ideal para callsites que históricamente
 * eran sync (ej. partial-pause.setPartialPause) y romperían contrato al
 * convertirse en async.
 *
 * Espera: usa `sleepSync` (Atomics.wait) que CEDE la CPU entre reintentos en
 * vez de un busy-wait. Esto es clave bajo contención de N workers + CPU
 * saturada (fork-storm de la suite): el busy-wait original starvaba al holder
 * del lock y disparaba ELOCK_TIMEOUT espurios (rebote #3961, CA-8 #3518). Con
 * sleep cooperativo el holder se schedulea, termina su write y libera, y los
 * contendientes convergen dentro del timeout.
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
        try {
            if (atomicCreateLock(lockPath, buildLockMeta())) {
                return { acquired: true, reentrant: false, lockPath };
            }
            // EEXIST: el lock ya está tomado. Decidir reentrancia / stale / espera.
            lastErr = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
            const holder = readLockMeta(lockPath);
            if (holder && holder.pid === process.pid && holder.startTime === PROCESS_START_ISO) {
                return { acquired: true, reentrant: true, lockPath };
            }
            if (isStale(holder, lockPath)) {
                try { fs.unlinkSync(lockPath); } catch {}
                continue;
            }
            attempts++;
            // Bound el wait por lo que reste del timeout para no excederlo.
            const remaining = timeoutMs - (Date.now() - startedAt);
            if (remaining <= 0) break;
            const wait = Math.min(jitter(50, 200), remaining);
            // Sleep que CEDE la CPU (no busy-wait): permite que el SO schedulee
            // al holder del lock para que termine su write y libere. Ver
            // sleepSync (rebote #3961).
            sleepSync(wait);
            continue;
        } catch (err) {
            lastErr = err;
            throw err;
        }
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
    let ret;
    try {
        ret = fn();
        // #6145 — verificación de propiedad al salir de la sección crítica.
        // En reentrancia no corresponde: el frame externo es el dueño y hará
        // su propia verificación al terminar.
        if (!acquisition.reentrant) {
            assertStillOwned(filePath, component, opts);
        }
    } finally {
        if (!acquisition.reentrant) {
            releaseLock(filePath);
        }
    }
    return ret;
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
        try {
            if (atomicCreateLock(lockPath, buildLockMeta())) {
                return { acquired: true, reentrant: false, lockPath };
            }
            // EEXIST: el lock ya está tomado.
            lastErr = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
            const holder = readLockMeta(lockPath);
            if (holder && holder.pid === process.pid && holder.startTime === PROCESS_START_ISO) {
                // Reentrancia: ya teníamos el lock. No volvemos a tocarlo.
                return { acquired: true, reentrant: true, lockPath };
            }
            if (isStale(holder, lockPath)) {
                logWarn(`Lock stale detectado en ${lockPath} (holder pid=${holder && holder.pid}). Removiendo.`);
                try { fs.unlinkSync(lockPath); } catch {}
                continue; // retry inmediato
            }
            // Holder vivo — esperar con jitter y reintentar.
            attempts++;
            const remaining = timeoutMs - (Date.now() - startedAt);
            if (remaining <= 0) break;
            const wait = Math.min(jitter(50, 200), remaining);
            await new Promise((r) => setTimeout(r, wait));
            continue;
        } catch (err) {
            // Errores no-EEXIST (EPERM, EACCES, ENOSPC, etc.) — abortar.
            lastErr = err;
            throw err;
        }
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
/**
 * #6145 — ¿Seguimos siendo dueños del lock?
 *
 * Tercera capa de defensa. Las dos anteriores (`isPidAlive` fail-closed y la
 * gracia del reclamo por PID muerto) evitan que nos roben el lock. Ésta detecta
 * el robo si igual llegara a pasar: cuando `fn()` termina, comparamos el
 * contenido del lock contra nuestra identidad.
 *
 * Por qué importa: sin esto, un dual-hold termina en un write pisado que NADIE
 * observa — el proceso que perdió su escritura sale con código 0 y reporta
 * éxito. Con esto, la exclusión mutua violada se convierte en un error tipado
 * (`ELOCK_STOLEN`) y el caller falla fuerte en vez de mentir. Fail-closed es la
 * política correcta para el control plane: preferimos perder el write a
 * corromper el estado en silencio.
 *
 * Es CONSERVADOR: sólo reporta robo cuando puede PROBARLO (el lock no está, o
 * declara a otro holder). Si el lock no se puede leer por un error transitorio,
 * `readLockMeta` ya devuelve `_corrupt` y lo tratamos como robo sólo porque a
 * esta altura nuestro propio meta debería estar ahí íntegro.
 *
 * @returns {{ owned: boolean, reason?: string, holder?: object }}
 */
function checkStillOwned(filePath) {
    const lockPath = lockPathOf(filePath);
    const meta = readLockMeta(lockPath);
    if (!meta) {
        return { owned: false, reason: 'el archivo de lock desapareció mientras lo teníamos', holder: null };
    }
    if (meta._corrupt) {
        return { owned: false, reason: 'el archivo de lock quedó ilegible mientras lo teníamos', holder: null };
    }
    if (meta.pid === process.pid && meta.startTime === PROCESS_START_ISO) {
        return { owned: true };
    }
    return {
        owned: false,
        reason: `el lock fue tomado por otro holder (pid=${meta.pid}, host=${meta.hostname || '?'})`,
        holder: meta,
    };
}

/**
 * Verifica la propiedad del lock al salir de la sección crítica y tira
 * `ELOCK_STOLEN` si la exclusión mutua fue violada.
 *
 * Se puede desactivar con `opts.verifyOwnership === false` para call sites que
 * prefieran la semántica vieja (best-effort silencioso). Default: ACTIVO.
 */
function assertStillOwned(filePath, component, opts) {
    if (opts && opts.verifyOwnership === false) return;
    const st = checkStillOwned(filePath);
    if (st.owned) return;
    const msg = `exclusión mutua violada sobre ${path.basename(filePath)}: ${st.reason}. `
        + 'La escritura hecha bajo este lock pudo haberse pisado con la de otro proceso.';
    if (opts && typeof opts.notify === 'function') {
        try {
            opts.notify({
                level: 'error',
                component: component || 'file-lock',
                message: `lock robado durante la sección crítica sobre ${path.basename(filePath)}`,
                diag: `cat ${lockPathOf(filePath)}`,
                detail: msg,
                holder: st.holder || null,
            });
        } catch { /* notify es best-effort: nunca puede tapar el error real */ }
    }
    const e = new Error(`withLock: ${msg}`);
    e.code = 'ELOCK_STOLEN';
    e.lockPath = lockPathOf(filePath);
    e.holder = st.holder || null;
    throw e;
}

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

    let ret;
    try {
        ret = await fn();
        if (!acquisition.reentrant) {
            // #6145 — misma verificación que en withLockSync (ver assertStillOwned).
            assertStillOwned(filePath, component, opts);
        }
    } finally {
        // En reentrancia, NO liberamos: el frame externo lo hará.
        if (!acquisition.reentrant) {
            releaseLock(filePath);
        }
    }
    return ret;
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
        readLockAgeMs,
        checkStillOwned,
        DEAD_PID_GRACE_MS,
        lockPathOf,
        PROCESS_START_ISO,
        LOCK_SCHEMA_VERSION,
        STALE_AGE_MS,
        LOCK_CONTENTION_CODES,
        POSIX_LOCK_MODE,
    },
};
