// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
// =============================================================================
// #7631 — Textos que ve una persona sobre la autoría (UX-1 · UX-2 · UX-3 · UX-4).
//
// Fuente ÚNICA de copy: el comentario de dry-run, el motivo de bloqueo en
// `enforce` y el bloque de constancia del body del PR salen de acá, para que
// CI, export y `docs/legal/autoria.md` no tengan tres redacciones distintas.
//
// Módulo PURO, sin I/O. Ningún texto interpola datos del audit, `chat_id` ni el
// cuerpo firmado: sólo el motivo del enum cerrado y el número de issue.
// =============================================================================

const { normalizeLine } = require('./normalize');
const { REASONS } = require('./trailer');

const REASON_COPY = Object.freeze({
    missing: 'No hay una firma válida para este issue, o la última registrada es un rechazo.',
    'chain-broken': 'El registro de firmas no pasó la verificación de integridad, así que no se usó ninguna firma.',
    'anchor-mismatch': 'La firma de aceptación (GATE 2) corresponde a otro commit, no al que se está integrando.',
    unmapped: 'Hay una firma, pero la identidad que firmó no está dada de alta como aprobador.',
});

const HOW_TO_FIX = 'firma de aceptación (GATE 2) sobre este commit, firma de definición (GATE 1) o aprobación por el canal de firma.';

function safeReason(reason) {
    return REASONS.includes(reason) ? reason : 'missing';
}

function safeIssue(issue) {
    const n = Number(issue);
    return Number.isInteger(n) && n > 0 ? n : 0;
}

function buildDryRunMarker(issue, reason) {
    return `<!-- authorship-dryrun issue=${safeIssue(issue)} reason=${safeReason(reason)} -->`;
}

/** UX-1 — comentario del PR en `dry-run`. Primera línea = veredicto. */
function buildDryRunComment(issue, reason) {
    const r = safeReason(reason);
    return [
        buildDryRunMarker(issue, r),
        '⚠ **Autoría: este cambio se integra sin firma registrada del operador.**',
        'Hoy la verificación está en modo de prueba y no frena. Cuando pase a obligatoria, un cambio así va a quedar bloqueado.',
        '',
        `**Qué pasó:** ${REASON_COPY[r]}`,
        `**Cómo se cubre:** ${HOW_TO_FIX}`,
        '',
        `<sub>Motivo técnico: \`${r}\` · modo: dry-run</sub>`,
    ].join('\n');
}

/** UX-3 — motivo de bloqueo en `enforce`: qué falló → cómo se arregla. */
function describeBlockReason(reason) {
    const r = safeReason(reason);
    return `autoría sin firma registrada del operador: ${REASON_COPY[r]} Cómo se cubre: ${HOW_TO_FIX} (motivo técnico: ${r})`;
}

// -----------------------------------------------------------------------------
// UX-2 — Bloque de constancia en el body del PR (sólo presentación)
// -----------------------------------------------------------------------------

const ANCHOR_OPEN = /<!--\s*authorship-anchor\b[^>]*-->/i;
const ANCHOR_CLOSE = /<!--\s*\/\s*authorship-anchor\s*-->/i;
const INTRALE_LINE = /^\s*(?:[`>*_-]\s*)*intrale-[a-z0-9-]+\s*:/i;

/**
 * Elimina del body cualquier bloque `authorship-anchor` (incluido uno sin
 * cierre: se corta hasta el final) y cualquier línea suelta `Intrale-*`. Se
 * decide sobre la línea normalizada; lo que sobrevive queda como estaba.
 */
function stripAnchorBlocks(body) {
    const lines = String(body == null ? '' : body).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let inside = false;
    for (const line of lines) {
        const norm = normalizeLine(line);
        if (inside) {
            if (ANCHOR_CLOSE.test(norm)) inside = false;
            continue;
        }
        if (ANCHOR_OPEN.test(norm)) {
            // Apertura y cierre en la misma línea: se descarta sólo esa línea.
            inside = !ANCHOR_CLOSE.test(norm.slice(norm.search(ANCHOR_OPEN) + 1));
            continue;
        }
        if (ANCHOR_CLOSE.test(norm)) continue;
        if (INTRALE_LINE.test(norm)) continue;
        out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

/**
 * @param {number} issue
 * @param {{humanLine:string, aiLine:string}} lines — las MISMAS del squash.
 */
function buildAnchorBlock(issue, { humanLine, aiLine }) {
    const n = safeIssue(issue);
    return [
        `<!-- authorship-anchor issue=${n} -->`,
        '**Constancia de autoría** (la genera el pipeline; no editar)',
        '```text',
        `Intrale-Issue: #${n}`,
        `Intrale-Human-Direction: ${humanLine}`,
        `Intrale-AI-Assisted: ${aiLine}`,
        '```',
        '<!-- /authorship-anchor -->',
    ].join('\n');
}

/** Body final: sin anclas ajenas + la del código al FINAL (UX-2). */
function applyAnchorToBody(body, issue, lines) {
    const base = stripAnchorBlocks(body);
    const block = buildAnchorBlock(issue, lines);
    return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

module.exports = {
    REASON_COPY,
    buildDryRunMarker,
    buildDryRunComment,
    describeBlockReason,
    stripAnchorBlocks,
    buildAnchorBlock,
    applyAnchorToBody,
};
