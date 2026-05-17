// =============================================================================
// destructive-cooldown.js — Cooldown por-comando-destructivo del Commander
// Issue #3253 · CA-4
//
// Motivación: los comandos destructivos (/restart, /limpiar, /ghostbusters)
// pueden disparar acciones costosas o intrusivas (matar daemons, reiniciar
// servicios). Un toque accidental doble en el mobile o un loop en algún
// agente upstream puede causar:
//
//   - /restart x2 en 5 segundos → segundo restart pisa al primero mid-flight,
//     deja sesiones colgadas o el pulpo en estado inconsistente.
//   - /limpiar x3 en 10 segundos → kill repetido sobre daemons que ya
//     estaban siendo matados, ruido de logs y posibles 'EACCES' espurios.
//   - /ghostbusters en pánico → operador presiona varias veces buscando
//     respuesta inmediata, cada invocación abre nuevos scans pesados.
//
// Diseñado distinto al rate-limit token-bucket (rate-limit.js):
//
//   - rate-limit:  protege contra FLOOD de cualquier comando determinístico
//                  (default 30/min). Bucket por chat_id, sin distinción por
//                  comando. Tiempo de recarga lineal.
//   - cooldown:    protege contra REPETICIÓN de un comando destructivo
//                  específico. Ventana fija de N segundos (default 60s) por
//                  cada combinación (chat_id, command). Sin recarga lineal:
//                  o estás dentro de la ventana o estás fuera.
//
// El cooldown es una capa ADICIONAL — corre después del rate-limit, NO en
// lugar de. Si un chat_id ya está rate-limited, no llega al cooldown.
//
// Persistencia: in-memory por proceso (mismo lifetime que el dispatcher).
// El cooldown es UX para mitigar pulsado accidental — no es defensa de
// seguridad. Si el pulpo reinicia, el cooldown se resetea, lo cual es
// razonable: post-restart, el operador SÍ podría querer re-ejecutar
// inmediatamente.
//
// Reglas inquebrantables:
// - Read-only: el cooldown jamás modifica archivos del pipeline; solo
//   inspecciona el reloj y devuelve allowed/blocked.
// - Idempotente: aplicar consume() dos veces con el mismo timestamp no
//   "gasta dos veces" el cooldown.
// - Inyección de reloj (`opts.now`) para tests deterministas.
// =============================================================================
'use strict';

const DEFAULT_COOLDOWN_MS = 60 * 1000;

// Set canónico de comandos destructivos. El caller (pulpo.js) decide qué
// comandos pasan por el cooldown via `opts.destructiveCommands`, pero este
// default cubre los casos del CA-4 del issue #3253.
const DEFAULT_DESTRUCTIVE_COMMANDS = Object.freeze(new Set([
    'restart',
    'limpiar',
    'ghostbusters',
    'reset',  // por compat con el copy del CA-4 ("/reset"); en el pipeline V3
              // actual no existe handler nativo, pero si llega vía NLP o se
              // suma a futuro, ya queda contemplado.
]));

/**
 * @param {object} [opts]
 * @param {number} [opts.cooldownMs=60000]  - ventana de cooldown por (chat,cmd)
 * @param {Iterable<string>} [opts.destructiveCommands]
 *        - lista de comandos sujetos al cooldown. Default DEFAULT_DESTRUCTIVE_COMMANDS.
 * @param {() => number} [opts.now]
 *        - clock injectable; default Date.now
 */
function createDestructiveCooldown(opts) {
    const options = opts || {};
    const cooldownMs = Number.isFinite(options.cooldownMs) && options.cooldownMs > 0
        ? options.cooldownMs
        : DEFAULT_COOLDOWN_MS;
    const destructive = options.destructiveCommands
        ? new Set([...options.destructiveCommands].map((c) => String(c).toLowerCase()))
        : new Set(DEFAULT_DESTRUCTIVE_COMMANDS);
    const now = typeof options.now === 'function' ? options.now : () => Date.now();

    // Map<chatId:string, Map<command:string, lastSuccessTs:number>>
    const lastSuccess = new Map();

    function bucketFor(chatId) {
        const key = String(chatId);
        let bucket = lastSuccess.get(key);
        if (!bucket) {
            bucket = new Map();
            lastSuccess.set(key, bucket);
        }
        return bucket;
    }

    /**
     * Indica si `command` está sujeto al cooldown destructivo.
     */
    function isDestructive(command) {
        return destructive.has(String(command || '').toLowerCase());
    }

    /**
     * Pre-check: ¿está el comando en cooldown para este chat?
     *
     * NO modifica estado. Si está bloqueado, devuelve `retryAfterMs > 0`.
     * Si está permitido, `retryAfterMs === 0` — el caller debe llamar a
     * `recordSuccess()` cuando el comando se ejecutó correctamente.
     *
     * @param {string|number} chatId
     * @param {string} command
     * @returns {{ allowed: boolean, retryAfterMs: number, lastSuccessAt: number|null }}
     */
    function check(chatId, command) {
        if (!isDestructive(command)) {
            return { allowed: true, retryAfterMs: 0, lastSuccessAt: null };
        }
        const bucket = bucketFor(chatId);
        const cmdKey = String(command).toLowerCase();
        const last = bucket.get(cmdKey);
        if (!Number.isFinite(last)) {
            return { allowed: true, retryAfterMs: 0, lastSuccessAt: null };
        }
        const elapsed = now() - last;
        if (elapsed >= cooldownMs) {
            return { allowed: true, retryAfterMs: 0, lastSuccessAt: last };
        }
        return {
            allowed: false,
            retryAfterMs: Math.max(0, cooldownMs - elapsed),
            lastSuccessAt: last,
        };
    }

    /**
     * Marca que `command` se ejecutó exitosamente para `chatId`. A partir de
     * ahora, llamadas a `check()` dentro de la ventana retornarán bloqueado.
     */
    function recordSuccess(chatId, command) {
        if (!isDestructive(command)) return;
        const bucket = bucketFor(chatId);
        bucket.set(String(command).toLowerCase(), now());
    }

    /**
     * Reset del cooldown — útil en tests y en casos extremos (operador pide
     * destrabar manualmente). En producción no se expone por el bot.
     */
    function reset(chatId) {
        if (chatId === undefined) {
            lastSuccess.clear();
        } else {
            lastSuccess.delete(String(chatId));
        }
    }

    return {
        check,
        recordSuccess,
        isDestructive,
        reset,
        _config: { cooldownMs, destructiveCommands: [...destructive] },
    };
}

/**
 * Helper humanizador del retryAfterMs para el template.
 *   < 60s → "Xs"
 *   ≥ 60s → "Xm Ys"
 */
function humanizeRetryAfter(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0s';
    const totalSec = Math.ceil(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

module.exports = {
    createDestructiveCooldown,
    humanizeRetryAfter,
    DEFAULT_COOLDOWN_MS,
    DEFAULT_DESTRUCTIVE_COMMANDS,
};
