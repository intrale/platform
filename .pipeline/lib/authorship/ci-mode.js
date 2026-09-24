'use strict';
// =============================================================================
// #7632 — Modo del check de autoría en CI (D-B · RS-5).
//
// Módulo PURO. Lee el bloque `authorship:` del `config.yaml` de `base_ref` SIN
// `js-yaml`: el job de CI no hace `npm install`, así que esto es un lector
// mínimo por indentación que sólo toma escalares de primer nivel del bloque.
//
// Tabla D-B (política PROPIA del CI; NO es la de `rollout.js`, donde "ausente"
// cae en el modo más estricto ya visto):
//
//   | Bloque                                   | Modo       |
//   |------------------------------------------|------------|
//   | ausente (o config ilegible/inexistente)  | dry-run    |
//   | `enabled: false` explícito               | disabled   |
//   | `gate_mode: off` literal                 | disabled   |
//   | `gate_mode: dry-run` o sin `gate_mode`   | dry-run    |
//   | `gate_mode: enforce`                     | enforce    |
//   | `gate_mode` con cualquier otro valor     | enforce    |
//   | bloque mal formado (indentación, tipos)  | enforce    |
//
// `gate_mode: off` es el único apagado que reconoce `rollout.js` para delivery;
// si el CI lo tratara como "valor desconocido → enforce", apagar la feature
// dejaría a todos los PR de agente frenados en CI (freno falso, #7622).
// =============================================================================

const TOP_KEY = /^authorship\s*:\s*(#.*)?$/;
const CHILD = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/;

function stripComment(value) {
    // Un ` #` fuera de comillas inicia comentario.
    let quote = null;
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (quote) { if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === '#' && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i).trim();
    }
    return value.trim();
}

function unquote(v) {
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
        return v.slice(1, -1);
    }
    return v;
}

/**
 * @param {string|null|undefined} yamlText
 * @returns {null | {malformed:true} | {malformed:false, enabled?:string, gate_mode?:string, go_live_date?:string}}
 *          `null` = bloque ausente.
 */
function readAuthorshipBlock(yamlText) {
    if (typeof yamlText !== 'string') return null;
    const lines = yamlText.replace(/\r\n?/g, '\n').split('\n');
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^authorship\s*:/.test(lines[i])) {
            if (!TOP_KEY.test(lines[i].replace(/\s+$/, ''))) return { malformed: true }; // valor inline
            if (start !== -1) return { malformed: true }; // clave duplicada
            start = i;
        }
    }
    if (start === -1) return null;

    const out = { malformed: false };
    let childIndent = -1;
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const indent = line.match(/^[ \t]*/)[0];
        if (indent.length === 0) break; // siguiente clave de primer nivel
        if (indent.includes('\t')) return { malformed: true };
        if (childIndent === -1) childIndent = indent.length;
        if (indent.length < childIndent) return { malformed: true };
        if (indent.length > childIndent) continue; // hijos anidados (identity_map, etc.)
        const m = line.trim().match(CHILD);
        if (!m) return { malformed: true };
        const key = m[1];
        if (key !== 'enabled' && key !== 'gate_mode' && key !== 'go_live_date') continue;
        if (key in out) return { malformed: true };
        out[key] = unquote(stripComment(m[2]));
    }
    if (childIndent === -1) return { malformed: true }; // `authorship:` vacío
    return out;
}

/**
 * @returns {'disabled'|'dry-run'|'enforce'}
 */
function resolveCiMode(block) {
    if (block === null || block === undefined) return 'dry-run';
    if (typeof block !== 'object' || block.malformed) return 'enforce';
    if ('enabled' in block) {
        if (block.enabled === 'false') return 'disabled';
        if (block.enabled !== 'true') return 'enforce';
    }
    if (!('gate_mode' in block)) return 'dry-run';
    if (block.gate_mode === 'off') return 'disabled';
    if (block.gate_mode === 'dry-run') return 'dry-run';
    return 'enforce';
}

/** `go_live_date` como epoch ms, o `null` si falta o no parsea. */
function goLiveMs(block) {
    if (!block || block.malformed || typeof block.go_live_date !== 'string') return null;
    const ms = Date.parse(block.go_live_date);
    return Number.isNaN(ms) ? null : ms;
}

module.exports = { readAuthorshipBlock, resolveCiMode, goLiveMs };
