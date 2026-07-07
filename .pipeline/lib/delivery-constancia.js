'use strict';

// =============================================================================
// delivery-constancia.js — #4517
//
// Garantía DETERMINÍSTICA de la CONSTANCIA DE ENTREGA que el agente `delivery`
// debe producir al cerrar la fase `entrega`. Cierra el *gap de garantía* de la
// fila 13 del épico #4255: "no puede volver a pasar que delivery cierre la fase
// sin producir el entregable".
//
// Mismo patrón que las garantías reales de `guru`/`analisis` (#4504) y
// `ux`/`criterios` (#4503) que viven inline en `pulpo.js`, pero extraído a una
// lib PURA y TESTEABLE (los bloques inline no eran verificables con `node --test`):
//
//   - CA-1: materializa la constancia de forma INCONDICIONAL, sin el umbral
//     anti-ruido de 80 chars del fallback genérico (#4466, `esSustantiva`). Si
//     delivery aprueba con notas cortas/vacías, igual queda constancia indexada.
//   - CA-4: cuando no hay contenido (merge no aplicó, doc puro), registra una
//     EXCEPCIÓN explícita con motivo — nunca un cierre silencioso.
//   - SEC-DEL-1: enruta SIEMPRE por `writeDeliverable`/`writeDeliverableException`,
//     que redactan secrets por default (`redact=true`). NUNCA `writeFileSync`
//     directo, NUNCA `redact:false`, NUNCA ruta directa a Telegram.
//   - SEC-DEL-5 (idempotencia ante rebote): si YA hay una entrada
//     `delivery`/`entrega` indexada (p.ej. la escribió el propio SKILL.md por la
//     Opción A), NO duplica ni concatena. `writeDeliverable` además es snapshot
//     (overwrite), así que una re-escritura reemplaza — nunca acumula.
//
// Doctrina y contexto: docs/pipeline/entregables-multimedia-por-agente.md
// =============================================================================

const path = require('path');
const { writeDeliverable, writeDeliverableException } = require('./write-deliverable');
const { readDeliverableIndex } = require('./deliverable-index');

const DELIVERY_SKILL = 'delivery';
const DELIVERY_FASE = 'entrega';

// Motivo por defecto cuando delivery cierra sin ninguna nota/motivo con el que
// serializar una constancia (CA-4). Texto neutro: sin paths del host, sin
// contenido de `.env`/`application.conf`, sin stack traces (SEC-DEL-4). Igual
// pasa por `redactContent` dentro de `writeDeliverableException`.
const DEFAULT_MOTIVO_SIN_CONTENIDO =
    'delivery cerró la fase de entrega sin notas ni constancia estructurada; '
    + 'constancia no materializable automáticamente por falta de contenido.';

/**
 * Traduce el repo root al dir `.pipeline` que espera `deliverable-index`.
 * @param {string} [repoRoot]
 * @returns {string}
 */
function pipelineDirOf(repoRoot) {
    const root = (typeof repoRoot === 'string' && repoRoot.length > 0) ? repoRoot : process.cwd();
    return path.join(root, '.pipeline');
}

/**
 * ¿Ya existe una entrada indexada de `delivery`/`entrega` para el issue?
 * Fail-abierto: si el índice es ilegible, se trata como NO indexado (preferimos
 * intentar escribir la constancia a dejarla faltar).
 * @param {string|number} issue
 * @param {string} [repoRoot]
 * @returns {boolean}
 */
function yaIndexado(issue, repoRoot) {
    try {
        const idx = readDeliverableIndex(issue, { pipelineRoot: pipelineDirOf(repoRoot) });
        return Array.isArray(idx.entries)
            && idx.entries.some(
                (e) => e && e.agente === DELIVERY_SKILL && e.fase === DELIVERY_FASE,
            );
    } catch {
        return false;
    }
}

/**
 * Garantiza la constancia de entrega de `delivery`/`entrega` (#4517).
 *
 * Contrato incondicional: tras esta llamada SIEMPRE existe, para el issue, una
 * entrada `delivery`/`entrega` en el índice (`document` o `exception`), salvo
 * que ya existiera (idempotencia) o que la escritura falle (best-effort — el
 * caller no debe abortar su ciclo; ver el try/catch de pulpo.js).
 *
 * @param {string|number} issue - número de issue (`^\d+$`).
 * @param {object} [opts]
 * @param {string} [opts.notas]  - notas del resultado del delivery.
 * @param {string} [opts.motivo] - motivo (si el delivery no dejó `notas`).
 * @param {string} [opts.pipelineRoot] - repo root (default process.cwd()).
 * @param {string} [opts.timestamp] - ISO inyectable para el índice (tests).
 * @returns {{action:'already-indexed'|'materialized'|'exception', path?:string}}
 */
function ensureDeliveryConstancia(issue, opts = {}) {
    const { notas, motivo, pipelineRoot, timestamp } = opts;

    // SEC-DEL-5 — idempotencia: si ya hay constancia (p.ej. la Opción A del
    // SKILL.md), no re-escribimos ni duplicamos.
    if (yaIndexado(issue, pipelineRoot)) {
        return { action: 'already-indexed' };
    }

    const contenido =
        (typeof notas === 'string' && notas.trim().length > 0) ? notas
        : (typeof motivo === 'string' && motivo.trim().length > 0) ? motivo
        : '';

    if (contenido.trim().length > 0) {
        // CA-1 — materializa sin umbral. `writeDeliverable` redacta por default
        // (SEC-DEL-1) e indexa en el canónico `.pipeline/deliverables/<issue>.json`.
        const res = writeDeliverable(DELIVERY_SKILL, issue, {
            fase: DELIVERY_FASE, md: contenido, pipelineRoot, timestamp,
        });
        return { action: 'materialized', path: res.path };
    }

    // CA-4 — sin contenido → excepción explícita, nunca silencio.
    writeDeliverableException(DELIVERY_SKILL, issue, {
        fase: DELIVERY_FASE, motivo: DEFAULT_MOTIVO_SIN_CONTENIDO, pipelineRoot, timestamp,
    });
    return { action: 'exception' };
}

module.exports = {
    ensureDeliveryConstancia,
    DELIVERY_SKILL,
    DELIVERY_FASE,
    DEFAULT_MOTIVO_SIN_CONTENIDO,
};
