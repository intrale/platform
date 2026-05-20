// =============================================================================
// screenshots-mockup-gate.js — Hook pre-Ready: exige sección Screenshots & Mockups
// Issue #3381 · CA-9 / CA-10 / CA-11 / CA-12 / CA-17 / CA-25
//
// Qué hace:
//   - Decide si un issue puede pasar a Ready según su body + labels.
//   - Aplica solo a issues con `app:client|business|delivery` o `area:pipeline`
//     que toquen el dashboard.
//   - Exige sección `## Screenshots & Mockups` con ≥1 referencia "actual" o
//     "baseline" (o warning explícito de "sin baseline") y ≥1 referencia
//     "esperado" o "mockup".
//   - Label `ux:no-visual` permite opt-out con justificación.
//   - Rollout gradual: si SCREENSHOTS_MOCKUPS_GATE_ENABLED != '1' devuelve
//     {gate:'disabled'} sin bloquear nada (default OFF).
//
// Qué NO hace:
//   - NO consulta GitHub. Es decisión pura sobre lo que el caller le pase.
//   - NO comenta el issue. NO aplica labels. Eso lo decide el integrador
//     (admission-gate.js o el workflow).
//   - NO ejecuta puppeteer ni llama LLM. Es un linter.
//
// Diseño anti-ReDoS (CA-10/17):
//   - Patrones con anclas (`^`, `$` con multiline) y cuantificadores acotados.
//   - Prohibido `.*` greedy sobre 65k chars. Se parsea por líneas con `split`.
//   - Tests sintéticos con bodies de 65k chars deben terminar en <100 ms.
// =============================================================================

'use strict';

// -----------------------------------------------------------------------------
// Configuración del scope (CA-9 / CA-11)
// -----------------------------------------------------------------------------

const SCOPE_LABELS_APP = Object.freeze(['app:client', 'app:business', 'app:delivery']);
const SCOPE_LABEL_PIPELINE = 'area:pipeline';

// Label opt-out (CA-12).
const OPT_OUT_LABEL = 'ux:no-visual';

// Para `area:pipeline` exigimos también que el issue/PR mencione archivos del
// dashboard. Lista mínima — no exhaustiva: la idea es captar el 90% de issues
// con UI sin obligar a todo `area:pipeline` (la mayoría no toca dashboard).
const PIPELINE_UI_FILE_PATTERNS = Object.freeze([
    'dashboard-v2.js',
    'dashboard.js',
    '.pipeline/public/',
    'docs/qa/propuesta-dashboard',
]);

// Flag de rollout (CA-25). Default OFF.
const FLAG_ENV_NAME = 'SCREENSHOTS_MOCKUPS_GATE_ENABLED';

// Header literal de la sección requerida.
const SECTION_HEADER_REGEX = /^##\s+Screenshots\s*&\s*Mockups\s*$/i;

// Cuantificadores acotados para evitar catastrophic backtracking (CA-10).
const ACTUAL_LINE_REGEX = /^[\s\S]{0,500}\b(actual|baseline|estado actual)\b/i;
const MOCKUP_LINE_REGEX = /^[\s\S]{0,500}\b(esperado|mockup|estado esperado)\b/i;
const SIN_BASELINE_REGEX = /^[\s\S]{0,500}\b(sin\s+baseline|no\s+disponible|primera\s+implementaci[oó]n)\b/i;

// Truncado defensivo del body antes de procesar. 65k es el cap real de GitHub;
// 80k da margen sin permitir explosión combinatoria.
const BODY_MAX_BYTES = 80_000;

// -----------------------------------------------------------------------------
// Helpers de normalización (compartido con admission-gate)
// -----------------------------------------------------------------------------

function normalizeLabels(labels) {
    if (!Array.isArray(labels)) return [];
    return labels
        .map((l) => (typeof l === 'string' ? l : (l && typeof l === 'object' && typeof l.name === 'string' ? l.name : '')))
        .filter(Boolean);
}

function hasAnyLabel(labels, candidates) {
    const names = normalizeLabels(labels);
    for (const n of names) {
        if (candidates.includes(n)) return true;
    }
    return false;
}

// -----------------------------------------------------------------------------
// Decisión de scope (CA-9 / CA-11)
// -----------------------------------------------------------------------------

/**
 * ¿El issue está en scope del gate?
 *
 * - app:* → siempre en scope (Caso B Android).
 * - area:pipeline → en scope SOLO si el body menciona archivos del dashboard.
 *   (CA-11: issues de pipeline sin UI quedan exentos.)
 * - Otro → fuera de scope.
 *
 * @param {{labels: Array, body: string}} item
 * @returns {boolean}
 */
function isInScope(item) {
    if (!item || typeof item !== 'object') return false;
    const labels = item.labels;
    const body = typeof item.body === 'string' ? item.body : '';

    if (hasAnyLabel(labels, SCOPE_LABELS_APP)) return true;

    if (hasAnyLabel(labels, [SCOPE_LABEL_PIPELINE])) {
        // Buscar por archivos de UI dashboard. `body.indexOf` es O(n), seguro
        // contra ReDoS (no es regex). Bound defensivo en BODY_MAX_BYTES.
        const truncated = body.length > BODY_MAX_BYTES ? body.slice(0, BODY_MAX_BYTES) : body;
        for (const pat of PIPELINE_UI_FILE_PATTERNS) {
            if (truncated.indexOf(pat) !== -1) return true;
        }
        return false;
    }

    return false;
}

// -----------------------------------------------------------------------------
// Parsing del body por líneas (anti-ReDoS, CA-10/17)
// -----------------------------------------------------------------------------

/**
 * Encuentra la sección `## Screenshots & Mockups` y devuelve sus líneas
 * (hasta el próximo `## ` o EOF). Parsing line-by-line para evitar regex
 * que pueda backtrack sobre 65k chars.
 *
 * @param {string} body
 * @returns {string[]|null} — líneas de la sección, o null si no existe
 */
function extractSectionLines(body) {
    if (typeof body !== 'string' || body.length === 0) return null;
    const truncated = body.length > BODY_MAX_BYTES ? body.slice(0, BODY_MAX_BYTES) : body;
    const lines = truncated.split(/\r?\n/);
    let inSection = false;
    const out = [];
    for (const line of lines) {
        if (!inSection) {
            if (SECTION_HEADER_REGEX.test(line)) {
                inSection = true;
            }
            continue;
        }
        // Próximo encabezado `## ` cierra la sección. `### ` (subhead) no.
        if (/^##\s+\S/.test(line) && !/^##\s+Screenshots/i.test(line)) {
            break;
        }
        out.push(line);
    }
    return inSection ? out : null;
}

/**
 * Inspecciona las líneas de la sección y devuelve flags:
 *   - hasActual: hay línea con "actual"/"baseline"
 *   - hasExpected: hay línea con "esperado"/"mockup"
 *   - hasSinBaselineWarning: hay línea con "sin baseline"/"primera implementación"
 *
 * @param {string[]|null} lines
 * @returns {{hasActual:boolean, hasExpected:boolean, hasSinBaselineWarning:boolean}}
 */
function inspectSection(lines) {
    const flags = { hasActual: false, hasExpected: false, hasSinBaselineWarning: false };
    if (!Array.isArray(lines)) return flags;
    for (const line of lines) {
        // Bound por línea: si una línea individual pasa 500 chars, la cortamos
        // antes de pasarla al regex. Esto + el cuantificador acotado del
        // regex garantiza tiempo lineal.
        const bounded = line.length > 500 ? line.slice(0, 500) : line;
        if (!flags.hasActual && ACTUAL_LINE_REGEX.test(bounded)) flags.hasActual = true;
        if (!flags.hasExpected && MOCKUP_LINE_REGEX.test(bounded)) flags.hasExpected = true;
        if (!flags.hasSinBaselineWarning && SIN_BASELINE_REGEX.test(bounded)) flags.hasSinBaselineWarning = true;
    }
    return flags;
}

// -----------------------------------------------------------------------------
// API principal — decisión del gate
// -----------------------------------------------------------------------------

/**
 * Evalúa el issue contra el gate.
 *
 * Resultado:
 *   - {gate:'disabled'} si flag OFF (no bloquea, no avisa).
 *   - {gate:'out-of-scope'} si labels no aplican.
 *   - {gate:'opted-out'} si tiene ux:no-visual.
 *   - {gate:'ok'} si tiene sección válida.
 *   - {gate:'block', reason, missing:['actual','expected'|...]} si falta algo.
 *
 * @param {{labels: Array, body: string}} item
 * @param {{flag?: string}} [opts] — override env (testing)
 * @returns {{gate: string, reason?: string, missing?: string[]}}
 */
function evaluate(item, opts) {
    const _opts = opts || {};
    const flagValue = _opts.flag != null ? _opts.flag : process.env[FLAG_ENV_NAME];
    if (flagValue !== '1') {
        return { gate: 'disabled' };
    }

    if (!item || typeof item !== 'object') {
        return { gate: 'out-of-scope' };
    }

    if (hasAnyLabel(item.labels, [OPT_OUT_LABEL])) {
        return { gate: 'opted-out' };
    }

    if (!isInScope(item)) {
        return { gate: 'out-of-scope' };
    }

    const lines = extractSectionLines(item.body || '');
    if (!lines) {
        return {
            gate: 'block',
            reason: 'missing-section',
            missing: ['## Screenshots & Mockups header'],
        };
    }

    const flags = inspectSection(lines);
    const missing = [];

    // Necesita o bien una línea "actual" o un warning explícito "sin baseline".
    if (!flags.hasActual && !flags.hasSinBaselineWarning) {
        missing.push('actual-or-sin-baseline');
    }
    if (!flags.hasExpected) {
        missing.push('expected');
    }

    if (missing.length > 0) {
        return { gate: 'block', reason: 'incomplete-section', missing };
    }

    return { gate: 'ok' };
}

// -----------------------------------------------------------------------------
// Texto del comentario sugerido cuando bloqueamos (compatible con admission-gate)
// -----------------------------------------------------------------------------

const BLOCK_COMMENT_PREFIX = 'Este issue no puede pasar a Ready: falta sección `## Screenshots & Mockups`';

function formatBlockComment(result) {
    if (!result || result.gate !== 'block') return null;
    const missingPretty = (result.missing || []).join(', ');
    return [
        BLOCK_COMMENT_PREFIX + '.',
        '',
        `Faltante: ${missingPretty || result.reason}`,
        '',
        'El issue está en scope del gate (label `app:*` o `area:pipeline` con archivos del dashboard).',
        '',
        '**Cómo destrabarlo:**',
        '1. Pedile a `/ux` que capture estado actual + genere mockup esperado (workflow: `docs/pipeline/ux-visual-flow.md`).',
        '2. Si el cambio NO tiene impacto visual, aplicá el label `ux:no-visual` y justificá en un comentario.',
        '',
        'Más detalle: [docs/pipeline/ux-visual-flow.md](https://github.com/intrale/platform/blob/main/docs/pipeline/ux-visual-flow.md).',
    ].join('\n');
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    // constantes
    SCOPE_LABELS_APP,
    SCOPE_LABEL_PIPELINE,
    OPT_OUT_LABEL,
    PIPELINE_UI_FILE_PATTERNS,
    FLAG_ENV_NAME,
    SECTION_HEADER_REGEX,
    ACTUAL_LINE_REGEX,
    MOCKUP_LINE_REGEX,
    SIN_BASELINE_REGEX,
    BODY_MAX_BYTES,
    BLOCK_COMMENT_PREFIX,
    // helpers
    normalizeLabels,
    hasAnyLabel,
    isInScope,
    extractSectionLines,
    inspectSection,
    // API
    evaluate,
    formatBlockComment,
};
