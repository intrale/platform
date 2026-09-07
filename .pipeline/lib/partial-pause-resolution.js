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

// #6118 — Copy de la superficie de Telegram. Módulo puro (sin fs, sin red), se
// puede requerir de arriba sin riesgo. OJO con la frontera: los `msg` de este
// archivo son la respuesta de la API del DASHBOARD, donde "allowlist" es
// vocabulario legítimo y no se toca (CA-14). El texto para el operador de
// Telegram viaja aparte en `operatorMsg`. Empobrecer el `msg` del dashboard
// para satisfacer el test anti-jerga sería resolver el issue equivocado.
const copy = require('./partial-pause-deps-copy');

// `cancel-partial-pause` SIGUE ACÁ a propósito (#6118): lo que se retiró es su
// botón en Telegram, no la acción. El endpoint del dashboard y el comando
// explícito la siguen usando, y ahí el alcance global es lo que el operador
// está mirando.
const RESOLUTIONS = Object.freeze([
    'keep-original',
    'cancel-partial-pause',
    // #6118 — Nuevas. `include-deps-for-issue` es el include ACOTADO al issue
    // que titula la alerta (el viejo `/include-deps` recalcula sobre todo lo
    // habilitado y queda para el banner del dashboard). `mute-alert` sólo
    // silencia: no tiene camino de código hacia ninguna mutación de la
    // selección.
    'include-deps-for-issue',
    'mute-alert',
]);

/** Entero de issue validado. `null` si no es `^\d{1,7}$` (REQ-SEC-3). */
function parseIssueParam(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!/^\d{1,7}$/.test(s)) return null;
    const n = Number(s);
    return n > 0 ? n : null;
}

/**
 * Dependencias faltantes VIGENTES de un issue, leídas del state del servidor.
 *
 * El `callback_data` de Telegram tiene 64 bytes: el set de dependencias no
 * entra, así que el tap sólo trae el número de issue. Todo lo demás se deriva
 * acá. Efecto secundario buscado: si las dependencias cambiaron entre que se
 * emitió el aviso y el tap, se opera sobre las de AHORA, no sobre las que el
 * mensaje viejo mostraba.
 *
 * @returns {number[]} vacío si el issue ya no está frenado
 */
function missingDepsOf(readDepsState, issue) {
    if (typeof readDepsState !== 'function') return [];
    let state = null;
    try { state = readDepsState(); } catch { return []; }
    const missing = state && state.missing;
    if (!missing || typeof missing !== 'object') return [];
    const raw = missing[String(issue)];
    return (Array.isArray(raw) ? raw : [])
        .map(Number)
        .filter(n => Number.isInteger(n) && n > 0);
}

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
function applyResolution({ action, authorizedBy, operatorRef, issue, deps } = {}) {
    if (!RESOLUTIONS.includes(action)) {
        return { status: 404, body: { ok: false, msg: 'resolución desconocida' } };
    }
    const d = deps || {};
    const by = authorizedBy || '';

    // #6118 — Las dos acciones nuevas operan sobre UN issue concreto, así que el
    // parámetro es obligatorio y se valida antes de tocar nada. El entero viene
    // del cliente: se contrasta contra el state del servidor más abajo y nunca
    // se concatena a un path ni a una URL.
    const needsIssue = action === 'include-deps-for-issue' || action === 'mute-alert';
    const issueNum = parseIssueParam(issue);
    if (needsIssue && issueNum === null) {
        return {
            status: 400,
            body: {
                ok: false,
                action,
                msg: 'Issue inválido.',
                operatorMsg: 'No pude identificar el issue de este aviso.',
            },
        };
    }

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
                // #6118 — El operador de Telegram no tiene por qué leer el
                // nombre interno del gate; le alcanza con saber que no se aplicó.
                operatorMsg: copy.buildErrorMessage({ kind: 'forbidden' }),
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
            body: {
                ok: false,
                msg: `Pipeline está en modo "${(state && state.mode) || 'desconocido'}", no en partial_pause`,
                operatorMsg: copy.buildErrorMessage({ kind: 'stale' }),
            },
        };
    }

    // -------------------------------------------------------------------------
    // #6118 · mute-alert — silenciar el aviso, sin tocar NADA más (CA-9).
    //
    // Esta rama va ANTES de las que mutan y sale por su propio `return`: no
    // comparte código con `keep-original` ni con el include, así que no hay
    // camino desde acá hasta `setPartialPause`/`clearPartialPause`. Es
    // verificable por lectura y por test (REQ-SEC-4.4).
    // -------------------------------------------------------------------------
    if (action === 'mute-alert') {
        // La firma se deriva de las dependencias VIGENTES del state, no de las
        // que venían en el mensaje: silenciar tiene que corresponder a la
        // situación real de ahora.
        const vigentes = missingDepsOf(d.readDepsState, issueNum);
        if (vigentes.length === 0) {
            // Anti-replay natural: el tap llegó cuando ya no hay nada frenado.
            return {
                status: 409,
                body: {
                    ok: false,
                    action,
                    issue: issueNum,
                    msg: `El issue #${issueNum} no figura con deps faltantes en el state; nada que silenciar.`,
                    operatorMsg: copy.buildErrorMessage({ kind: 'not-blocked', issue: issueNum }),
                },
            };
        }
        if (typeof d.alertSignature !== 'function' || typeof d.mute !== 'function') {
            return {
                status: 500,
                body: { ok: false, action, msg: 'Falta la primitiva de silencio; no se silencia a ciegas.' },
            };
        }
        const signature = d.alertSignature(issueNum, vigentes);
        const muteTtlMs = Number(d.muteTtlMs) > 0 ? Number(d.muteTtlMs) : undefined;
        const muted = d.mute(signature, {
            issue: issueNum,
            deps: vigentes,
            operatorRef,
            ttlMs: muteTtlMs,
        });
        if (!muted || muted.ok !== true) {
            return {
                status: 500,
                body: {
                    ok: false,
                    action,
                    msg: 'No se pudo persistir el silencio.',
                    operatorMsg: 'No pude guardar el silencio; te voy a seguir avisando.',
                },
            };
        }
        return {
            status: 200,
            body: {
                ok: true,
                action,
                issue: issueNum,
                deps: vigentes,
                signature,
                expiresAt: muted.expiresAt,
                ttlMs: muted.ttlMs,
                msg: `Alerta de deps de #${issueNum} silenciada hasta ${new Date(muted.expiresAt).toISOString()}; el allowlist queda igual.`,
                operatorMsg: copy.buildConfirmation({
                    action, issue: issueNum, deps: vigentes, muteTtlMs: muted.ttlMs,
                }),
            },
        };
    }

    // -------------------------------------------------------------------------
    // #6118 · include-deps-for-issue — habilitar SÓLO las dependencias del issue
    // que titula esta alerta (CA-5).
    //
    // El endpoint viejo (`/include-deps`) recalcula sobre TODO lo habilitado, así
    // que con dos issues alertados a la vez el tap sobre uno arrastraba también
    // las dependencias del otro. Acá el conjunto sale del issue del request y de
    // nadie más: con #6033 y #6040 alertados, tocar el botón de #6033 no toca a
    // #6041.
    // -------------------------------------------------------------------------
    if (action === 'include-deps-for-issue') {
        const vigentes = missingDepsOf(d.readDepsState, issueNum);
        if (vigentes.length === 0) {
            return {
                status: 409,
                body: {
                    ok: false,
                    action,
                    issue: issueNum,
                    msg: `El issue #${issueNum} no figura con deps faltantes en el state; nada que incluir.`,
                    operatorMsg: copy.buildErrorMessage({ kind: 'not-blocked', issue: issueNum }),
                },
            };
        }
        if (typeof d.setPartialPause !== 'function') {
            return {
                status: 500,
                body: { ok: false, action, msg: 'Falta la primitiva de escritura; no se muta a ciegas.' },
            };
        }

        const previos = Array.isArray(state.allowedIssues) ? state.allowedIssues.map(Number) : [];
        const finalList = [...new Set([...previos, ...vigentes])].sort((a, b) => a - b);
        const agregados = vigentes.filter(n => !previos.includes(n));

        // `setPartialPause` REESCRIBE el marker desde sus argumentos: lo que no
        // se le pasa, se pierde. Por eso se re-inyectan explícitamente los skills
        // habilitados, el origen de cada dependencia previa y la metadata de la
        // ola (que `getPipelineMode` no expone y hay que leer del marker crudo).
        // Sin esto, habilitar una dependencia borraría la identidad de la ola
        // activa como daño colateral.
        const depSources = {};
        for (const n of vigentes) depSources[String(n)] = 'auto-deps';
        if (state.depSources && typeof state.depSources === 'object') {
            for (const [k, v] of Object.entries(state.depSources)) {
                if (!(k in depSources)) depSources[k] = v;
            }
        }
        let waveMeta = {};
        if (typeof d.readWaveMeta === 'function') {
            try { waveMeta = d.readWaveMeta() || {}; } catch { waveMeta = {}; }
        }

        const result = d.setPartialPause(finalList, {
            source: 'telegram-partial-pause-deps',
            authorizedBy: authorizedByValid,
            justification: `Operador habilitó las dependencias de #${issueNum} (${vigentes.join(',')}) desde la alerta`
                + operatorSuffix,
            allowedSkills: Array.isArray(state.allowedSkills) ? state.allowedSkills : undefined,
            acceptedDepRisk: false,   // al incluir las deps ya no hay riesgo asumido
            depSources,
            authorizationTtls: state.authorizationTtls || undefined,
            ...waveMeta,
        });
        if (!result || result.ok !== true) {
            return {
                status: 403,
                body: {
                    ok: false,
                    action,
                    msg: 'El gate de autorización rechazó incluir las dependencias.',
                    operatorMsg: copy.buildErrorMessage({ kind: 'forbidden' }),
                },
            };
        }
        // El issue ya no está frenado: se lo saca del state para que el banner y
        // el próximo barrido no lo sigan reportando. Los OTROS issues alertados
        // siguen ahí — borrar el archivo entero los volvería invisibles.
        if (typeof d.dropIssueFromDepsState === 'function') {
            try { d.dropIssueFromDepsState(issueNum); } catch { /* best-effort */ }
        }
        return {
            status: 200,
            body: {
                ok: true,
                action,
                issue: issueNum,
                addedDeps: agregados,
                allowedIssues: result.allowedIssues || finalList,
                msg: `Se agregaron al allowlist las deps de #${issueNum}: ${agregados.join(', ') || '(ya estaban)'}.`,
                operatorMsg: copy.buildConfirmation({ action, issue: issueNum, deps: vigentes }),
            },
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
        // #6118 — Se leen las dependencias ANTES de mutar: `clearDepsState()`
        // borra el state más abajo, y sin ellas la confirmación no podría
        // nombrar a quién se está dejando de esperar.
        const vigentesKeep = issueNum !== null ? missingDepsOf(d.readDepsState, issueNum) : [];
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
                    body: {
                        ok: false,
                        action,
                        msg: 'La pausa parcial ya no está activa; esa decisión perdió sentido.',
                        operatorMsg: copy.buildErrorMessage({ kind: 'stale' }),
                    },
                };
            }
            return {
                status: 403,
                body: {
                    ok: false,
                    action,
                    msg: 'El gate de autorización rechazó el cambio.',
                    operatorMsg: copy.buildErrorMessage({ kind: 'forbidden' }),
                },
            };
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
                // #6118 — La versión para Telegram NO dice "bloqueado": el flag
                // que se acaba de escribir no frena nada, el issue sigue
                // avanzando. Prometer lo contrario reproduciría, en el mismo
                // commit, el defecto que este issue vino a corregir (UX-D-1).
                operatorMsg: copy.buildConfirmation({
                    action, issue: issueNum, deps: vigentesKeep,
                }),
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
