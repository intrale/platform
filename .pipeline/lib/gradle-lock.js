'use strict';

// #4155 — Lock global de Gradle del pipeline.
//
// Serializa TODA invocación pesada de Gradle del pipeline (build + tester + …)
// para que NUNCA corran dos builds Gradle pesados en simultáneo (CA-4). El
// incidente del 2026-06-24 dejó la CPU al 100% sostenido porque varios agentes
// (build, tester, devs) invocaban `gradlew` a la vez, cada uno arrastrando JVMs
// de varios GB.
//
// NO reimplementa locking: reusa `lib/file-lock.js` (creación atómica
// `O_CREAT|O_EXCL`, stale-detection de 60s y auto-release en `finally`). Eso
// cubre el requisito de seguridad (CA-5): si un agente crashea sosteniendo el
// lock, el stale-timeout lo libera y la fase de build no queda trabada para
// todos (sin DoS interno).
//
// IMPORTANTE: usa la variante ASYNC `withLock` (no `withLockSync`) porque las
// invocaciones de Gradle (`runGradle`) devuelven Promise; el lock debe
// mantenerse durante todo el `await` y liberarse recién en el `finally`.

const path = require('path');
const fs = require('fs');
const fileLock = require('./file-lock');

// Lock dentro de `.pipeline/locks/` (no en /tmp compartido) — requisito de
// seguridad: el path no debe ser un destino world-writable predecible que
// permita a un proceso ajeno bloquear el pipeline.
const DEFAULT_LOCK_PATH = path.join(__dirname, '..', 'locks', 'gradle-global.lock');

// Espera larga: los builds que no consiguen el lock ENCOLAN, no fallan. El
// trade-off (mayor wall-clock a cambio de no saturar) ya está aceptado en el
// issue. 30 min cubre incluso un `clean build` completo del agente que tiene
// el turno.
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Resuelve el path del lock global. Permite override por env (`GRADLE_LOCK_PATH`)
 * para que los tests aíslen el lock sin tocar el del pipeline real.
 * @returns {string}
 */
function resolveLockPath() {
    return process.env.GRADLE_LOCK_PATH || DEFAULT_LOCK_PATH;
}

/**
 * Ejecuta `fn` bajo el lock global de Gradle. Si otro agente lo tiene tomado,
 * encola (espera hasta `timeoutMs`) en vez de fallar. Libera el lock en
 * `finally`, incluso si `fn` lanza (auto-release, CA-5).
 *
 * @param {() => (Promise<T>|T)} fn — invocación pesada de Gradle a serializar.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] — espera máxima por el turno (default 30 min).
 * @param {(payload: object) => void} [opts.notify] — alerta en fallo de adquisición.
 * @returns {Promise<T>}
 */
async function withGradleLock(fn, opts = {}) {
    const lockPath = resolveLockPath();
    // Asegurar que el directorio del lock exista (file-lock falla con ENOENT si
    // no está). Defensivo: `.pipeline/locks/` se versiona con `.gitkeep`, pero
    // un override de test puede apuntar a un dir nuevo.
    try {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    } catch {
        // mkdir best-effort; si falla, file-lock devolverá el error real.
    }
    return fileLock.withLock(lockPath, fn, {
        component: 'gradle-lock',
        timeoutMs: opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS,
        notify: opts.notify,
    });
}

module.exports = {
    withGradleLock,
    resolveLockPath,
    DEFAULT_LOCK_PATH,
    DEFAULT_TIMEOUT_MS,
};
