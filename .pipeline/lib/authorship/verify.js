// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
// =============================================================================
// #7632 — Núcleo PURO del verificador de autoría que corre en CI.
//
// Sin I/O: no toca disco, red ni procesos. `cli.js` es el único que cablea
// `gh`, `fs` y `stdout`. Este archivo corre desde el checkout de `base_ref`
// bajo un `sparse-checkout` acotado, así que sólo puede requerir módulos
// relativos listados en `pr-checks.yml` o built-ins de Node (lo asierta
// `authorship-ci-packaging.test.js`).
//
// Verifica CONSISTENCIA, no AUTENTICIDAD (S5): el trailer es texto que el autor
// del PR puede escribir; un verde sólo dice que las piezas coinciden entre sí.
//
// Fuente del "mensaje de squash propuesto" (D-A): GitHub no expone el mensaje
// final antes del merge. Se reconstruye con la MISMA función que usa delivery
// (`commit-builder.buildSquashMessage`) a partir de las líneas `Intrale-*` del
// bloque `authorship-anchor` del body del PR y de los mensajes de los commits
// de la rama.
// =============================================================================

const { normalizeLine } = require('./normalize');
const trailer = require('./trailer');
const commitBuilder = require('../delivery/commit-builder');

// Enum CONGELADO: lo consumen `annotations.js`, el summary y los tests.
const CODES = Object.freeze([
    'MISSING_TRAILER',
    'INVALID_FORMAT',
    'DUPLICATE_KEY',
    'KEY_OUTSIDE_BLOCK',
    'ISSUE_NOT_FOUND',
    'ANCHOR_MISMATCH',
    'TOO_LARGE',
    'UNVERIFIABLE',
]);

// RS-9: tope del texto procesado. Se mide ANTES de cualquier regex.
const MAX_BYTES = 64 * 1024;

const ISSUE_NUMBER = /^\d{1,7}$/;
const ANCHOR_OPEN = /^\s*<!--\s*authorship-anchor\s+issue=(\d{1,7})\s*-->\s*$/i;
const ANCHOR_OPEN_ANY = /<!--\s*authorship-anchor\b/i;
const ANCHOR_CLOSE = /<!--\s*\/\s*authorship-anchor\s*-->/i;
// Línea `Intrale-<clave>: <valor>` (se evalúa sobre la línea normalizada).
const INTRALE_LINE = /^\s*(intrale-[a-z0-9-]+)\s*:\s?(.*)$/i;
// Igual que `copy.stripAnchorBlocks`: una línea Intrale-* decorada con markdown.
const INTRALE_LOOSE = /^\s*(?:[`>*_-]\s*)*intrale-[a-z0-9-]+\s*:/i;
const BRANCH_ISSUE = /^agent\/(\d{1,7})-/;

const ANCHOR_KEYS = Object.freeze({
    'intrale-issue': 'Intrale-Issue',
    'intrale-human-direction': 'Intrale-Human-Direction',
    'intrale-ai-assisted': 'Intrale-AI-Assisted',
});

/**
 * Traduce el texto libre de error de `trailer.parseTrailerBlock` /
 * `verifyTrailer` al enum congelado. Cada texto conocido tiene su test: si
 * `trailer.js` cambia la redacción, el test rompe en vez de degradar el código
 * a INVALID_FORMAT sin que nadie lo note.
 */
function mapTrailerError(error) {
    const s = String(error || '');
    if (/fuera del bloque/i.test(s)) return 'KEY_OUTSIDE_BLOCK';
    if (/duplicad/i.test(s)) return 'DUPLICATE_KEY';
    return 'INVALID_FORMAT';
}

function splitLines(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Extrae los bloques `authorship-anchor` del body del PR.
 * @returns {{anchors: Array<{issue:string|null, lines:string[]}>, outside: string[], unclosed: boolean}}
 */
function extractAnchors(body) {
    const anchors = [];
    const outside = [];
    let current = null;
    for (const raw of splitLines(body)) {
        const norm = normalizeLine(raw);
        if (current) {
            if (ANCHOR_CLOSE.test(norm)) { anchors.push(current); current = null; continue; }
            current.lines.push(norm);
            continue;
        }
        if (ANCHOR_OPEN_ANY.test(norm)) {
            const m = norm.match(ANCHOR_OPEN);
            current = { issue: m ? m[1] : null, lines: [] };
            continue;
        }
        outside.push(norm);
    }
    const unclosed = current !== null;
    if (current) anchors.push(current);
    return { anchors, outside, unclosed };
}

/** Líneas `Intrale-*` de un texto, como `{key(lowercase), value}`. */
function intraleLines(lines) {
    const out = [];
    for (const line of lines) {
        const m = line.match(INTRALE_LINE);
        if (m) out.push({ key: m[1].toLowerCase(), value: m[2].trim() });
    }
    return out;
}

function commitsToText(commitMessages) {
    return (Array.isArray(commitMessages) ? commitMessages : [])
        .map((c) => String(c == null ? '' : c))
        .join('\n\n');
}

/**
 * Verifica el mensaje de squash propuesto de un PR `agent/*`.
 *
 * @param {object} p
 * @param {string} p.prBody            body del PR (contiene el anchor)
 * @param {string[]} [p.commitMessages] mensajes completos de los commits de la rama
 * @param {'exists'|'not_found'|'error'|undefined} [p.issueExists]
 *        resultado de la consulta a GitHub; `undefined` = no se consultó
 * @param {string} [p.headRef]         rama del PR (`agent/<N>-<slug>`)
 * @returns {{findings: Array<{code:string, issue?:string}>,
 *            checks: {format:string, issue:string, anchor:string},
 *            issue: string|null}}
 */
function verifyProposedMessage({ prBody, commitMessages = [], issueExists, headRef } = {}) {
    const findings = [];
    const add = (code, issue) => {
        if (findings.some((f) => f.code === code)) return;
        findings.push(issue ? { code, issue } : { code });
    };
    const checks = { format: 'unknown', issue: 'unknown', anchor: 'unknown' };

    const body = String(prBody == null ? '' : prBody);
    const commitsText = commitsToText(commitMessages);
    if (Buffer.byteLength(body, 'utf8') + Buffer.byteLength(commitsText, 'utf8') > MAX_BYTES) {
        add('TOO_LARGE');
        checks.format = 'fail';
        return { findings, checks, issue: null };
    }

    // --- 1-3 · Formato del bloque ---------------------------------------------
    const { anchors, outside, unclosed } = extractAnchors(body);
    let formatOk = true;
    let anchorOk = true;

    if (outside.some((l) => INTRALE_LOOSE.test(l))) { add('KEY_OUTSIDE_BLOCK'); formatOk = false; }

    const anchor = anchors[0] || null;
    const anchorLines = anchor ? intraleLines(anchor.lines) : [];
    if (!anchor || anchorLines.length === 0) {
        add('MISSING_TRAILER');
        formatOk = false;
    }
    if (anchors.length > 1) { add('DUPLICATE_KEY'); formatOk = false; }
    if (unclosed) { add('INVALID_FORMAT'); formatOk = false; }

    const values = {};
    for (const { key, value } of anchorLines) {
        if (!ANCHOR_KEYS[key]) { add('INVALID_FORMAT'); formatOk = false; continue; }
        if (key in values) { add('DUPLICATE_KEY'); formatOk = false; continue; }
        values[key] = value;
    }

    // Caso 5: un Intrale-* que viene en un commit interno y no está en el bloque
    // del PR no llega al squash (delivery lo descarta con stripForgedTrailers).
    const commitKeys = new Set(intraleLines(splitLines(commitsText).map(normalizeLine)).map((x) => x.key));
    for (const key of commitKeys) {
        if (!(key in values)) { add('MISSING_TRAILER'); formatOk = false; }
    }

    let issue = null;
    if (anchor && anchorLines.length > 0) {
        const missing = Object.keys(ANCHOR_KEYS).filter((k) => !(k in values));
        if (missing.length) { add('INVALID_FORMAT'); formatOk = false; }
        const m = String(values['intrale-issue'] || '').match(/^#(\d+)$/);
        if (m && ISSUE_NUMBER.test(m[1])) issue = String(Number(m[1]));
        else if ('intrale-issue' in values) { add('INVALID_FORMAT'); formatOk = false; }

        // Mensaje propuesto con la MISMA función de delivery.
        if (issue && !missing.length) {
            let proposed = null;
            try {
                proposed = commitBuilder.buildSquashMessage({
                    issue,
                    branchMessages: commitsText,
                    humanLine: values['intrale-human-direction'],
                    aiLine: values['intrale-ai-assisted'],
                });
            } catch {
                add('INVALID_FORMAT');
                formatOk = false;
            }
            if (proposed !== null) {
                const verified = trailer.verifyTrailer(proposed, issue);
                if (!verified.ok) {
                    add(mapTrailerError(verified.error));
                    formatOk = false;
                } else {
                    // --- 5 · anchor = trailer --------------------------------
                    const t = verified.trailers;
                    const same = t.issue === `#${issue}`
                        && t.humanDirection === values['intrale-human-direction']
                        && t.aiAssisted === values['intrale-ai-assisted'];
                    if (!same) anchorOk = false;
                }
            }
        }
    }

    // --- 5 · consistencia del bloque con el marcador y la rama ------------------
    if (anchor && issue) {
        if (anchor.issue === null || String(Number(anchor.issue)) !== issue) anchorOk = false;
        const b = String(headRef || '').match(BRANCH_ISSUE);
        if (b && String(Number(b[1])) !== issue) anchorOk = false;
    }
    if (!anchorOk) add('ANCHOR_MISMATCH');

    // --- 4 · el issue existe ---------------------------------------------------
    if (issue) {
        if (issueExists === 'exists') checks.issue = 'ok';
        else if (issueExists === 'not_found') { checks.issue = 'fail'; add('ISSUE_NOT_FOUND', issue); }
        else if (issueExists === 'error') { checks.issue = 'unknown'; add('UNVERIFIABLE'); }
    } else if (anchor && anchorLines.length > 0) {
        checks.issue = 'fail';
    }

    checks.format = formatOk ? 'ok' : 'fail';
    checks.anchor = !anchor || anchorLines.length === 0 ? 'fail' : (anchorOk ? (formatOk ? 'ok' : 'unknown') : 'fail');

    // Orden de CA-1: formato → issue → bloque; UNVERIFIABLE al final.
    const order = ['TOO_LARGE', 'MISSING_TRAILER', 'INVALID_FORMAT', 'DUPLICATE_KEY', 'KEY_OUTSIDE_BLOCK',
        'ISSUE_NOT_FOUND', 'ANCHOR_MISMATCH', 'UNVERIFIABLE'];
    findings.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
    return { findings, checks, issue };
}

/**
 * Número de issue declarado en el bloque (para decidir si consultar a GitHub
 * ANTES de verificar). Devuelve `null` si no hay o no valida `^\d{1,7}$`: en
 * ese caso el CLI no invoca `gh` (RS-2).
 */
function extractIssueCandidate(prBody) {
    const body = String(prBody == null ? '' : prBody);
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) return null;
    const { anchors } = extractAnchors(body);
    if (!anchors.length) return null;
    const found = intraleLines(anchors[0].lines).find((x) => x.key === 'intrale-issue');
    if (!found) return null;
    const m = found.value.match(/^#(\d+)$/);
    return m && ISSUE_NUMBER.test(m[1]) ? String(Number(m[1])) : null;
}

// -----------------------------------------------------------------------------
// Auditoría de `main` (verify --commit): el mensaje ya está en la historia.
// -----------------------------------------------------------------------------

const AI_CO_AUTHOR = /^\s*co-authored-by\s*:.*(anthropic|openai|claude|codex|gemini|google\.com|copilot)/im;
const PR_TITLE = /\(#\d{1,7}\)\s*$/;

/**
 * ¿El commit parece un squash de una rama `agent/*`? Sin API (la auditoría
 * corre sólo con `contents: read`): lo es si tiene alguna línea `Intrale-*`, o
 * si el título termina en `(#N)` y hay un `Co-Authored-By` de un proveedor IA.
 */
function isAgentSquashCandidate(message) {
    const lines = splitLines(message).map(normalizeLine);
    if (lines.some((l) => INTRALE_LOOSE.test(l))) return true;
    return PR_TITLE.test(lines[0] || '') && AI_CO_AUTHOR.test(lines.join('\n'));
}

/**
 * Verifica un mensaje de commit ya integrado.
 * @returns {{candidate:boolean, findings:Array<{code:string}>}}
 */
function verifyCommitMessage(message) {
    const msg = String(message == null ? '' : message);
    if (Buffer.byteLength(msg, 'utf8') > MAX_BYTES) return { candidate: true, findings: [{ code: 'TOO_LARGE' }] };
    if (!isAgentSquashCandidate(msg)) return { candidate: false, findings: [] };
    const parsed = trailer.parseTrailerBlock(msg);
    if (!parsed.ok) return { candidate: true, findings: [{ code: mapTrailerError(parsed.error) }] };
    const t = parsed.trailers;
    const m = String(t.issue || '').match(/^#(\d{1,7})$/);
    const issue = m ? m[1] : (t.closes ? String(t.closes) : null);
    if (!issue) return { candidate: true, findings: [{ code: 'MISSING_TRAILER' }] };
    const verified = trailer.verifyTrailer(msg, issue);
    if (!verified.ok) return { candidate: true, findings: [{ code: mapTrailerError(verified.error) }] };
    return { candidate: true, findings: [] };
}

module.exports = {
    CODES,
    MAX_BYTES,
    mapTrailerError,
    extractAnchors,
    extractIssueCandidate,
    verifyProposedMessage,
    isAgentSquashCandidate,
    verifyCommitMessage,
};
