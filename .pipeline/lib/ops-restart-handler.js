'use strict';

// =============================================================================
// ops-restart-handler.js — Orquestador puro del restart por servicio del
// Dashboard Ops. EP8-H7 (#3960, épica #3952) — CA-3.
// -----------------------------------------------------------------------------
// Aísla la DECISIÓN del restart (allowlist + rate-limit + audit) de la
// ejecución real (stop+start, que vive en dashboard.js con COMPONENTS/spawn).
// Así el contrato de seguridad es unit-testeable sin levantar el server:
//
//   - REQ-SEC-H7-2: `target` fuera de la allowlist → 400, NUNCA ejecuta.
//   - REQ-SEC-H7-5: ráfaga < minInterval → 429, NUNCA ejecuta.
//   - REQ-SEC-H7-3: la ejecución real se delega a `restartFn(target)` que el
//     caller provee — esta lib NO importa `restart.js` ni hace killAll. El test
//     verifica que un `restartFn` espía se llama y que ningún plano global se
//     dispara.
//   - REQ-SEC-H7-4: el audit recibe `source` declarativo + `sourceIp` objetivo.
// =============================================================================

// Rate-limiter en memoria por target. `now` inyectable para tests.
function makeRateLimiter(minIntervalMs) {
    const min = typeof minIntervalMs === 'number' && minIntervalMs >= 0 ? minIntervalMs : 5000;
    const last = new Map();
    return {
        isRateLimited(name, now) {
            const t = typeof now === 'number' ? now : Date.now();
            const prev = last.get(name);
            if (prev != null && (t - prev) < min) return true;
            last.set(name, t);
            return false;
        },
        _last: last,
    };
}

// #5646 (CA-9 / REQ-SEC-5646-4) — Cota AGREGADA de restarts por ventana.
//
// `makeRateLimiter` limita POR TARGET: al pasar de reiniciar 1 componente a N,
// N targets distintos pasan la misma ráfaga y una sola request se convierte en
// "matar todos los servicios del pipeline" — un amplificador de DoS
// auto-infligido. Esta cota es transversal: cuenta restarts totales en la
// ventana, sin importar el target.
//
// Los componentes que no entran quedan pendientes en `stale-services.json` y los
// relanza el watchdog en su ciclo: la cota RETRASA, no pierde trabajo (CA-5).
//
// `now` inyectable para tests.
function makeAggregateLimiter(maxPerWindow, windowMs) {
    const max = typeof maxPerWindow === 'number' && maxPerWindow > 0 ? maxPerWindow : 4;
    const win = typeof windowMs === 'number' && windowMs > 0 ? windowMs : 60000;
    let events = [];
    return {
        /**
         * Reserva hasta `count` cupos. Devuelve cuántos quedaron concedidos
         * (0..count). Los concedidos ya quedan consumidos en la ventana.
         */
        grant(count, now) {
            const t = typeof now === 'number' ? now : Date.now();
            events = events.filter(ts => (t - ts) < win);
            const room = Math.max(0, max - events.length);
            const granted = Math.max(0, Math.min(room, typeof count === 'number' ? count : 0));
            for (let i = 0; i < granted; i++) events.push(t);
            return granted;
        },
        _snapshot() { return events.slice(); },
        maxPerWindow: max,
        windowMs: win,
    };
}

/**
 * Decide y (si corresponde) ejecuta el restart de un servicio.
 *
 * @param {object} params — { target, source, sourceIp, actor }.
 * @param {object} deps — {
 *     allowlist: string[],            // nombres permitidos (COMPONENTS)
 *     restartFn: (name)=>{ok,msg},    // ejecución real AISLADA (stop+start)
 *     rateLimiter?: { isRateLimited(name, now) },
 *     audit?: (record)=>void,         // append al JSONL de audit
 *     now?: number,
 *   }
 * @returns {{ status: 200|400|429, body: { ok:boolean, msg:string } }}
 */
function runRestart(params, deps) {
    const p = params || {};
    const d = deps || {};
    const target = p.target;
    const allowlist = Array.isArray(d.allowlist) ? d.allowlist : [];

    if (!allowlist.includes(target)) {
        return { status: 400, body: { ok: false, msg: `target "${target}" no permitido (fuera de allowlist)` } };
    }
    if (d.rateLimiter && d.rateLimiter.isRateLimited(target, d.now)) {
        return { status: 429, body: { ok: false, msg: `restart de "${target}" ignorado: esperá unos segundos (anti-bucle)` } };
    }

    const result = (typeof d.restartFn === 'function')
        ? d.restartFn(target)
        : { ok: false, msg: 'restartFn no provisto' };

    if (typeof d.audit === 'function') {
        try {
            d.audit({
                service: target,
                source: p.source || 'dashboard-ui',
                sourceIp: p.sourceIp || '',
                actor: p.actor || '',
                ok: !!(result && result.ok),
                msg: (result && result.msg) || '',
            });
        } catch { /* best-effort: el audit no bloquea el restart */ }
    }

    return { status: 200, body: { ok: !!(result && result.ok), msg: (result && result.msg) || '' } };
}

module.exports = { makeRateLimiter, makeAggregateLimiter, runRestart };
