// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
// =============================================================================
// #7631 — Bloque de trailers de autoría del squash (CA-1, CA-2, CA-3, CA-7).
//
// Módulo PURO: no importa el módulo de filesystem ni hace ningún otro I/O. La hija de CI importa
// `parseTrailerBlock` / `verifyTrailer` desde `main`, así que este archivo no
// puede arrastrar lectores de disco ni de red (S3/S4).
//
// Contrato del bloque (último párrafo del mensaje, en este orden exacto):
//
//   Closes #<N>
//   Intrale-Issue: #<N>
//   Intrale-Human-Direction: <login>; <ISO>; <gate2|gate1|approval>:sha256:<hash>
//                          | none; <ISO>; <missing|chain-broken|anchor-mismatch|unmapped>
//   Intrale-AI-Assisted: <proveedor>/<modelo> (<rol>)[, ...] | unknown
//   Co-Authored-By: <Nombre> <email>        (0..n, sin duplicados)
//
// Ningún valor viene del texto del LLM: los arma el código a partir del
// registro del pipeline, y todo el contenido del LLM pasa antes por
// `stripForgedTrailers`.
// =============================================================================

const { normalizeLine } = require('./normalize');

const TRAILER_ORDER = Object.freeze([
    'Closes',
    'Intrale-Issue',
    'Intrale-Human-Direction',
    'Intrale-AI-Assisted',
    'Co-Authored-By',
]);

// Motivos cerrados de "sin dirección humana" (P4). Congelado: la hija de CI,
// el export y el copy de UX dependen de este enum exacto.
const REASONS = Object.freeze(['missing', 'chain-broken', 'anchor-mismatch', 'unmapped']);

// Tipos de firma que pueden anclar el trailer (P2). `approval` queda en el enum
// para no romper el formato del CA-1, pero hoy no tiene fuente en el audit.
const DIRECTION_KINDS = Object.freeze(['gate2', 'gate1', 'approval']);

// Claves que el LLM NO puede aportar. Se comparan DESPUÉS de normalizar, sin
// distinguir mayúsculas y tolerando espacios antes del separador.
const FORGED_KEY = /^\s*(intrale-[a-z0-9-]+|co-authored-by|signed-off-by)\s*:/i;
// Palabras de cierre de GitHub seguidas de `#N` o `owner/repo#N` (SEC-B).
const CLOSING_SRC = '\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\b\\s*:?\\s*([\\w.-]+\\/[\\w.-]+)?#\\d+';
const CLOSING = new RegExp(CLOSING_SRC, 'i');
const CLOSING_G = new RegExp(CLOSING_SRC, 'gi');

// Cualquier control C0/C1 (incluye \r y \n).
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const INVISIBLE_ONE = /[​-‏‪-‮⁠-⁩﻿]/;
const VALUE_ALLOWLIST = /^[A-Za-z0-9._/:@+-]+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const MAX_VALUE_LEN = 200;

// "Nombre <email>" de un Co-Authored-By. Sin `<`/`>` sueltos, sin controles.
const CO_AUTHOR = /^[\p{L}\p{N} ._'()+-]{1,100} <[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}>$/u;

// Formatos de los valores de los trailers (los usan build y verify: una sola
// definición para que el que escribe y el que verifica no puedan divergir).
const HASH_HEX = '[0-9a-f]{64}';
const RX_HUMAN_SIGNED = new RegExp(
    `^([A-Za-z0-9._/:@+-]+); (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z); (${DIRECTION_KINDS.join('|')}):sha256:(${HASH_HEX})$`
);
const RX_HUMAN_NONE = new RegExp(
    `^none; (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z); (${REASONS.join('|')})$`
);
// Una línea que es clave `Intrale-*` (sobre la línea ya normalizada).
const RX_INTRALE_KEY = /^\s*intrale-[a-z0-9-]+\s*:/i;
const AI_ITEM = '[A-Za-z0-9._:@+-]+/[A-Za-z0-9._:@+-]+ \\([A-Za-z0-9._-]+\\)';
const RX_AI = new RegExp(`^(unknown|${AI_ITEM}(, ${AI_ITEM})*)$`);

// -----------------------------------------------------------------------------
// Saneo
// -----------------------------------------------------------------------------

/**
 * Valida un valor de trailer. NUNCA trunca ni "limpia" en silencio: un valor
 * con `\r`, `\n`, controles o fuera de la allowlist LANZA (CA-3 / S2).
 *
 * @param {string|number} v
 * @param {'iso'|string} [kind]
 * @returns {string}
 */
function sanitizeTrailerValue(v, kind) {
    if (typeof v !== 'string' && typeof v !== 'number') {
        throw new Error(`[authorship] valor de trailer inválido (tipo ${typeof v})`);
    }
    const s = String(v);
    if (CONTROL.test(s)) throw new Error('[authorship] valor de trailer con salto de línea o carácter de control');
    if (INVISIBLE_ONE.test(s)) throw new Error('[authorship] valor de trailer con carácter invisible');
    if (!s) throw new Error('[authorship] valor de trailer vacío');
    if (s.length > MAX_VALUE_LEN) throw new Error('[authorship] valor de trailer demasiado largo');
    if (kind === 'iso') {
        if (!ISO_UTC.test(s) || Number.isNaN(Date.parse(s))) {
            throw new Error('[authorship] timestamp de trailer no es ISO-8601 UTC');
        }
        return s;
    }
    if (!VALUE_ALLOWLIST.test(s)) throw new Error('[authorship] valor de trailer fuera de la allowlist');
    return s;
}

/**
 * Título del squash en UNA línea (SEC-A): quita `\r\n`, controles e
 * invisibles y colapsa espacios. A diferencia de los valores, el título es
 * texto libre del issue: se limpia en lugar de rechazarse.
 */
function sanitizeTitle(s) {
    if (s == null) return '';
    return Array.from(String(s)
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
        .replace(/[​-‏‪-‮⁠-⁩﻿]/g, '')
        .replace(/\s+/g, ' ')
        .trim())
        .slice(0, 250)
        .join('')
        .trim();
}

/** Valida un `Co-Authored-By`; devuelve el valor recortado o `null`. */
function sanitizeCoAuthor(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s || CONTROL.test(s) || INVISIBLE_ONE.test(s)) return null;
    if (normalizeLine(s) !== s) return null; // homoglifos / fullwidth → fuera
    return CO_AUTHOR.test(s) ? s : null;
}

// -----------------------------------------------------------------------------
// Strip del contenido del LLM (CA-2)
// -----------------------------------------------------------------------------

/**
 * Elimina del texto del LLM las líneas `Intrale-*`, `Co-Authored-By` y
 * `Signed-off-by`, y las referencias de cierre (`Fixes #1`,
 * `closes owner/repo#2`). Compara sobre la línea normalizada; lo que
 * sobrevive se devuelve en su forma original.
 *
 * @returns {{text: string, coAuthors: string[], removed: number}}
 */
function stripForgedTrailers(text) {
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const out = [];
    const coAuthors = [];
    let removed = 0;
    for (const line of src.split('\n')) {
        const norm = normalizeLine(line);
        const key = norm.match(FORGED_KEY);
        if (key) {
            removed++;
            if (key[1].toLowerCase() === 'co-authored-by') {
                const val = sanitizeCoAuthor(line.slice(line.indexOf(':') + 1));
                if (val) coAuthors.push(val);
            }
            continue;
        }
        if (CLOSING.test(norm)) {
            // Primero se intenta sacar SÓLO la referencia sobre el original; si
            // la versión normalizada del resto todavía cierra algo (porque el
            // cierre estaba escondido con homoglifos), cae la línea entera.
            const rest = line.replace(CLOSING_G, '').replace(/\s+$/, '');
            removed++;
            if (!rest.trim() || CLOSING.test(normalizeLine(rest))) continue;
            out.push(rest);
            continue;
        }
        out.push(line);
    }
    return { text: out.join('\n'), coAuthors, removed };
}

// -----------------------------------------------------------------------------
// Formateo de valores (desde lo que resolvió el código, nunca del LLM)
// -----------------------------------------------------------------------------

/**
 * @param {{ok:true, login:string, ts:string, kind:string, hash:string}
 *        |{ok:false, reason:string, ts:string}} human
 */
function formatHumanDirection(human) {
    if (!human || typeof human !== 'object') throw new Error('[authorship] dirección humana ausente');
    const ts = sanitizeTrailerValue(human.ts, 'iso');
    if (human.ok === true) {
        const login = sanitizeTrailerValue(human.login);
        if (!DIRECTION_KINDS.includes(human.kind)) throw new Error('[authorship] tipo de firma desconocido');
        const hash = String(human.hash || '');
        if (!new RegExp(`^${HASH_HEX}$`).test(hash)) throw new Error('[authorship] hash de ancla inválido');
        return `${login}; ${ts}; ${human.kind}:sha256:${hash}`;
    }
    if (!REASONS.includes(human.reason)) throw new Error('[authorship] motivo fuera del enum');
    return `none; ${ts}; ${human.reason}`;
}

/** @param {Array<{provider:string, model:string, role:string}>|'unknown'} ai */
function formatAiAssisted(ai) {
    if (ai === 'unknown' || !Array.isArray(ai) || ai.length === 0) return 'unknown';
    const items = ai.map((x) => {
        const provider = sanitizeTrailerValue(x.provider);
        const model = sanitizeTrailerValue(x.model);
        const role = sanitizeTrailerValue(x.role);
        if (provider.includes('/') || model.includes('/')) throw new Error('[authorship] proveedor/modelo con "/"');
        return `${provider}/${model} (${role})`;
    });
    const line = Array.from(new Set(items)).join(', ');
    if (!RX_AI.test(line)) throw new Error('[authorship] línea AI-Assisted inválida');
    return line;
}

function normalizeIssue(issue) {
    const n = Number(String(issue == null ? '' : issue).replace(/^#/, ''));
    if (!Number.isInteger(n) || n <= 0) throw new Error('[authorship] número de issue inválido');
    return n;
}

/**
 * Arma el bloque de trailers. `humanLine` / `aiLine` salen de
 * `formatHumanDirection` / `formatAiAssisted`; se revalidan acá igual para que
 * ningún caller pueda colar una línea cruda.
 *
 * @returns {string} el bloque, sin salto final.
 */
function buildTrailerBlock({ issue, humanLine, aiLine, coAuthors = [] } = {}) {
    const n = normalizeIssue(issue);
    if (typeof humanLine !== 'string' || !(RX_HUMAN_SIGNED.test(humanLine) || RX_HUMAN_NONE.test(humanLine))) {
        throw new Error('[authorship] línea Human-Direction inválida');
    }
    if (typeof aiLine !== 'string' || !RX_AI.test(aiLine)) {
        throw new Error('[authorship] línea AI-Assisted inválida');
    }
    const lines = [
        `Closes #${n}`,
        `Intrale-Issue: #${n}`,
        `Intrale-Human-Direction: ${humanLine}`,
        `Intrale-AI-Assisted: ${aiLine}`,
    ];
    const seen = new Set();
    for (const c of Array.isArray(coAuthors) ? coAuthors : []) {
        const val = sanitizeCoAuthor(c);
        if (!val) continue;
        const k = val.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        lines.push(`Co-Authored-By: ${val}`);
    }
    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Parser / verificador puro (CA-7)
// -----------------------------------------------------------------------------

function splitParagraphs(msg) {
    return String(msg == null ? '' : msg)
        .replace(/\r\n?/g, '\n')
        .replace(/\s+$/, '')
        .split(/\n[ \t]*\n/);
}

/**
 * Lee el ÚLTIMO párrafo como bloque de trailers.
 *
 * @returns {{ok:true, trailers:object}|{ok:false, error:string}}
 */
function parseTrailerBlock(msg) {
    const paragraphs = splitParagraphs(msg);
    const block = paragraphs[paragraphs.length - 1] || '';
    // Una clave Intrale-* fuera del último párrafo invalida el mensaje: es
    // exactamente la forma de colar una segunda "verdad" más arriba.
    for (let i = 0; i < paragraphs.length - 1; i++) {
        for (const line of paragraphs[i].split('\n')) {
            if (RX_INTRALE_KEY.test(normalizeLine(line))) {
                return { ok: false, error: 'clave Intrale-* fuera del bloque de trailers' };
            }
        }
    }
    const trailers = { closes: null, issue: null, humanDirection: null, aiAssisted: null, coAuthors: [], order: [] };
    const seenIntrale = new Set();
    for (const line of block.split('\n')) {
        const m = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s(.*)$/);
        const closes = line.match(/^Closes #(\d+)$/);
        if (closes) {
            if (trailers.closes !== null) return { ok: false, error: 'Closes duplicado' };
            trailers.closes = Number(closes[1]);
            trailers.order.push('Closes');
            continue;
        }
        if (!m) return { ok: false, error: 'línea que no es trailer dentro del bloque' };
        const key = m[1];
        const norm = normalizeLine(key).toLowerCase();
        if (norm.startsWith('intrale-')) {
            if (seenIntrale.has(norm)) return { ok: false, error: `clave duplicada: ${key}` };
            seenIntrale.add(norm);
        }
        switch (key) {
            case 'Intrale-Issue': trailers.issue = m[2]; break;
            case 'Intrale-Human-Direction': trailers.humanDirection = m[2]; break;
            case 'Intrale-AI-Assisted': trailers.aiAssisted = m[2]; break;
            case 'Co-Authored-By': trailers.coAuthors.push(m[2]); break;
            default:
                if (norm.startsWith('intrale-')) return { ok: false, error: `clave desconocida: ${key}` };
                return { ok: false, error: `trailer no permitido en el bloque: ${key}` };
        }
        trailers.order.push(key);
    }
    return { ok: true, trailers };
}

/**
 * Verifica que el mensaje termine con un bloque bien formado para `issue`.
 * @returns {{ok:true, trailers:object}|{ok:false, error:string}}
 */
function verifyTrailer(msg, issue) {
    let n;
    try { n = normalizeIssue(issue); } catch (e) { return { ok: false, error: e.message }; }
    const parsed = parseTrailerBlock(msg);
    if (!parsed.ok) return parsed;
    const t = parsed.trailers;
    if (t.closes !== n) return { ok: false, error: 'Closes ausente o de otro issue' };
    if (t.issue !== `#${n}`) return { ok: false, error: 'Intrale-Issue ausente o de otro issue' };
    if (!t.humanDirection || !(RX_HUMAN_SIGNED.test(t.humanDirection) || RX_HUMAN_NONE.test(t.humanDirection))) {
        return { ok: false, error: 'Intrale-Human-Direction ausente o mal formado' };
    }
    if (!t.aiAssisted || !RX_AI.test(t.aiAssisted)) {
        return { ok: false, error: 'Intrale-AI-Assisted ausente o mal formado' };
    }
    // Orden exacto: la secuencia observada tiene que ser un prefijo ordenado de
    // TRAILER_ORDER (Co-Authored-By puede repetirse al final).
    let idx = 0;
    for (const key of t.order) {
        const pos = TRAILER_ORDER.indexOf(key);
        if (pos < idx) return { ok: false, error: `orden de trailers inválido en ${key}` };
        idx = pos;
    }
    if (t.order.slice(0, 4).join('|') !== TRAILER_ORDER.slice(0, 4).join('|')) {
        return { ok: false, error: 'faltan trailers obligatorios del bloque' };
    }
    const coSeen = new Set();
    for (const c of t.coAuthors) {
        if (!sanitizeCoAuthor(c)) return { ok: false, error: 'Co-Authored-By mal formado' };
        if (coSeen.has(c.toLowerCase())) return { ok: false, error: 'Co-Authored-By duplicado' };
        coSeen.add(c.toLowerCase());
    }
    return { ok: true, trailers: t };
}

// -----------------------------------------------------------------------------
// Lectura de valores ya validados (#7633 · P2 del guru)
//
// El export de la cadena de autoría necesita el login, el tipo y la huella de
// `Intrale-Human-Direction` y la lista de `Intrale-AI-Assisted`. Se exponen acá,
// sobre las MISMAS regex que usan build y verify, para que ningún consumidor
// tenga una segunda definición del formato (SE2).
// -----------------------------------------------------------------------------

/**
 * @param {string} value — valor de `Intrale-Human-Direction` (sin la clave).
 * @returns {{signed:true, login:string, ts:string, kind:string, hash:string}
 *          |{signed:false, ts:string, reason:string}|null} null si no cumple el formato.
 */
function parseHumanDirection(value) {
    if (typeof value !== 'string') return null;
    const s = RX_HUMAN_SIGNED.exec(value);
    if (s) return { signed: true, login: s[1], ts: s[2], kind: s[3], hash: s[4] };
    const n = RX_HUMAN_NONE.exec(value);
    if (n) return { signed: false, ts: n[1], reason: n[2] };
    return null;
}

/**
 * @param {string} value — valor de `Intrale-AI-Assisted` (sin la clave).
 * @returns {'unknown'|Array<{provider:string, model:string, role:string}>|null}
 *          null si no cumple el formato.
 */
function parseAiAssisted(value) {
    if (typeof value !== 'string' || !RX_AI.test(value)) return null;
    if (value === 'unknown') return 'unknown';
    return value.split(', ').map((item) => {
        const slash = item.indexOf('/');
        const paren = item.lastIndexOf(' (');
        return { provider: item.slice(0, slash), model: item.slice(slash + 1, paren), role: item.slice(paren + 2, -1) };
    });
}

/**
 * true si ALGUNA línea del mensaje (en cualquier párrafo) es una clave
 * `Intrale-*`, con la misma normalización que `parseTrailerBlock`. Distingue un
 * commit sin bloque de autoría de uno con un bloque roto.
 */
function hasIntraleKey(msg) {
    return String(msg == null ? '' : msg).replace(/\r\n?/g, '\n').split('\n')
        .some((line) => RX_INTRALE_KEY.test(normalizeLine(line)));
}

module.exports = {
    TRAILER_ORDER,
    REASONS,
    DIRECTION_KINDS,
    stripForgedTrailers,
    sanitizeTrailerValue,
    sanitizeTitle,
    sanitizeCoAuthor,
    formatHumanDirection,
    formatAiAssisted,
    buildTrailerBlock,
    parseTrailerBlock,
    verifyTrailer,
    parseHumanDirection,
    parseAiAssisted,
    hasIntraleKey,
};
