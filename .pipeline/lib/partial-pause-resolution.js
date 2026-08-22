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
 * @param {string} args.authorizedBy  - origen autorizado; DEBE estar en el enum
 *                                      cerrado de #3625 (ver validación abajo).
 * @param {string} [args.operatorRef] - identidad fina del operador (from.id de
 *                                      Telegram). Viaja por justification/extra,
 *                                      NO por authorizedBy: el enum es de clase
 *                                      de origen, no de identidad.
 * @param {object} args.deps
 * @param {function} args.deps.getPipelineMode
 * @param {function} args.deps.markDepRiskAccepted - merge no destructivo (#5923).
 * @param {function} args.deps.clearPartialPause
 * @param {function} [args.deps.validateAuthorizedBy] - default: el del audit real.
 * @param {function} [args.deps.clearDepsState] - borra partial-pause-deps-state.json.
 * @returns {{status:number, body:object}}
 */
function applyResolution({ action, authorizedBy, operatorRef, deps } = {}) {
    if (!RESOLUTIONS.includes(action)) {
        return { status: 404, body: { ok: false, msg: 'resolución desconocida' } };
    }
    const d = deps || {};
    const by = authorizedBy || '';

    // -------------------------------------------------------------------------
    // #5923 — Validación DURA de `authorizedBy` contra el enum cerrado de #3625,
    // ANTES de tocar nada.
    //
    // Antes acá se pasaba `telegram:<from.id>` (y un fallback `dashboard-local`),
    // valores que NO están en `AUTHORIZED_BY_STATIC`. El botón funcionaba sólo
    // porque el gate estricto viene OFF por default (grace period), y a cambio
    // ensuciaba el audit con `gate_grace:true` + `authorized_by_not_in_enum`.
    // Al activarse el strict —que es el end-state documentado del grace—
    // `cancel-partial-pause` habría devuelto 403 PARA SIEMPRE: un botón muerto
    // permanente, exactamente la clase de falla que este issue vino a erradicar.
    //
    // Validando acá el comportamiento es el MISMO con strict ON u OFF: o el
    // origen está registrado en el enum, o no se muta. Sin dependencia de un
    // flag de entorno que algún día cambia de default.
    // -------------------------------------------------------------------------
    const validate = d.validateAuthorizedBy
        || require('./partial-pause-audit').validateAuthorizedBy;
    const validation = validate(by);
    if (!validation || validation.valid !== true) {
        return {
            status: 403,
            body: {
                ok: false,
                action,
                msg: `Origen de autorización no registrado (${(validation && validation.reason) || 'invalid'}).`,
            },
        };
    }
    const authorizedByValid = validation.normalized || by;
    // Trazabilidad fina del operador concreto, sin ensanchar el enum.
    const operatorSuffix = operatorRef ? ` [operador ${String(operatorRef).slice(0, 64)}]` : '';

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
        // ---------------------------------------------------------------------
        // "Seguir sólo con el issue original" = NO cambiar el allowlist. Sólo se
        // deja constancia de que el riesgo de deps abiertas fue aceptado.
        //
        // Por eso NO se usa `setPartialPause`: esa primitiva REESCRIBE el marker
        // desde sus argumentos, así que perdía `allowed_skills` (#3680) y la
        // wave metadata (#4030) —que `getPipelineMode()` ni siquiera expone—, y
        // con `allowed_issues` vacío (pausa parcial activa sólo por skills)
        // delegaba en `clearPartialPause`: el botón LEVANTABA la pausa parcial
        // entera, sin la confirmación de doble tap que esa acción exige, y con
        // un toast que afirmaba lo contrario.
        //
        // `markDepRiskAccepted` es un merge sobre el marker vigente: no tiene
        // camino de código que borre el marker ni que vacíe el allowlist.
        // ---------------------------------------------------------------------
        if (typeof d.markDepRiskAccepted !== 'function') {
            return {
                status: 500,
                body: { ok: false, action, msg: 'Falta la primitiva de merge; no se muta a ciegas.' },
            };
        }
        const result = d.markDepRiskAccepted({
            source: 'telegram-partial-pause-deps',
            authorizedBy: authorizedByValid,
            justification: 'Operador eligió seguir sólo con el issue original (deps abiertas asumidas)' + operatorSuffix,
        });
        if (!result || result.ok !== true) {
            // El marker pudo desaparecer entre el `getPipelineMode` y el merge:
            // eso es la misma condición que el anti-replay, no un fallo de authz.
            if (result && result.reason === 'no_partial_pause') {
                return {
                    status: 409,
                    body: { ok: false, action, msg: 'La pausa parcial ya no está activa; esa decisión perdió sentido.' },
                };
            }
            return { status: 403, body: { ok: false, action, msg: 'El gate de autorización rechazó el cambio.' } };
        }
        if (d.clearDepsState) d.clearDepsState();
        const allowedIssues = result.allowedIssues || [];
        const allowedSkills = result.allowedSkills || [];
        // El toast tiene que describir lo que REALMENTE quedó habilitado: con
        // pausa parcial por skills, "0 issues" a secas era un mensaje engañoso.
        const scope = allowedSkills.length > 0
            ? `${allowedIssues.length} issue${allowedIssues.length === 1 ? '' : 's'} y ${allowedSkills.length} skill${allowedSkills.length === 1 ? '' : 's'}`
            : `${allowedIssues.length} issue${allowedIssues.length === 1 ? '' : 's'}`;
        return {
            status: 200,
            body: {
                ok: true,
                action,
                allowedIssues,
                allowedSkills,
                msg: `Se mantiene el allowlist actual (${scope}); el riesgo de deps abiertas queda asumido.`,
            },
        };
    }

    // cancel-partial-pause → levantar la pausa parcial completa. `clearPartialPause`
    // exige `authorizedBy` válido por ser un removal masivo: por eso viaja el
    // operador real y no un literal hardcodeado.
    const cleared = d.clearPartialPause({
        source: 'telegram-partial-pause-deps',
        authorizedBy: authorizedByValid,
        justification: 'Operador levantó la pausa parcial desde la alerta de deps trabadas' + operatorSuffix,
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
