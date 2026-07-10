// =============================================================================
// process-liveness.js — Fuente única de verdad de "¿el pid sigue vivo y es
// quien dice ser?" (#4622).
//
// PROBLEMA que resuelve: un heartbeat zombi (latido de un agente ya muerto) con
// timestamp fresco hacía creer al pipeline que había un agente vivo trabajando
// un issue, no relanzaba la fase, y la ola quedaba varada. La causa raíz no es
// sólo el archivo pegado, sino confiar en el pid del latido SIN validar contra
// el OS (existencia) NI su identidad (defensa contra reuso de PID en Windows).
//
// Este módulo consolida la lógica que estaba duplicada en `pulpo.js:isProcessAlive`
// y `pid-discovery.js:pidAlive`, agregando la dimensión de IDENTIDAD:
//
//   - isProcessAlive(pid)        → ¿existe un proceso con ese pid en el OS?
//   - getProcessStartTime(pid)   → marca de creación del proceso (defeat PID reuse)
//   - processIdentityMatches()   → ¿el proceso vivo es EL MISMO que registró el
//                                  latido? (compara start-time; true/false/null)
//   - isAgentAlive()             → combinado: vivo AND (identidad ok | sin token)
//
// SEGURIDAD (CA de #4622):
//   - SEC-1 (reuso de PID / TOCTOU): `isProcessAlive` NO alcanza como prueba de
//     identidad. `processIdentityMatches` cruza la marca de creación del proceso
//     grabada en el latido contra la actual; si difieren → NO es el mismo agente.
//   - SEC-3 (inyección desde archivo de estado): `pid` se valida entero positivo
//     ANTES de cualquier uso; SIEMPRE `spawnSync(cmd, [args])` con array, NUNCA
//     concatenación en shell. `session`/`branch` se tratan como no confiables.
//   - Fail-safe: ante cualquier duda verificable (no se puede leer el start-time
//     de un pid que dice estar vivo) → tratar como MUERTO/no-identidad.
//
// PURO salvo el spawn del OS. Todo es INYECTABLE (`processCheck`, `startTimeProbe`,
// `spawnImpl`, `killImpl`, `platform`) para tests deterministas sin tocar el OS.
// =============================================================================

'use strict';

const { spawnSync } = require('node:child_process');

// SEC-3 — un pid confiable es entero positivo. Devuelve el número normalizado o
// null si no cumple. NUNCA se usa un pid sin pasar por acá.
function isValidPid(pid) {
    const n = Number(pid);
    return Number.isInteger(n) && n > 0 ? n : null;
}

// -----------------------------------------------------------------------------
// isProcessAlive(pid, opts) — ¿el pid existe como proceso vivo en el OS?
//   - win32: `tasklist /FI "PID eq <n>"` (array de args, sin shell — SEC-3).
//   - posix: `process.kill(pid, 0)` (ESRCH ⇒ no existe; EPERM ⇒ existe ajeno).
// Inyectables: opts.processCheck (bypass total), opts.spawnImpl, opts.killImpl,
// opts.platform. Devuelve boolean; ante error inesperado → false (fail-safe).
// -----------------------------------------------------------------------------
function isProcessAlive(pid, opts = {}) {
    const n = isValidPid(pid);
    if (n == null) return false;
    if (typeof opts.processCheck === 'function') {
        try { return !!opts.processCheck(n); } catch { return false; }
    }
    const platform = opts.platform || process.platform;
    try {
        if (platform === 'win32') {
            const _spawn = opts.spawnImpl || spawnSync;
            const r = _spawn('tasklist', ['/FI', `PID eq ${n}`, '/NH', '/FO', 'CSV'], {
                encoding: 'utf8', timeout: 5000, windowsHide: true,
            });
            return String((r && r.stdout) || '').includes(`"${n}"`);
        }
        const _kill = opts.killImpl || process.kill.bind(process);
        _kill(n, 0);
        return true;
    } catch (e) {
        // EPERM ⇒ el proceso existe pero es de otro usuario ⇒ vivo.
        return !!(e && e.code === 'EPERM');
    }
}

// -----------------------------------------------------------------------------
// getProcessStartTime(pid, opts) — marca de creación del proceso, normalizada a
// una string comparable (segundo de precisión). Es la señal anti-reuso de PID:
// dos procesos con el mismo pid en momentos distintos tienen creation-time
// distinto. Devuelve string o null (no legible / pid muerto / plataforma sin
// soporte). Inyectable: opts.startTimeProbe(n) → string|null.
//   - win32: `wmic process where ProcessId=<n> get CreationDate /value`
//            → `CreationDate=YYYYMMDDHHMMSS.ffffff±off` — usamos los 14 dígitos.
//   - posix: `ps -o lstart= -p <n>` → string de fecha estable por proceso.
// -----------------------------------------------------------------------------
function getProcessStartTime(pid, opts = {}) {
    const n = isValidPid(pid);
    if (n == null) return null;
    if (typeof opts.startTimeProbe === 'function') {
        try { return normalizeStart(opts.startTimeProbe(n)); } catch { return null; }
    }
    const platform = opts.platform || process.platform;
    const _spawn = opts.spawnImpl || spawnSync;
    try {
        if (platform === 'win32') {
            const r = _spawn('wmic', ['process', 'where', `ProcessId=${n}`, 'get', 'CreationDate', '/value'], {
                encoding: 'utf8', timeout: 5000, windowsHide: true,
            });
            if (r && r.status === 0 && r.stdout) {
                const m = /CreationDate=(\d{14})/.exec(r.stdout);
                if (m) return m[1]; // YYYYMMDDHHMMSS (segundo)
            }
            return null;
        }
        const r = _spawn('ps', ['-o', 'lstart=', '-p', String(n)], { encoding: 'utf8', timeout: 5000 });
        if (r && r.status === 0 && r.stdout && r.stdout.trim()) return normalizeStart(r.stdout.trim());
        return null;
    } catch {
        return null;
    }
}

function normalizeStart(v) {
    if (v == null) return null;
    const s = String(v).trim();
    return s || null;
}

// -----------------------------------------------------------------------------
// processIdentityMatches(pid, identity, opts) — ¿el pid vivo es EL MISMO proceso
// que grabó el latido? Compara la marca de creación registrada (identity.startedAt
// / pid_started_at) contra la actual del OS.
//   → true   : coinciden (mismo proceso, no hubo reuso).
//   → false  : difieren, o el pid vivo no expone start-time legible (fail-safe:
//              no se puede PROBAR identidad ⇒ tratar como no-el-mismo, SEC-1).
//   → null   : el latido NO trae token de identidad (legacy) ⇒ no verificable;
//              el caller decide (ver isAgentAlive.requireIdentity).
// -----------------------------------------------------------------------------
function processIdentityMatches(pid, identity = {}, opts = {}) {
    const n = isValidPid(pid);
    if (n == null) return false;
    const recorded = normalizeStart(
        identity && (identity.startedAt || identity.pidStartedAt || identity.pid_started_at)
    );
    if (recorded == null) return null; // sin token → no verificable
    const actual = getProcessStartTime(n, opts);
    if (actual == null) return false;  // vivo pero sin start-time legible → fail-safe
    return actual === recorded;
}

// -----------------------------------------------------------------------------
// isAgentAlive(pid, identity, opts) — veredicto combinado usado por los lectores
// (canonical-facts, reconciler). Un agente cuenta como VIVO sólo si:
//   1. su pid existe en el OS, Y
//   2. la identidad matchea (mismo start-time) — o el latido no trae token y el
//      caller no exige identidad estricta (opts.requireIdentity=false, default).
//
// opts.requireIdentity=true ⇒ un latido sin token de identidad se trata como
// muerto (fail-safe SEC-1 estricto). Default false ⇒ compat con latidos legacy
// (los latidos nuevos SIEMPRE traen `pid_started_at`, así que la ventana legacy
// se cierra sola en ≤1 ciclo de heartbeat).
// -----------------------------------------------------------------------------
function isAgentAlive(pid, identity = {}, opts = {}) {
    if (!isProcessAlive(pid, opts)) return false;
    const m = processIdentityMatches(pid, identity, opts);
    if (m === false) return false; // reuso de pid o identidad no probable → muerto
    if (m === true) return true;
    // m === null → latido legacy sin token
    return opts.requireIdentity ? false : true;
}

// -----------------------------------------------------------------------------
// resolveHeartbeatOwner(recordedPid, currentPid, opts) — decide con qué pid (si
// alguno) refrescar un latido de agente, neutralizando al "escritor huérfano"
// (#4622, CA-2). Reglas:
//   1. Si el pid grabado en la sesión sigue VIVO → es el dueño; se refresca con él.
//   2. Si murió pero el proceso ACTUAL (el que corre el hook) está vivo → el dueño
//      pasa a ser el proceso actual (una sesión reanudada legítima).
//   3. Si NINGÚN pid asociado vive → NO refrescar (return null): el latido caduca
//      en vez de revivir con un pid muerto. Esto es lo que rompe el ciclo del
//      heartbeat zombi.
// Devuelve el pid dueño (number) o null (no escribir). PURO vía opts inyectables.
// -----------------------------------------------------------------------------
function resolveHeartbeatOwner(recordedPid, currentPid, opts = {}) {
    if (recordedPid && isProcessAlive(recordedPid, opts)) return isValidPid(recordedPid);
    if (currentPid && isProcessAlive(currentPid, opts)) return isValidPid(currentPid);
    return null;
}

module.exports = {
    isValidPid,
    isProcessAlive,
    getProcessStartTime,
    processIdentityMatches,
    isAgentAlive,
    resolveHeartbeatOwner,
};
