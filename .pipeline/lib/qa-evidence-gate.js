// =============================================================================
// qa-evidence-gate.js — Resolución de qaMode y bypass de evidencia audiovisual
//
// Issue #2351 — El gate-evidencia-on-exit venía exigiendo video+audio a issues
// QA-API puros, generando falsos rechazos y disparando el rejection-report con
// el pattern-match "APK no se pudo generar" como fantasma. La causa real era
// que `qaMode` se leía sólo del YAML del agente (manipulable por el propio
// agente QA) en vez de tomarlo del preflight del Pulpo como fuente de verdad.
//
// Este módulo implementa R1 de la auditoría de seguridad:
//   "Detección de qaMode por whitelist explícito, no por ausencia de app:*".
//
// Reglas:
//   - `qaMode === 'api'` o `qaMode === 'structural'` → salta evidencia
//     audiovisual (la fase QA no produce video ni audio por diseño).
//   - Cualquier otro valor (`android`, `ui`, undefined, null, '') → exige
//     evidencia. Nunca inferimos el modo por ausencia de labels.
//   - El modo autoritativo viene del preflight del Pulpo (parámetro
//     `authoritativeQaMode`). Si ese valor falta, se cae al YAML del agente
//     como fallback (no debería pasar en flujo normal porque el Pulpo inyecta
//     `data.modo = preflightResult.qaMode` antes de lanzar al agente QA).
//
// Este archivo es PURE JS — sin dependencias de fs/net — para que sea trivial
// de testear con `node --test`.
// =============================================================================
'use strict';

const SKIPPABLE_QA_MODES = Object.freeze(['api', 'structural']);

/**
 * Normaliza un valor cualquiera a string lowercase trimado.
 * Devuelve '' para null/undefined/no-string.
 */
function normalizeMode(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim().toLowerCase();
}

/**
 * Resuelve el qaMode efectivo priorizando la fuente autoritativa del preflight.
 *
 * @param {object} opts
 * @param {string|null} opts.authoritative - qaMode inyectado por el Pulpo (fuente de verdad).
 * @param {string|null} opts.yamlMode - qaMode leído del YAML del agente (fallback).
 * @returns {{ mode: string, source: 'preflight'|'yaml'|'none' }}
 */
function resolveQaMode({ authoritative, yamlMode } = {}) {
    const pre = normalizeMode(authoritative);
    if (pre) return { mode: pre, source: 'preflight' };
    const yml = normalizeMode(yamlMode);
    if (yml) return { mode: yml, source: 'yaml' };
    return { mode: '', source: 'none' };
}

/**
 * Devuelve true si el modo resuelto debe saltar la evidencia audiovisual.
 * Implementa R1: whitelist explícita, nunca inferir por ausencia.
 *
 * @param {string} qaMode - valor ya normalizado (lowercase).
 */
function shouldSkipVisualEvidence(qaMode) {
    return SKIPPABLE_QA_MODES.includes(normalizeMode(qaMode));
}

/**
 * Construye el payload estructurado de un bypass del gate (R3).
 * El logger del Pulpo serializa este objeto como JSON inline para auditoría.
 *
 * @param {object} ctx
 * @param {string|number} ctx.issue
 * @param {string} ctx.qaMode
 * @param {'preflight'|'yaml'|'none'} ctx.source
 * @param {string[]} [ctx.labels]
 * @returns {object}
 */
function buildBypassEvent({ issue, qaMode, source, labels = [] }) {
    const mode = normalizeMode(qaMode);
    return {
        event: 'gate-bypass',
        issue: String(issue),
        qaMode: mode,
        source,
        labels: Array.isArray(labels) ? labels.slice() : [],
        decision: 'skip-video',
        reason: mode === 'api'
            ? 'QA-API no requiere evidencia audiovisual'
            : mode === 'structural'
                ? 'QA estructural no requiere evidencia audiovisual'
                : 'qaMode no requiere evidencia audiovisual',
    };
}

/**
 * Formatea el evento estructurado para imprimir junto al log textual del
 * Pulpo. Mantiene el prefijo legible del log existente y adjunta un JSON
 * compacto para que herramientas (monitor, grep) puedan parsearlo.
 */
function formatBypassLogLine(event) {
    return `🟢 gate-bypass #${event.issue} qaMode=${event.qaMode || '?'} source=${event.source} — ${event.reason} ${JSON.stringify(event)}`;
}

module.exports = {
    SKIPPABLE_QA_MODES,
    normalizeMode,
    resolveQaMode,
    shouldSkipVisualEvidence,
    buildBypassEvent,
    formatBypassLogLine,
};
