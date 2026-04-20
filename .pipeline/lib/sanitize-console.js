// =============================================================================
// sanitize-console.js — Patch de console.{log,error,warn,info} para servicios
// Issue #2334 / CA6.
//
// Motivo: los servicios (svc-telegram, svc-github, svc-drive) son lanzados
// por `restart.js` con `stdio: ['ignore', logFd, logFd]` — sus llamadas a
// `console.log` escriben DIRECTAMENTE al archivo `svc-<name>.log` vía el
// file descriptor inherited. No hay oportunidad de interponer un Transform
// desde fuera sin sostener un stream en el padre (restart.js es corto).
//
// Solución: adentro del servicio, al arrancar, reemplazamos `console.log` /
// `console.error` por versiones que sanitizan antes de emitir. Así el
// archivo en disco NUNCA ve el texto original, aún si `log()` mete un
// secreto por error.
//
// Uso:
//   require('./lib/sanitize-console').install();
//
// Idempotente: si ya se instaló, no hace nada.
// =============================================================================
'use strict';

const { sanitize } = require('../sanitizer');

let installed = false;

function sanitizeArg(arg) {
    // Strings: sanitizar directo. Errores: stack + message. Objetos: JSON
    // stringify y sanitizar (best-effort — si no se puede serializar, lo
    // devolvemos tal cual sin mutar; console se encarga).
    if (typeof arg === 'string') return sanitize(arg);
    if (arg instanceof Error) {
        // Retornamos un Error nuevo con message/stack redactados.
        const clone = new Error(sanitize(String(arg.message || '')));
        if (arg.stack) clone.stack = sanitize(String(arg.stack));
        clone.name = arg.name;
        return clone;
    }
    if (arg && typeof arg === 'object') {
        try {
            const json = JSON.stringify(arg);
            const sanitized = sanitize(json);
            try { return JSON.parse(sanitized); } catch { return sanitized; }
        } catch {
            return arg;
        }
    }
    return arg;
}

function install() {
    if (installed) return;
    installed = true;

    const METHODS = ['log', 'error', 'warn', 'info'];
    for (const m of METHODS) {
        const orig = console[m];
        if (typeof orig !== 'function') continue;
        console[m] = function patchedConsole(...args) {
            const safeArgs = args.map(sanitizeArg);
            return orig.apply(console, safeArgs);
        };
    }
}

module.exports = { install, __forTestsOnly__: { sanitizeArg } };
