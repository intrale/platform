'use strict';

// =============================================================================
// android-dev-deliverable-guard.js — Enforcement de entregable obligatorio
// para el cierre de fase `dev` del agente `android-dev` (#4507).
//
// Decisión PURA (sin side effects, sin filesystem, sin GitHub) que el barrido de
// `pulpo.js` invoca para clasificar el estado del cierre en una de tres ramas:
//
//   - `exception` — el agente declaró `entregable_no_aplica: "<motivo>"`. Se
//     registra una excepción explícita y auditable en el store (#4255) y se
//     disponibiliza el motivo por Telegram. NO se materializa artefacto físico.
//
//   - `error` — CIERRE SILENCIOSO: aprobó sin adjunto, sin notas sustantivas y
//     sin declarar `entregable_no_aplica`. Ya no es válido (la doctrina dejó de
//     ser warn-only para esta fila). El barrido lo marca como incidencia
//     auditable — no puede quedar `resultado: aprobado` sin rastro.
//
//   - `ok` — hay adjunto físico o notas sustantivas: el flujo normal (fallback
//     determinístico que materializa el `.md`) cubre el entregable.
//
// El enforcement estricto se limita a `android-dev`/`dev` (el resto de skills
// mantiene el fallback general best-effort). El caller decide ese scope; este
// helper sólo evalúa el estado.
//
// Doctrina: docs/pipeline/entregables-multimedia-por-agente.md
// =============================================================================

// Umbral anti-ruido: mismas 80 chars que el fallback determinístico de pulpo.js
// usa para distinguir una nota sustantiva de un "aprobado" seco.
const DEFAULT_MIN_SUBSTANTIVE_CHARS = 80;

// Motivo sintético para el cierre silencioso. Deja claro que es una incidencia
// accionable, no una excepción legítima declarada por el agente.
const SILENT_CLOSE_MOTIVO =
    'ERROR accionable (#4507): android-dev cerró la fase dev con resultado aprobado ' +
    'pero sin nota de implementación sustantiva, sin adjunto físico y sin declarar ' +
    'entregable_no_aplica. El entregable de cierre es obligatorio: regenerar la nota ' +
    'con writeDeliverable("android-dev", issue, { fase: "dev", md }) o declarar ' +
    'entregable_no_aplica con un motivo explícito.';

/**
 * Evalúa el estado del cierre de fase para `android-dev`/`dev`.
 *
 * @param {object} input
 * @param {*} input.entregableNoAplica - valor crudo de `r.entregable_no_aplica`
 *     del YAML del agente (puede no ser string).
 * @param {Array} [input.attachments]  - adjuntos físicos ya resueltos (`r.attachments`).
 * @param {string} [input.notas]       - notas del agente (`r.notas`).
 * @param {string} [input.motivo]      - motivo del agente (`r.motivo`), fallback de notas.
 * @param {number} [input.minSubstantiveChars] - override del umbral anti-ruido.
 * @returns {{action:'exception'|'error'|'ok', motivo?:string, reason?:string}}
 */
function evaluateDeliverableClosure(input = {}) {
    const {
        entregableNoAplica,
        attachments,
        notas,
        motivo,
        minSubstantiveChars = DEFAULT_MIN_SUBSTANTIVE_CHARS,
    } = input;

    const motivoExc = typeof entregableNoAplica === 'string' ? entregableNoAplica.trim() : '';
    if (motivoExc) {
        return { action: 'exception', motivo: motivoExc };
    }

    const sinAdjuntos = !Array.isArray(attachments) || attachments.length === 0;
    if (!sinAdjuntos) {
        return { action: 'ok', reason: 'has_attachment' };
    }

    const notasRaw =
        (typeof notas === 'string' && notas.trim().length > 0) ? notas
        : (typeof motivo === 'string' && motivo.trim().length > 0) ? motivo
        : '';
    if (notasRaw.trim().length >= minSubstantiveChars) {
        return { action: 'ok', reason: 'substantive_notes' };
    }

    return { action: 'error', motivo: SILENT_CLOSE_MOTIVO };
}

/**
 * Selecciona qué rama del barrido de cierre de `pulpo.js` debe ejecutarse, dado
 * el estado YA resuelto del entregable. Espeja las dos condiciones del barrido
 * (fallback `.md` determinístico vs excepción genérica `no_aplica`).
 *
 * Regla #4507 (CA-3, fix del clobber): si el enforcement específico de
 * `android-dev`/`dev` YA manejó el entregable (`entregableManejado === true`,
 * porque el guard registró una excepción declarada o una incidencia de cierre
 * silencioso), NINGUNA rama genérica debe volver a escribir el índice. La rama de
 * excepción genérica usa un motivo fijo ("entregable no aplica: cierre sin nota
 * sustantiva") y, al compartir la clave idempotente `agente::fase`, PISABA por
 * "último-write-gana" el motivo declarado por el agente (o el SILENT_CLOSE_MOTIVO
 * accionable). Por eso `entregableManejado` bloquea AMBAS ramas, no sólo la
 * primera.
 *
 * @param {object} input
 * @param {boolean} input.sinAdjuntos       - no hay adjuntos físicos tras el barrido.
 * @param {boolean} input.esSustantiva      - las notas originales alcanzan el umbral (≥80 chars).
 * @param {boolean} input.entregableManejado - el guard android-dev/dev ya escribió el índice.
 * @returns {'fallback_md'|'generic_exception'|'none'}
 */
function selectClosureBranch(input = {}) {
    const { sinAdjuntos, esSustantiva, entregableManejado } = input;
    if (entregableManejado) return 'none';
    if (sinAdjuntos && esSustantiva) return 'fallback_md';
    if (sinAdjuntos && !esSustantiva) return 'generic_exception';
    return 'none';
}

module.exports = {
    evaluateDeliverableClosure,
    selectClosureBranch,
    DEFAULT_MIN_SUBSTANTIVE_CHARS,
    SILENT_CLOSE_MOTIVO,
};
