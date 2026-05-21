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

// =============================================================================
// hasVisualReference — Issue #3383 (CA-1, CA-3, CA-7, CA-UX-3)
//
// Valida que el body de un issue tenga sección "## Screenshots & Mockups" con
// al menos 2 attachments markdown antes de que el pulpo promueva a verificación.
//
// Reglas de seguridad (CA-7, CA-8):
//   - Trunca el body a los primeros 100 KB (anti-DOS).
//   - Regex bounded sin backtracking (negated char classes, sin nested
//     quantifiers). No usa eval/Function/exec.
//   - Soft-timeout de 100 ms vía Date.now() — corta el conteo si tarda más,
//     devuelve `ok: false` con reason 'timeout'. JS no tiene regex timeout
//     nativo pero los patrones son ReDoS-safe (verificado en tests adversarial).
//
// Bypass (CA-3):
//   - Si labels contiene 'qa:skipped', retorna `ok: true, reason: 'qa-skipped'`
//     sin parsear el body.
//
// CA-UX-3:
//   - Match case-insensitive del título de sección, variantes 'Screenshots &
//     Mockups', 'Screenshots y Mockups', 'Screenshots and Mockups'.
// =============================================================================

const MAX_BODY_BYTES = 100 * 1024; // 100 KB
const MAX_PARSE_MS = 100; // soft-timeout
// Header de sección: '##' + 'Screenshots' + separador (&|y|and) + 'Mockups'.
// Negated char classes y anclas — ReDoS-safe.
const SECTION_HEADER_RE = /^\s{0,3}#{2,6}\s+screenshots\s+(?:&|y|and)\s+mockups\s*$/im;
// Header de cualquier otra sección al mismo nivel (para delimitar fin).
const ANY_HEADER_RE = /^\s{0,3}#{2,6}\s+\S/m;
// Image markdown: ![alt](url). Negated char classes, sin backtracking peligroso.
const IMAGE_RE = /!\[[^\]\n]{0,500}\]\([^)\s\n]{1,2000}(?:\s+"[^"\n]{0,500}")?\)/g;

/**
 * Trunca el body a los primeros MAX_BODY_BYTES (CA-7, anti-DOS).
 * Usa Buffer.byteLength para contar bytes, no chars (UTF-8 puede inflar).
 */
function truncateBody(body) {
    if (typeof body !== 'string') return '';
    const buf = Buffer.from(body, 'utf8');
    if (buf.byteLength <= MAX_BODY_BYTES) return body;
    return buf.subarray(0, MAX_BODY_BYTES).toString('utf8');
}

/**
 * Detecta si labels contiene qa:skipped (CA-3, bypass por whitelist).
 */
function hasQaSkippedLabel(labels) {
    if (!Array.isArray(labels)) return false;
    return labels.some((l) => {
        if (typeof l === 'string') return l.toLowerCase() === 'qa:skipped';
        if (l && typeof l === 'object' && typeof l.name === 'string') {
            return l.name.toLowerCase() === 'qa:skipped';
        }
        return false;
    });
}

/**
 * Extrae la porción del body que está dentro de la sección "## Screenshots &
 * Mockups", desde su header hasta el siguiente header del mismo nivel o EOF.
 *
 * Devuelve null si no encuentra la sección.
 */
function extractSectionSlice(truncated) {
    const headerMatch = SECTION_HEADER_RE.exec(truncated);
    if (!headerMatch) return null;
    const start = headerMatch.index + headerMatch[0].length;
    // Buscar siguiente header DESPUÉS del actual.
    const rest = truncated.slice(start);
    const nextHeaderMatch = ANY_HEADER_RE.exec(rest);
    const end = nextHeaderMatch ? start + nextHeaderMatch.index : truncated.length;
    return truncated.slice(start, end);
}

/**
 * Cuenta attachments markdown (`![alt](url)`) en el slice, con soft-timeout.
 * Devuelve { count, timedOut }.
 */
function countImages(slice) {
    const start = Date.now();
    let count = 0;
    // Regex con flag /g — exec en loop es ReDoS-safe por construcción del patrón.
    IMAGE_RE.lastIndex = 0;
    let m;
    while ((m = IMAGE_RE.exec(slice)) !== null) {
        count += 1;
        if (count >= 2 && Date.now() - start <= MAX_PARSE_MS) {
            // Optimización: con 2 ya alcanza para el CA-1. Seguimos contando hasta 10
            // para diagnóstico, pero capamos para evitar inputs adversariales.
            if (count >= 10) break;
        }
        if (Date.now() - start > MAX_PARSE_MS) {
            return { count, timedOut: true };
        }
        // Defensa adicional: si el regex no avanza (no debería pasar con este patrón),
        // forzar avance para evitar loops.
        if (IMAGE_RE.lastIndex === m.index) IMAGE_RE.lastIndex += 1;
    }
    return { count, timedOut: false };
}

/**
 * Valida si el body del issue tiene referencia visual obligatoria (CA-1).
 *
 * @param {string} body - Body crudo del issue (markdown).
 * @param {object} [opts]
 * @param {Array<string|{name:string}>} [opts.labels] - Labels del issue (para bypass qa:skipped).
 * @returns {{ ok: boolean, reason: string, images?: number }}
 */
function hasVisualReference(body, opts = {}) {
    const labels = opts.labels || [];

    // CA-3: bypass por whitelist qa:skipped.
    if (hasQaSkippedLabel(labels)) {
        return { ok: true, reason: 'qa-skipped' };
    }

    // CA-7: truncar antes de cualquier parse.
    const truncated = truncateBody(body);
    if (!truncated) {
        return { ok: false, reason: 'empty-body' };
    }

    // Soft-timeout del parse entero.
    const t0 = Date.now();
    const slice = extractSectionSlice(truncated);
    if (Date.now() - t0 > MAX_PARSE_MS) {
        return { ok: false, reason: 'timeout' };
    }
    if (slice === null) {
        return { ok: false, reason: 'section-missing' };
    }

    const { count, timedOut } = countImages(slice);
    if (timedOut) {
        return { ok: false, reason: 'timeout', images: count };
    }
    if (count < 2) {
        return {
            ok: false,
            reason: count === 0 ? 'no-images' : 'needs-at-least-2-images',
            images: count,
        };
    }

    return { ok: true, reason: 'has-visual-reference', images: count };
}

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
    // Issue #3383
    hasVisualReference,
    truncateBody,
    hasQaSkippedLabel,
    extractSectionSlice,
    MAX_BODY_BYTES,
    MAX_PARSE_MS,
};
