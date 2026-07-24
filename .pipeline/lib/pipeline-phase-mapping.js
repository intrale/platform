// =============================================================================
// pipeline-phase-mapping.js — Mapping canónico de aliases del operador a fases
// =============================================================================
//
// Issue: #3416 — rebobinado del pipeline por rechazo del operador.
//
// El operador dispara `/rechazar <issue> <alias>` y este módulo resuelve el
// alias a un destino concreto `{pipeline, fase, skill}` sobre el cual el
// pulpo va a rebobinar.
//
// Reglas de seguridad (SEC-3 del análisis del security agent):
//   - Whitelist enum cerrada. Cualquier alias fuera del set se rechaza con
//     `code: 'ALIAS_NOT_IN_WHITELIST'`. No hay matching parcial, fuzzy ni
//     defaults silenciosos.
//   - Normalización: lowercase + trim. Sin case-insensitive bypass.
//   - El resolver NO consulta filesystem ni red — recibe `currentPosition` y
//     `config` como entrada. Es función pura para que los tests sean veloces
//     y la lógica de validación sea inspeccionable sin mocks pesados.
//
// Decisión 2 del PO (alias ambiguo):
//   - Alias explícito (con guión, ej. `validacion-ux`, `criterios-ux`) → mapeo
//     directo a la entrada del enum.
//   - Alias ambiguo (sin guión, ej. `ux`, `po`, `guru`) → buscar el skill en
//     la fase actual del issue y en todas las fases anteriores en orden
//     inverso (más cercana primero). Primera ocurrencia gana. Si ninguna
//     fase upstream contiene el skill → error específico.
//
// =============================================================================
'use strict';

// Entradas del enum.
//   - `explicit: true`  → ya tiene `{pipeline, fase, skill}` fijos. Resolver
//     devuelve esa terna sin mirar `currentPosition`.
//   - `explicit: false` → solo trae `skill`. Resolver calcula el upstream más
//     cercano usando `currentPosition` y el orden de fases del `config`.
const PHASE_MAPPING = Object.freeze({
    // Definición — criterios (PO)
    refinar:        { pipeline: 'definicion', fase: 'criterios', skill: 'po', explicit: true },
    refinamiento:   { pipeline: 'definicion', fase: 'criterios', skill: 'po', explicit: true },
    criterios:      { pipeline: 'definicion', fase: 'criterios', skill: 'po', explicit: true },
    po:             { skill: 'po', explicit: false },

    // UX (ambiguo por default — `ux/mockup/diseno` resuelven al upstream más cercano)
    ux:             { skill: 'ux', explicit: false },
    mockup:         { skill: 'ux', explicit: false },
    diseno:         { skill: 'ux', explicit: false },

    // Guru / análisis técnico
    guru:           { skill: 'guru', explicit: false },
    analisis:       { pipeline: 'definicion', fase: 'analisis', skill: 'guru', explicit: true },
    tecnico:        { skill: 'guru', explicit: false },

    // Security (siempre en analisis de definicion)
    security:       { pipeline: 'definicion', fase: 'analisis', skill: 'security', explicit: true },

    // Planner / sizing
    plan:           { pipeline: 'definicion', fase: 'sizing', skill: 'planner', explicit: true },
    planner:        { pipeline: 'definicion', fase: 'sizing', skill: 'planner', explicit: true },
    sizing:         { pipeline: 'definicion', fase: 'sizing', skill: 'planner', explicit: true },
    arquitectura:   { pipeline: 'definicion', fase: 'sizing', skill: 'planner', explicit: true },

    // Alias explícitos para desarrollo/validacion
    'validacion-po':   { pipeline: 'desarrollo', fase: 'validacion', skill: 'po', explicit: true },
    'validacion-ux':   { pipeline: 'desarrollo', fase: 'validacion', skill: 'ux', explicit: true },
    'validacion-guru': { pipeline: 'desarrollo', fase: 'validacion', skill: 'guru', explicit: true },

    // Alias explícitos para definicion/criterios-ux (UX en criterios)
    'criterios-ux':    { pipeline: 'definicion', fase: 'criterios', skill: 'ux', explicit: true },
    'criterios-po':    { pipeline: 'definicion', fase: 'criterios', skill: 'po', explicit: true },

    // Alias explícitos para desarrollo/aprobacion
    'aprobacion-po':   { pipeline: 'desarrollo', fase: 'aprobacion', skill: 'po', explicit: true },
    'aprobacion-ux':   { pipeline: 'desarrollo', fase: 'aprobacion', skill: 'ux', explicit: true },
    review:            { pipeline: 'desarrollo', fase: 'aprobacion', skill: 'review', explicit: true },
});

/**
 * Lista todos los aliases válidos en orden alfabético. Útil para mensajes
 * de error al operador y para la doc operativa.
 */
function listAliases() {
    return Object.keys(PHASE_MAPPING).sort();
}

/**
 * Normaliza un alias del operador: lowercase + trim. Sin matching parcial
 * (intencional, ver SEC-3).
 */
function normalizeAlias(alias) {
    if (typeof alias !== 'string') return '';
    return alias.trim().toLowerCase();
}

/**
 * Devuelve el orden global de `{pipeline, fase}` según el config. El orden
 * representa el flujo natural del pipeline (definicion → desarrollo) y se
 * usa para decidir "upstream" (más cercano = índice menor desde el actual).
 */
function getGlobalPhaseOrder(config) {
    const order = [];
    const pipelines = (config && config.pipelines) || {};
    for (const [pipelineName, pipelineCfg] of Object.entries(pipelines)) {
        const fases = (pipelineCfg && pipelineCfg.fases) || [];
        for (const fase of fases) {
            order.push({ pipeline: pipelineName, fase });
        }
    }
    return order;
}

/**
 * Devuelve el índice global de la fase `{pipeline, fase}` en el orden de
 * `config`. -1 si la fase no existe (defensivo — config.yaml mal formado).
 */
function indexOfPhase(pipeline, fase, config) {
    const order = getGlobalPhaseOrder(config);
    return order.findIndex(p => p.pipeline === pipeline && p.fase === fase);
}

/**
 * Indica si la terna `{pipeline, fase}` `target` está upstream (estrictamente
 * anterior O igual) respecto a `current`. "Anterior o igual" porque rebobinar
 * a la misma fase actual del issue está permitido (rehacer el último skill).
 *
 * Devuelve `false` si alguna fase no existe en el config (defensivo).
 */
function isUpstreamOrSame(currentPipeline, currentFase, targetPipeline, targetFase, config) {
    const idxCurrent = indexOfPhase(currentPipeline, currentFase, config);
    const idxTarget = indexOfPhase(targetPipeline, targetFase, config);
    if (idxCurrent < 0 || idxTarget < 0) return false;
    return idxTarget <= idxCurrent;
}

/**
 * Resuelve un alias del operador contra la posición actual del issue + config.
 *
 * @param {string} alias — alias raw del operador (se normaliza adentro).
 * @param {{pipeline: string, fase: string}|null} currentPosition — posición
 *   actual del issue en el pipeline (de `getCurrentIssuePosition`). Puede ser
 *   `null` si el resolver es invocado fuera de contexto (tests, dry-run).
 *   Para aliases ambiguos `currentPosition` es obligatorio.
 * @param {object} config — `config.yaml` cargado.
 *
 * @returns {{
 *   ok: boolean,
 *   code?: string,
 *   message?: string,
 *   target?: {pipeline: string, fase: string, skill: string, explicit: boolean},
 *   normalizedAlias?: string,
 * }}
 */
function resolveAlias(alias, currentPosition, config) {
    const normalized = normalizeAlias(alias);
    if (!normalized) {
        return {
            ok: false,
            code: 'ALIAS_EMPTY',
            message: 'El alias no puede ser vacío. Aliases válidos: ' + listAliases().join(', '),
        };
    }

    const entry = PHASE_MAPPING[normalized];
    if (!entry) {
        return {
            ok: false,
            code: 'ALIAS_NOT_IN_WHITELIST',
            message: `El alias "${normalized}" no está en la whitelist. Aliases válidos: ${listAliases().join(', ')}`,
            normalizedAlias: normalized,
        };
    }

    // Caso explícito: ya trae pipeline + fase + skill cerrados.
    if (entry.explicit) {
        return {
            ok: true,
            normalizedAlias: normalized,
            target: {
                pipeline: entry.pipeline,
                fase: entry.fase,
                skill: entry.skill,
                explicit: true,
            },
        };
    }

    // Caso ambiguo: necesitamos `currentPosition` para resolver el upstream
    // más cercano que contenga el skill.
    if (!currentPosition || !currentPosition.pipeline || !currentPosition.fase) {
        return {
            ok: false,
            code: 'AMBIGUOUS_ALIAS_NEEDS_POSITION',
            message: `El alias "${normalized}" es ambiguo (no especifica fase) y no se pudo determinar la posición actual del issue. Probá un alias explícito (ej. validacion-${entry.skill} o criterios-${entry.skill}).`,
            normalizedAlias: normalized,
        };
    }

    const idxCurrent = indexOfPhase(currentPosition.pipeline, currentPosition.fase, config);
    if (idxCurrent < 0) {
        return {
            ok: false,
            code: 'CURRENT_POSITION_NOT_IN_CONFIG',
            message: `La fase actual del issue (${currentPosition.pipeline}/${currentPosition.fase}) no está en el config. Revisar config.yaml.`,
            normalizedAlias: normalized,
        };
    }

    const order = getGlobalPhaseOrder(config);
    const pipelines = (config && config.pipelines) || {};

    // Recorrer desde la fase actual hacia atrás (incluyendo la actual).
    for (let i = idxCurrent; i >= 0; i--) {
        const candidate = order[i];
        const skillsHere = ((pipelines[candidate.pipeline] || {}).skills_por_fase || {})[candidate.fase] || [];
        if (skillsHere.includes(entry.skill)) {
            return {
                ok: true,
                normalizedAlias: normalized,
                target: {
                    pipeline: candidate.pipeline,
                    fase: candidate.fase,
                    skill: entry.skill,
                    explicit: false,
                },
            };
        }
    }

    return {
        ok: false,
        code: 'SKILL_NOT_FOUND_UPSTREAM',
        message: `El skill "${entry.skill}" no participa en ninguna fase upstream del issue (posición actual: ${currentPosition.pipeline}/${currentPosition.fase}). Revisá si el alias corresponde al pipeline del issue.`,
        normalizedAlias: normalized,
    };
}

module.exports = {
    PHASE_MAPPING,
    listAliases,
    normalizeAlias,
    getGlobalPhaseOrder,
    indexOfPhase,
    isUpstreamOrSame,
    resolveAlias,
};
