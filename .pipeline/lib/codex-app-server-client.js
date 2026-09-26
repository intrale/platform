// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// codex-app-server-client.js — Cliente JSON-RPC mínimo para `codex app-server`
// Issue #7185 — canje automático del reset de límite de uso de codex.
//
// QUÉ ES EL APP-SERVER
//
// `codex app-server` (codex-cli ≥ 0.154) habla JSON-RPC 2.0 por stdio, una
// línea JSON por mensaje. Es lo que el TUI usa por detrás para `/usage` y para
// "Redeem usage limit reset". Expone dos operaciones que el pipeline necesita:
//
//   account/rateLimits/read                → snapshot en vivo de las ventanas
//                                            (primary/secondary) + créditos de
//                                            reset disponibles.
//   account/rateLimitResetCredit/consume   → canjea un crédito. Idempotente por
//                                            `idempotencyKey` (UUID).
//
// Leer NO consume cuota (es metadata de cuenta) y responde en <1 s.
//
// TRANSPORTE: STDIO EFÍMERO
//
// Se spawnea un proceso por sesión, se hace `initialize` → `initialized`, se
// ejecutan las llamadas que hagan falta y se cierra stdin: el proceso termina
// solo (verificado en Windows: exit 0 al cerrar stdin, sin proceso residual —
// CA-12). No usamos el `daemon`: sería un proceso residente más que administrar.
//
// REGLAS DEL PROTOCOLO QUE IMPORTAN
//
//  - El server emite notificaciones no solicitadas (sin `id`, p. ej.
//    `remoteControl/status/changed`) ANTES de la respuesta. El cliente empareja
//    por `id` y descarta el resto; jamás asume "la primera línea es mi respuesta".
//  - Timeout duro por llamada y por sesión, con `kill()` en el timeout para que
//    CA-12 se cumpla también en el camino de falla.
//  - Errores JSON-RPC (`error` en vez de `result`, p. ej. sin login) se devuelven
//    como rechazo tipado: el caller decide (siempre noop, ver codex-reset-credit).
//
// PRIVACIDAD
//
// La respuesta trae `accountId` e identificadores de instalación. Este módulo
// devuelve el `result` crudo al caller, que sólo extrae los campos estructurados
// que necesita; NADA de la respuesta se loguea ni se manda a Telegram.
// =============================================================================
'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_CALL_TIMEOUT_MS = 10 * 1000;
const DEFAULT_SESSION_TIMEOUT_MS = 30 * 1000;
// Margen para que el proceso cierre solo tras `stdin.end()` antes de matarlo.
const DEFAULT_EXIT_GRACE_MS = 3 * 1000;

const CLIENT_INFO = Object.freeze({
    name: 'intrale-pipeline',
    title: 'Intrale pipeline',
    version: '1.0.0',
});

class AppServerError extends Error {
    /**
     * @param {string} code    `spawn_failed` | `timeout` | `rpc_error` |
     *                         `closed` | `bad_response`
     * @param {string} message
     * @param {object} [extra]
     */
    constructor(code, message, extra = {}) {
        super(message);
        this.name = 'AppServerError';
        this.code = code;
        Object.assign(this, extra);
    }
}

/**
 * Resuelve cómo lanzar `codex`. Reutiliza la resolución multi-tier del launcher
 * de agentes (native-exe → node wrapper → .cmd shim → PATH) para no duplicar la
 * lógica de Windows. Inyectable para tests.
 */
function defaultLauncher() {
    try {
        return require('./agent-launcher/providers/openai-codex').detectLauncher();
    } catch {
        return { kind: 'path-fallback', cmd: process.env.CODEX_BIN || 'codex', prefixArgs: [], shell: true };
    }
}

/**
 * Abre una sesión efímera contra `codex app-server`.
 *
 * @param {object} [opts]
 * @param {Function} [opts.spawnImpl]        inyectable (tests): misma firma que `child_process.spawn`.
 * @param {object}   [opts.launcher]         `{cmd, prefixArgs, shell}`; default `defaultLauncher()`.
 * @param {number}   [opts.callTimeoutMs]
 * @param {number}   [opts.sessionTimeoutMs]
 * @param {number}   [opts.exitGraceMs]
 * @returns {Promise<{request:Function, close:Function}>}
 */
async function openSession(opts = {}) {
    const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : spawn;
    const launcher = opts.launcher || defaultLauncher();
    const callTimeoutMs = Number.isFinite(opts.callTimeoutMs) ? opts.callTimeoutMs : DEFAULT_CALL_TIMEOUT_MS;
    const sessionTimeoutMs = Number.isFinite(opts.sessionTimeoutMs) ? opts.sessionTimeoutMs : DEFAULT_SESSION_TIMEOUT_MS;
    const exitGraceMs = Number.isFinite(opts.exitGraceMs) ? opts.exitGraceMs : DEFAULT_EXIT_GRACE_MS;

    let child;
    try {
        child = spawnImpl(launcher.cmd, [...(launcher.prefixArgs || []), 'app-server'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: launcher.shell === true,
            windowsHide: true,
        });
    } catch (e) {
        throw new AppServerError('spawn_failed', `no se pudo lanzar codex app-server: ${e && e.message}`);
    }

    const pending = new Map(); // id → {resolve, reject, timer}
    let nextId = 1;
    let closed = false;
    let buffer = '';

    const failAll = (err) => {
        for (const [, p] of pending) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        pending.clear();
    };

    const onLine = (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; } // ruido → ignorar
        if (!msg || typeof msg !== 'object') return;
        // Notificaciones (sin `id`) y requests del server hacia el cliente se
        // descartan: sólo emparejamos respuestas a lo que pedimos nosotros.
        if (msg.id === undefined || msg.id === null || !pending.has(msg.id)) return;
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
            p.reject(new AppServerError('rpc_error', `error JSON-RPC en ${p.method}`, {
                rpcCode: msg.error.code,
                method: p.method,
            }));
            return;
        }
        p.resolve(msg.result);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line) onLine(line);
        }
    });
    // stderr se drena para que el proceso no bloquee; no se conserva (SEC: nada
    // del CLI llega a logs/Telegram por acá).
    if (child.stderr) child.stderr.on('data', () => {});

    const exited = new Promise((resolve) => {
        child.once('exit', (code, signal) => { closed = true; resolve({ code, signal }); });
    });
    child.once('error', (e) => {
        closed = true;
        failAll(new AppServerError('spawn_failed', `codex app-server: ${e && e.message}`));
    });
    child.once('exit', () => {
        failAll(new AppServerError('closed', 'codex app-server terminó antes de responder'));
    });

    const sessionTimer = setTimeout(() => {
        failAll(new AppServerError('timeout', `sesión app-server excedió ${sessionTimeoutMs} ms`));
        try { child.kill(); } catch { /* ya muerto */ }
    }, sessionTimeoutMs);
    if (typeof sessionTimer.unref === 'function') sessionTimer.unref();

    function notify(method, params) {
        if (closed) return;
        try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n'); }
        catch { /* el error real llega por `exit`/`error` */ }
    }

    function request(method, params) {
        if (closed) return Promise.reject(new AppServerError('closed', 'sesión cerrada'));
        const id = nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new AppServerError('timeout', `${method} sin respuesta en ${callTimeoutMs} ms`, { method }));
            }, callTimeoutMs);
            if (typeof timer.unref === 'function') timer.unref();
            pending.set(id, { resolve, reject, timer, method });
            try {
                child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
            } catch (e) {
                pending.delete(id);
                clearTimeout(timer);
                reject(new AppServerError('closed', `no se pudo escribir ${method}: ${e && e.message}`));
            }
        });
    }

    /**
     * Cierra stdin (el server termina solo) y espera la salida; si no sale en
     * `exitGraceMs`, lo mata. Idempotente. Nunca rechaza.
     */
    async function close() {
        clearTimeout(sessionTimer);
        if (closed) return;
        try { child.stdin.end(); } catch { /* ya cerrado */ }
        const grace = new Promise((resolve) => {
            const t = setTimeout(() => resolve('grace_elapsed'), exitGraceMs);
            if (typeof t.unref === 'function') t.unref();
        });
        const outcome = await Promise.race([exited, grace]);
        if (outcome === 'grace_elapsed' && !closed) {
            try { child.kill(); } catch { /* best-effort */ }
            await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
        }
    }

    // Handshake obligatorio del protocolo.
    try {
        await request('initialize', { clientInfo: CLIENT_INFO });
        notify('initialized', {});
    } catch (e) {
        await close();
        throw e;
    }

    return { request, close };
}

/**
 * Ejecuta `fn(session)` dentro de una sesión efímera y garantiza el cierre del
 * proceso aunque `fn` lance o expire (CA-12 en el camino de falla).
 */
async function withAppServer(fn, opts = {}) {
    const session = await openSession(opts);
    try {
        return await fn(session);
    } finally {
        await session.close();
    }
}

/** `account/rateLimits/read` → `result` crudo (ver PRIVACIDAD arriba). */
function readRateLimits(session) {
    return session.request('account/rateLimits/read', {});
}

/**
 * `account/rateLimitResetCredit/consume`.
 * @param {{request:Function}} session
 * @param {{idempotencyKey:string, creditId?:string|null}} params
 * @returns {Promise<{outcome:string}>}
 */
function consumeResetCredit(session, params) {
    if (!params || typeof params.idempotencyKey !== 'string' || params.idempotencyKey.length === 0) {
        return Promise.reject(new AppServerError('bad_response', 'idempotencyKey obligatorio'));
    }
    const body = { idempotencyKey: params.idempotencyKey };
    if (typeof params.creditId === 'string' && params.creditId.length > 0) body.creditId = params.creditId;
    return session.request('account/rateLimitResetCredit/consume', body);
}

module.exports = {
    openSession,
    withAppServer,
    readRateLimits,
    consumeResetCredit,
    AppServerError,
    DEFAULT_CALL_TIMEOUT_MS,
    DEFAULT_SESSION_TIMEOUT_MS,
    DEFAULT_EXIT_GRACE_MS,
    _defaultLauncher: defaultLauncher,
};
