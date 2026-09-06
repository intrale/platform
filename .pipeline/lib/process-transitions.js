'use strict';

// =============================================================================
// process-transitions.js — Store de transiciones vivo↔muerto por servicio.
// EP8-H7 (#3960, épica #3952) — CA-1 "desde cuándo" + último error + historial.
// -----------------------------------------------------------------------------
// Store append-only `process-transitions.jsonl` (una línea JSON por flanco):
//
//   { ts, service, from: 'alive'|'dead', to: 'alive'|'dead', reason, lastError }
//
// Alimentación: `recordSnapshot(procesos)` se engancha al punto donde el
// dashboard ya computa alive/dead por componente (getPipelineState →
// state.procesos). Detecta el flanco contra el snapshot previo EN MEMORIA y
// sólo persiste cuando hay cambio real (idempotente si no hay flanco).
//
// "Último error" (CA-1) = heurística: última línea ERROR/stack del `<svc>.log`,
// pasada por `sanitizer.sanitize()` ANTES de persistir (REQ-SEC-H7-1/6) para
// no filtrar secrets al store ni al SSR. La lectura agrega por motivo en una
// ventana de 7 días (`caídas 7 d: 2 (ECONNRESET ×2)`).
//
// Sin bind de paths a tiempo de carga: `opts.pipelineDir` permite tests con
// tmpdir; `opts.now` y `opts.lastErrorFor` hacen el flanco determinístico.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const STORE_NAME = 'process-transitions.jsonl';
const DEFAULT_WINDOW_MS = 7 * 24 * 3600 * 1000; // 7 días
const MAX_LINES = 20000;       // techo de parseo por lectura (append-only)
const LAST_ERROR_MAX = 400;    // cap del último error persistido
const LOG_TAIL_BYTES = 64 * 1024; // ventana de cola del log de servicio
// #6441 (REQ-SEC-6441-5) — Cota de ESCRITURA. `MAX_LINES` es techo de parseo por
// lectura y no frena el crecimiento del archivo: un servicio en crash-loop
// escribe 2 lineas por ciclo indefinidamente. Al pasar este umbral el store se
// reescribe conservando solo la ventana de 7 dias.
const ROTATE_AT_LINES = 5000;

// #6441 (REQ-SEC-6441-3) — `service` se interpola en el path del log del
// servicio (`readLastError`). Viene del registro de componentes, pero el modulo
// es reusable y no puede confiar en su caller: se valida ANTES del path.join.
const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function isValidServiceName(service) {
    return typeof service === 'string' && SERVICE_NAME_RE.test(service);
}

// Estado en memoria del último alive/dead observado por servicio. Se siembra en
// la primera observación (no genera transición espuria al arrancar el dashboard).
const _lastState = new Map();

function resolvePipelineDir(opts) {
    if (opts && opts.pipelineDir) return opts.pipelineDir;
    // __dirname = .pipeline/lib → padre = .pipeline
    return path.resolve(__dirname, '..');
}

function storePath(opts) {
    return path.join(resolvePipelineDir(opts), STORE_NAME);
}

function logDir(opts) {
    return path.join(resolvePipelineDir(opts), 'logs');
}

// sanitize defensivo — si el módulo no está disponible, devolvemos el texto tal
// cual (mejor un texto sin redactar en un entorno de test que romper el flow).
function _sanitize(text) {
    if (typeof text !== 'string') return '';
    try { return require('../sanitizer').sanitize(text); }
    catch { return text; }
}

// Extrae un motivo legible del último error. Prioriza tokens tipo ECONNRESET /
// ETIMEDOUT / EPIPE; si no hay, usa la primera palabra significativa. Default
// 'unknown'. El resultado se usa para agregar el breakdown por motivo.
function classifyReason(lastError) {
    if (typeof lastError !== 'string' || !lastError) return 'unknown';
    const code = lastError.match(/\b(E[A-Z]{2,}[A-Z0-9_]*)\b/);
    if (code) return code[1];
    const named = lastError.match(/\b([A-Z][a-zA-Z]*Error|[A-Z]{3,})\b/);
    if (named) return named[1];
    return 'unknown';
}

// Lee la cola del log del servicio y devuelve la última línea relevante
// (ERROR/Exception/stack), sanitizada y capada. '' si no hay log o no hay match.
function readLastError(service, opts) {
    // #6441 — nombre fuera del alfabeto permitido => no se toca el filesystem.
    // Se descarta con log para que el rechazo no sea mudo.
    if (!isValidServiceName(service)) {
        try { console.warn(`[process-transitions] nombre de servicio invalido, no se lee su log: ${String(service).slice(0, 40)}`); }
        catch { /* el log no puede romper el flow */ }
        return '';
    }
    const file = path.join(logDir(opts), `${service}.log`);
    let raw;
    try {
        const stat = fs.statSync(file);
        const start = Math.max(0, stat.size - LOG_TAIL_BYTES);
        const fd = fs.openSync(file, 'r');
        try {
            const len = stat.size - start;
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, start);
            raw = buf.toString('utf8');
        } finally { fs.closeSync(fd); }
    } catch { return ''; }

    const lines = raw.split(/\r?\n/).filter(l => l.length > 0);
    const isErr = (l) => /\bERROR\b|Exception|\bat\s+\w|ECONNRESET|ETIMEDOUT|EPIPE|EADDRINUSE|fatal/i.test(l);
    let pick = '';
    for (let i = lines.length - 1; i >= 0; i--) {
        if (isErr(lines[i])) { pick = lines[i]; break; }
    }
    if (!pick && lines.length) pick = lines[lines.length - 1];
    const clean = _sanitize(pick).trim();
    return clean.length > LAST_ERROR_MAX ? clean.slice(0, LAST_ERROR_MAX) + '…' : clean;
}

function _appendLine(record, opts) {
    const file = storePath(opts);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
        return true;
    } catch { return false; }
}

/**
 * #6441 (REQ-SEC-6441-5) — Poda el store si supero `ROTATE_AT_LINES`,
 * conservando la ventana de `windowMs` (7 d por default).
 *
 * Escritura ATOMICA (tmp + rename), nunca truncado in-place: el dashboard
 * appendea a este mismo archivo desde otro proceso y un truncado in-place le
 * dejaria el offset en el aire. Con rename, el que estaba appendeando termina
 * su escritura contra el inode viejo y a lo sumo se pierde esa linea — nunca se
 * corrompe el archivo que lee el operador.
 *
 * La invoca SOLO el barrido de liveness (un unico escritor periodico). El
 * dashboard NO rota: dos rotadores concurrentes es justamente lo que se evita.
 *
 * @returns {{ rotated: boolean, kept?: number, dropped?: number }}
 */
function rotateIfNeeded(opts) {
    const o = opts || {};
    const file = storePath(o);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { return { rotated: false }; }

    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length <= ROTATE_AT_LINES) return { rotated: false };

    const now = typeof o.now === 'number' ? o.now : Date.now();
    const windowMs = typeof o.windowMs === 'number' ? o.windowMs : DEFAULT_WINDOW_MS;
    const cutoff = now - windowMs;
    const enVentana = lines.filter(line => {
        let ev;
        try { ev = JSON.parse(line); } catch { return false; } // corrupta: se descarta
        const t = ev && ev.ts ? Date.parse(ev.ts) : NaN;
        return Number.isFinite(t) && t >= cutoff;
    });

    // Si TODO entra en la ventana, el crecimiento no es antiguedad sino
    // frecuencia (crash-loop). Igual cortamos por la cola: se conservan las mas
    // recientes, que son las que sirven para diagnosticar.
    const final = enVentana.length > ROTATE_AT_LINES ? enVentana.slice(-ROTATE_AT_LINES) : enVentana;

    const tmp = file + '.tmp';
    try {
        fs.writeFileSync(tmp, final.length ? final.join('\n') + '\n' : '', 'utf8');
        fs.renameSync(tmp, file);
    } catch {
        try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
        return { rotated: false };
    }
    return { rotated: true, kept: final.length, dropped: lines.length - final.length };
}

/**
 * Registra el flanco alive↔dead detectado en `procesos` contra el snapshot
 * previo en memoria. Persiste sólo los servicios que cambiaron de estado.
 *
 * @param {object} procesos — map { service: { alive: bool, ... } } (state.procesos).
 * @param {object} [opts] — { pipelineDir, now (ms), lastErrorFor(service)->string }.
 * @returns {Array<object>} transiciones efectivamente registradas (para tests).
 */
function recordSnapshot(procesos, opts) {
    const o = opts || {};
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const ts = new Date(now).toISOString();
    const recorded = [];
    if (!procesos || typeof procesos !== 'object') return recorded;

    for (const [service, p] of Object.entries(procesos)) {
        const alive = !!(p && p.alive);
        const prev = _lastState.get(service);
        if (prev === undefined) { _lastState.set(service, alive); continue; } // siembra
        if (prev === alive) continue; // sin flanco

        const from = prev ? 'alive' : 'dead';
        const to = alive ? 'alive' : 'dead';
        let lastError = '';
        let reason;
        if (to === 'dead') {
            lastError = typeof o.lastErrorFor === 'function'
                ? _sanitize(String(o.lastErrorFor(service) || '')).slice(0, LAST_ERROR_MAX)
                : readLastError(service, o);
            reason = classifyReason(lastError);
        } else {
            reason = 'recovered';
        }
        // #6441 — Desde este issue hay DOS escritores (el dashboard, acá, y el
        // barrido del watchdog). El dashboard detecta el flanco contra su
        // memoria y el barrido contra el disco, así que ante una misma muerte
        // los dos podrían escribirla y "caídas 7 d" contaría el doble.
        // Se consulta el disco SÓLO cuando ya hay flanco (caso raro): en el
        // camino normal, sin flanco, no se lee nada y el costo es cero.
        let yaAsentado = false;
        try { yaAsentado = readPrevStates(o)[service] === to; }
        catch { yaAsentado = false; } // ante la duda, se escribe: mejor duplicar que perder
        _lastState.set(service, alive);
        if (yaAsentado) continue;

        const record = { ts, service, from, to, reason, lastError };
        _appendLine(record, o);
        recorded.push(record);
    }
    return recorded;
}

function _readAll(opts) {
    const file = storePath(opts);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { return []; }
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-MAX_LINES);
    const out = [];
    for (const line of lines) {
        try { out.push(JSON.parse(line)); } catch { /* línea corrupta, ignorar */ }
    }
    return out;
}

/**
 * Lee el historial de transiciones (ventana 7d default), opcionalmente filtrado
 * por servicio, con agregación de caídas por motivo.
 *
 * @param {string|null} service — servicio a filtrar (null = todos).
 * @param {object} [opts] — { pipelineDir, now, windowMs }.
 * @returns {{ service, count, downCount, byReason, summary, lastError, transitions }}
 */
function readTransitions(service, opts) {
    const o = opts || {};
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const windowMs = typeof o.windowMs === 'number' ? o.windowMs : DEFAULT_WINDOW_MS;
    const cutoff = now - windowMs;

    const all = _readAll(o).filter(ev => {
        if (service && ev.service !== service) return false;
        const t = ev && ev.ts ? Date.parse(ev.ts) : NaN;
        return Number.isFinite(t) && t >= cutoff;
    });

    const byReason = {};
    let downCount = 0;
    let lastError = '';
    for (const ev of all) {
        // #6441 — una SIEMBRA no es una caída: es la primera vez que se observa
        // el servicio. Contarla inflaría "caídas 7 d" de `outbox-drain` y
        // `svc-emulador`, que arrancan muertos por diseño, y le enseñaría al
        // operador que el número miente.
        if (ev.reason === 'seed') continue;
        if (ev.to === 'dead') {
            downCount++;
            const r = String(ev.reason || 'unknown');
            byReason[r] = (byReason[r] || 0) + 1;
            if (ev.lastError) lastError = ev.lastError; // el más reciente en orden append
        }
    }

    const days = Math.round(windowMs / (24 * 3600 * 1000));
    const reasonStr = Object.entries(byReason)
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${r} ×${n}`)
        .join(', ');
    const summary = downCount > 0
        ? `caídas ${days} d: ${downCount}${reasonStr ? ` (${reasonStr})` : ''}`
        : `caídas ${days} d: 0`;

    return {
        service: service || null,
        count: all.length,
        downCount,
        byReason,
        summary,
        lastError,
        transitions: all,
    };
}

// =============================================================================
// #6441 — BARRIDO DE LIVENESS: el flanco deja de depender del dashboard.
// -----------------------------------------------------------------------------
// `recordSnapshot` deriva el estado previo de `_lastState`, un Map de MODULO.
// Eso funciona para el dashboard (proceso largo) y es inservible para el
// watchdog, que es efimero: arranca cada 2 min, sembraria en cada corrida y no
// detectaria un solo flanco jamas. Es literalmente el agujero del incidente —
// el store tenia resurrecciones ('recovered') y ninguna muerte.
//
// `recordSweep` deriva el estado previo del PROPIO .jsonl. Sobrevive a que el
// proceso que barre reinicie entre observacion y observacion, que es la unica
// forma de que esto funcione desde el watchdog.
//
// La siembra PERSISTE (linea con `from: 'unknown'`, `reason: 'seed'`). Si
// sembrara solo en memoria, un servicio sin historial volveria a sembrarse en
// cada corrida y su muerte no se registraria nunca: el mismo bug, un nivel mas
// abajo.
// =============================================================================

/**
 * Ultimo estado conocido por servicio, derivado del store (no de memoria).
 *
 * @param {object} [opts] — { pipelineDir }.
 * @returns {Object<string, 'alive'|'dead'>} — servicios sin historial no aparecen.
 */
function readPrevStates(opts) {
    const out = {};
    for (const ev of _readAll(opts || {})) {
        if (!ev || !isValidServiceName(ev.service)) continue;
        if (ev.to !== 'alive' && ev.to !== 'dead') continue;
        out[ev.service] = ev.to; // append-only: la ultima linea gana
    }
    return out;
}

/**
 * Registra los flancos de un barrido contra el estado previo LEIDO DEL STORE.
 *
 * @param {object} observed — { service: { alive: bool } | bool }.
 * @param {object} [opts] — { pipelineDir, now, prevStates, lastErrorFor, rotate }.
 * @returns {Array<object>} transiciones persistidas (incluye las siembras).
 */
function recordSweep(observed, opts) {
    const o = opts || {};
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const ts = new Date(now).toISOString();
    const recorded = [];
    if (!observed || typeof observed !== 'object') return recorded;

    // Se lee UNA vez y se compara contra todos: el store es append-only, asi que
    // releerlo por servicio daria el mismo resultado a costa de N lecturas.
    const prev = (o.prevStates && typeof o.prevStates === 'object')
        ? o.prevStates
        : readPrevStates(o);

    for (const [service, v] of Object.entries(observed)) {
        if (!isValidServiceName(service)) continue;
        const alive = !!(v && typeof v === 'object' ? v.alive : v);
        const to = alive ? 'alive' : 'dead';
        const from = prev[service];

        if (from === to) continue;              // sin flanco
        if (from !== 'alive' && from !== 'dead' && from !== undefined) continue;

        let lastError = '';
        let reason;
        if (from === undefined) {
            // Siembra persistida: fija la linea base en disco para que el
            // proximo barrido tenga contra que comparar aunque el proceso muera.
            reason = 'seed';
            if (to === 'dead') lastError = _lastErrorFor(service, o);
        } else if (to === 'dead') {
            lastError = _lastErrorFor(service, o);
            reason = classifyReason(lastError);
        } else {
            reason = 'recovered';
        }

        const record = { ts, service, from: from === undefined ? 'unknown' : from, to, reason, lastError };
        if (_appendLine(record, o)) recorded.push(record);
    }

    // La rotacion la pide SOLO este camino (un unico escritor periodico).
    if (o.rotate !== false) {
        try { rotateIfNeeded(o); } catch { /* podar nunca puede romper el barrido */ }
    }
    return recorded;
}

function _lastErrorFor(service, o) {
    return typeof o.lastErrorFor === 'function'
        ? _sanitize(String(o.lastErrorFor(service) || '')).slice(0, LAST_ERROR_MAX)
        : readLastError(service, o);
}

// Reset del estado en memoria — sólo para tests (aislamiento entre casos).
function _resetState() { _lastState.clear(); }

module.exports = {
    recordSnapshot,
    recordSweep,
    readPrevStates,
    rotateIfNeeded,
    isValidServiceName,
    readTransitions,
    readLastError,
    classifyReason,
    storePath,
    DEFAULT_WINDOW_MS,
    ROTATE_AT_LINES,
    __forTestsOnly__: { _resetState, _lastState },
};
