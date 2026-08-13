// =============================================================================
// partial-pause-resolution.js — Las 2 resoluciones que faltaban de "pausa
// parcial trabada" (issue #5923).
//
// La alerta ofrece 3 salidas, pero hasta ahora sólo `include-deps` tenía
// endpoint: `keep-original` y `cancel-partial-pause` tenían CERO ocurrencias en
// `dashboard.js`. O sea que aunque el saliente hubiera llegado (no llegaba: la
// Bot API rechaza botones `url` a localhost), 2 de 3 botones eran botones
// muertos. Este módulo es su implementación, con todas las dependencias
// inyectables para poder testearlas sin levantar el dashboard.
// =============================================================================
'use strict';

const RESOLUTIONS = Object.freeze(['keep-original', 'cancel-partial-pause']);

/**
 * @param {object} args
 * @param {string} args.action        - 'keep-original' | 'cancel-partial-pause'
 * @param {string} args.authorizedBy  - operador ya saneado (ver dashboard-request-gate).
 * @param {object} args.deps
 * @param {function} args.deps.getPipelineMode
 * @param {function} args.deps.setPartialPause
 * @param {function} args.deps.clearPartialPause
 * @param {function} [args.deps.clearDepsState] - borra partial-pause-deps-state.json.
 * @returns {{status:number, body:object}}
 */
function applyResolution({ action, authorizedBy, deps } = {}) {
    if (!RESOLUTIONS.includes(action)) {
        return { status: 404, body: { ok: false, msg: 'resolución desconocida' } };
    }
    const d = deps || {};
    const by = authorizedBy || 'dashboard-local';

    const state = d.getPipelineMode();

    // Anti-replay: el `callback_data` de Telegram no tiene nonce ni TTL y el
    // mensaje vive para siempre en el chat. Si ya no estamos en pausa parcial,
    // la decisión que ese mensaje proponía perdió sentido: 409, no doble
    // mutación. Retirar el teclado es best-effort y NO cuenta como anti-replay.
    if (!state || state.mode !== 'partial_pause') {
        return {
            status: 409,
            body: { ok: false, msg: `Pipeline está en modo "${(state && state.mode) || 'desconocido'}", no en partial_pause` },
        };
    }

    if (action === 'keep-original') {
        // Seguir sólo con lo que ya está habilitado: no se suma nada, se deja
        // constancia de que el riesgo de deps abiertas fue aceptado y se limpia
        // el state de deps para que la alerta no reincida con lo mismo.
        const result = d.setPartialPause(state.allowedIssues, {
            source: 'telegram-partial-pause-deps',
            acceptedDepRisk: true,
            depSources: state.depSources || undefined,
            authorizedBy: by,
            justification: 'Operador eligió seguir sólo con el issue original (deps abiertas asumidas)',
        });
        if (!result || result.ok === false) {
            return { status: 403, body: { ok: false, action, msg: 'El gate de autorización rechazó el cambio.' } };
        }
        if (d.clearDepsState) d.clearDepsState();
        const allowedIssues = result.allowedIssues || state.allowedIssues || [];
        return {
            status: 200,
            body: {
                ok: true,
                action,
                allowedIssues,
                msg: `Se mantiene el allowlist actual (${allowedIssues.length} issue${allowedIssues.length === 1 ? '' : 's'}); el riesgo de deps abiertas queda asumido.`,
            },
        };
    }

    // cancel-partial-pause → levantar la pausa parcial completa. `clearPartialPause`
    // exige `authorizedBy` válido por ser un removal masivo: por eso viaja el
    // operador real y no un literal hardcodeado.
    const cleared = d.clearPartialPause({
        source: 'telegram-partial-pause-deps',
        authorizedBy: by,
        justification: 'Operador levantó la pausa parcial desde la alerta de deps trabadas',
    });
    if (!cleared || cleared.ok !== true) {
        return { status: 403, body: { ok: false, action, msg: 'El gate de autorización rechazó levantar la pausa parcial.' } };
    }
    if (d.clearDepsState) d.clearDepsState();
    return {
        status: 200,
        body: {
            ok: true,
            action,
            existed: !!cleared.existed,
            msg: 'Pausa parcial levantada. El pipeline vuelve a tomar todo el backlog.',
        },
    };
}

module.exports = { applyResolution, RESOLUTIONS };
