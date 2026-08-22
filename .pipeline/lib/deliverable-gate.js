'use strict';

// =============================================================================
// deliverable-gate.js — Gate de entregable obligatorio por fase/agente (#4502)
// =============================================================================
//
// Paraguas: #4255 (registro y entrega de entregables por fase y agente).
// Materializa la fila `Definición → PO → Ficha de definición` de ese épico:
// garantiza que al cerrar la fase `criterios` el agente `po` haya dejado su
// entregable en el store `issue → fase → agente`, o bien una excepción explícita
// ("no aplica + motivo"). Espeja el patrón de `architect-signoff-gate.js` (gate
// determinístico + kill switch + `gate_mode` dry-run/enforce, fail-abierto en
// dry-run) y del `visual-gate`.
//
// Diseño (decisiones de arquitectura del issue):
//
//   SEC-REQ-1 — El gate es AUTORITATIVO en el pulpo, NO en el YAML editable del
//     agente. La excepción CA-3 NO es un flag de bypass que el agente escribe en
//     el store: el YAML del PO sólo transporta `entregable_no_aplica` +
//     `motivo_no_aplica` como *input*; la entry `tipo:'exception'` la escribe el
//     pulpo vía `upsertException` tras validar el motivo. (OWASP A01/A08.)
//
//   SEC-REQ-3 — Sin deadlock: el gate se diseña JUNTO con la excepción. Además,
//     el default de config es `enabled:false` / `gate_mode:dry-run`, que NUNCA
//     bloquea durante el rollout. El backstop anti-deadlock (materialización de
//     las notas del PO vía `writeDeliverable`) vive en el wiring del pulpo, que
//     corre ANTES de invocar este gate, de modo que la retención efectiva es un
//     último recurso.
//
// Este módulo es API PURA: sin efectos de red, sin `writeDeliverable`, sin
// `Date.now()` en la ruta testeada (`clock` inyectable). Sólo lee el store vía
// `queryByPhase` y, para el input de excepción, escribe la entry autoritativa vía
// `upsertException` (choke point del índice).
//
// Doctrina y contexto: docs/pipeline/entregables-multimedia-por-agente.md §5.bis
// =============================================================================

const { queryByPhase, upsertException } = require('./deliverable-index');

// GX-2: el motivo de la excepción debe ser legible (no vacío, no "n/a" seco).
// Umbral mínimo de longitud tras trim.
const EXCEPTION_MOTIVO_MIN_LEN = 15;

/**
 * Evalúa el gate de entregable obligatorio para un `(issue, fase, agente)`.
 *
 * Secuencia:
 *   1. Kill switch: si `config.deliverable_gate.enabled !== true` (o
 *      `kill_switch === true`) → cortocircuito `promote` sin tocar el store.
 *   2. Consultar el store: ¿hay entregable del agente en la fase? ¿hay excepción?
 *   3. Input de excepción autoritativa: si falta entregable y excepción, y el
 *      `poResult` trae `entregable_no_aplica === true` con `motivo_no_aplica`
 *      legible (≥ 15 chars) → registrar la entry `tipo:'exception'` vía el pulpo
 *      (upsertException) y promover.
 *   4. Decisión: `promote` si hay entregable o excepción; si no, `retain`.
 *   5. `dry-run` NUNCA bloquea (fail-abierto): expone la `decision` lógica pero
 *      el `effective_decision` es siempre `promote`. Sólo `enforce` retiene.
 *
 * @param {object} args
 * @param {string|number} args.issue
 * @param {string} args.fase                 - fase a chequear (ej. 'criterios').
 * @param {string} args.agente               - agente productor (ej. 'po').
 * @param {object|null} [args.poResult]      - YAML del agente (input de excepción).
 * @param {object} [args.config]             - config del pipeline (bloque
 *                                             `deliverable_gate`).
 * @param {string} [args.pipelineRoot]       - root del store de entregables.
 * @param {function} [args.clock]            - `() => ISOString` inyectable.
 * @returns {{
 *   decision: 'promote'|'retain',
 *   effective_decision: 'promote'|'retain',
 *   reason: string,
 *   gate_mode: 'disabled'|'dry-run'|'enforce',
 *   hasDeliverable: boolean,
 *   hasException: boolean
 * }}
 */
function evaluateDeliverableGate({ issue, fase, agente, poResult, config, pipelineRoot, clock } = {}) {
    const cfg = (config && config.deliverable_gate) || {};

    // (1) Kill switch — cortocircuito completo (espeja architect-signoff-gate R1).
    if (cfg.enabled !== true || cfg.kill_switch === true) {
        return {
            decision: 'promote',
            effective_decision: 'promote',
            reason: 'disabled',
            gate_mode: 'disabled',
            hasDeliverable: false,
            hasException: false,
        };
    }

    const gateMode = cfg.gate_mode === 'enforce' ? 'enforce' : 'dry-run';

    // (2) Consulta del store — best-effort, nunca tira (el FS manda).
    const entries = queryByPhase(issue, fase, { pipelineRoot });
    const hasDeliverable = entries.some((e) => e.agente === agente && e.tipo !== 'exception');
    const hasException = entries.some((e) => e.agente === agente && e.tipo === 'exception');

    // (3) Input de excepción autoritativa (SEC-REQ-1). Sólo si aún no hay ni
    // entregable ni excepción registrada. La decisión de aceptar la excepción y
    // escribir la entry `tipo:'exception'` la toma el pulpo, no el agente.
    if (!hasDeliverable && !hasException && poResult && poResult.entregable_no_aplica === true) {
        const motivo = String(poResult.motivo_no_aplica || '').trim();
        if (motivo.length >= EXCEPTION_MOTIVO_MIN_LEN) {
            upsertException({
                issue,
                fase,
                agente,
                motivo,
                timestamp: typeof clock === 'function' ? clock() : undefined,
                pipelineRoot,
            });
            return {
                decision: 'promote',
                effective_decision: 'promote',
                reason: 'exception-registered',
                gate_mode: gateMode,
                hasDeliverable: false,
                hasException: true,
            };
        }
    }

    // (4) Decisión lógica.
    const decision = (hasDeliverable || hasException) ? 'promote' : 'retain';

    // (5) dry-run nunca bloquea efectivamente la promoción (fail-abierto).
    const effective = gateMode === 'enforce' ? decision : 'promote';

    return {
        decision,
        effective_decision: effective,
        gate_mode: gateMode,
        hasDeliverable,
        hasException,
        reason: decision === 'promote' ? 'deliverable-present' : 'missing-deliverable',
    };
}

module.exports = {
    evaluateDeliverableGate,
    EXCEPTION_MOTIVO_MIN_LEN,
};
