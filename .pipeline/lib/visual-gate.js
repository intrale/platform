// =============================================================================
// visual-gate.js — Gate de validación visual pre-promoción build→verificacion
//                  (Issue #3383)
//
// Resumen
// -------
// Antes de promover un archivo de `desarrollo/build/listo/` a
// `desarrollo/verificacion/pendiente/`, el pulpo le pide a este módulo que
// valide que el body del issue tenga la sección `## Screenshots & Mockups`
// con al menos 2 attachments markdown.
//
// Si el gate falla:
//   - El archivo NO se promueve.
//   - Se postea (idempotentemente) un comment de bloqueo en el issue.
//   - Se aplica el label `needs:visual-baseline`.
//
// Reglas operativas
// -----------------
//   - Feature flag `PIPELINE_VISUAL_GATE_ENABLED` (default `0`) controla si el
//     gate corre o no (CA-4, CA-5 — kill-switch sin redeploy).
//   - El gate sólo aplica al pipeline `desarrollo`, fase origen `build`, fase
//     destino `verificacion`, y a issues que tengan al menos uno de los
//     labels `app:client | app:business | app:delivery`.
//   - Issues con `qa:skipped` legítimo bypassan el gate (la verificación
//     final la hace `hasVisualReference` reusando la whitelist existente).
//
// Idempotencia (CA-UX-2)
// ----------------------
// El comment incluye el marker HTML `<!-- visual-gate-block -->` para que el
// caller (pulpo) pueda detectar si ya fue posteado antes y no duplicarlo. El
// caller debe llamar a `commentMarkerPresent(comments)` antes de encolar el
// comentario.
//
// Este módulo es JS puro (sin fs/net): la fetch del body y el queueing de
// acciones lo hace `pulpo.js`. Acá viven sólo: predicado + parser + copy.
// Esto lo hace testeable con `node --test` y aislado del runtime del pulpo.
// =============================================================================

'use strict';

const { hasVisualReference } = require('./qa-evidence-gate');

const VISUAL_GATE_ENV = 'PIPELINE_VISUAL_GATE_ENABLED';
const COMMENT_MARKER = '<!-- visual-gate-block -->';
const NEEDS_VISUAL_BASELINE_LABEL = 'needs:visual-baseline';
const VISUAL_GATE_TARGET_LABELS = Object.freeze([
    'app:client',
    'app:business',
    'app:delivery',
]);

/**
 * Devuelve true si el flag `PIPELINE_VISUAL_GATE_ENABLED` está activo.
 * Se puede pasar `env` para testear sin tocar `process.env` real.
 */
function isGateEnabled(env = process.env) {
    return String(env[VISUAL_GATE_ENV] || '0').trim() === '1';
}

/**
 * Normaliza un label (string o {name}) a string lowercase.
 */
function labelName(l) {
    if (typeof l === 'string') return l.toLowerCase();
    if (l && typeof l === 'object' && typeof l.name === 'string') return l.name.toLowerCase();
    return '';
}

/**
 * Devuelve true si labels contiene alguno de los targets visuales (app:*).
 */
function hasVisualTargetLabel(labels) {
    if (!Array.isArray(labels)) return false;
    const names = labels.map(labelName);
    return VISUAL_GATE_TARGET_LABELS.some((target) => names.includes(target));
}

/**
 * Predicado de aplicabilidad: ¿debe correr el gate para esta transición?
 *
 * @param {object} opts
 * @param {string} opts.pipelineName
 * @param {string} opts.fromFase
 * @param {string} opts.toFase
 * @param {Array<string|{name:string}>} opts.labels
 * @param {object} [opts.env]
 * @returns {boolean}
 */
function shouldEvaluateVisualGate({ pipelineName, fromFase, toFase, labels, env }) {
    if (!isGateEnabled(env)) return false;
    if (pipelineName !== 'desarrollo') return false;
    if (fromFase !== 'build') return false;
    if (toFase !== 'verificacion') return false;
    if (!hasVisualTargetLabel(labels)) return false;
    return true;
}

/**
 * Evalúa el gate visual sobre el body + labels del issue.
 * Pasa-throw a `hasVisualReference` con la whitelist de qa:skipped intacta.
 *
 * @returns {{ ok: boolean, reason: string, images?: number }}
 */
function evaluateVisualGate({ body, labels }) {
    return hasVisualReference(body, { labels });
}

/**
 * Construye el body del comment de bloqueo (CA-UX-3.1).
 * Texto literal acordado con UX (ver docs/pipeline/visual-validation.md §3).
 */
function buildBlockComment() {
    return [
        '❌ Validación visual bloqueada — falta evidencia en la definición',
        '',
        'Este issue tiene labels `app:*` o toca superficies con UI, pero el body no',
        'incluye la sección **Screenshots & Mockups** con al menos 2 imágenes adjuntas.',
        '',
        'QA no puede comparar la entrega contra una referencia que no existe, así que',
        'el pipeline lo devuelve a definición.',
        '',
        '**Cómo desbloquear**:',
        '1. Volver a refinamiento con `/doc refinar #<issue>` o `/ux #<issue>`.',
        '2. UX adjunta mockup esperado + estados borde siguiendo',
        '   [`docs/pipeline/visual-validation.md §2`](../../docs/pipeline/visual-validation.md#2-spec-de-la-sección-screenshots--mockups).',
        '3. Volver a someter (el label `needs:visual-baseline` se quita automáticamente',
        '   cuando el gate verifica que ya hay sección + 2 imágenes).',
        '',
        'Si este issue NO necesita validación visual (infra pura, docs, refactor sin UI),',
        'agregá label `qa:skipped` con justificación escrita en un comment.',
        '',
        '> _Bloqueado por_ `PIPELINE_VISUAL_GATE_ENABLED=1` · gate `hasVisualReference` · `.pipeline/lib/qa-evidence-gate.js`.',
        '',
        COMMENT_MARKER,
    ].join('\n');
}

/**
 * Idempotencia: devuelve true si alguno de los comments ya tiene el marker.
 *
 * @param {Array<{body?: string}>} comments
 * @returns {boolean}
 */
function commentMarkerPresent(comments) {
    if (!Array.isArray(comments)) return false;
    return comments.some((c) => typeof c?.body === 'string' && c.body.includes(COMMENT_MARKER));
}

/**
 * Construye el evento estructurado de bloqueo para auditoría (similar a
 * buildBypassEvent existente). Útil para logs grepables del pulpo.
 */
function buildGateBlockEvent({ issue, reason, images }) {
    return {
        event: 'visual-gate-block',
        issue: String(issue),
        reason,
        images: images ?? 0,
        decision: 'do-not-promote',
        action: ['label:needs:visual-baseline', 'comment-if-missing'],
    };
}

module.exports = {
    VISUAL_GATE_ENV,
    COMMENT_MARKER,
    NEEDS_VISUAL_BASELINE_LABEL,
    VISUAL_GATE_TARGET_LABELS,
    isGateEnabled,
    hasVisualTargetLabel,
    shouldEvaluateVisualGate,
    evaluateVisualGate,
    buildBlockComment,
    commentMarkerPresent,
    buildGateBlockEvent,
};
