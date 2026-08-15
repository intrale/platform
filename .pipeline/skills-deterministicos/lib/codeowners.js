'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HUMAN_OWNERS = new Set(['@leitolarreta']);

// #5420 — rutas candidatas de CODEOWNERS DENTRO de una ref git, en el mismo
// orden de precedencia que `loadCodeowners` local (GitHub resuelve .github/
// primero).
const CODEOWNERS_REF_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

// Ref aceptable para `git show <ref>:<path>`. Cerrada a propósito: sin espacios,
// sin ':' (separaría el path), sin metacaracteres de shell. Es defensa en
// profundidad: el ejecutor usa spawnSync con array de args y shell:false, así
// que nunca hay interpolación de shell — esto es un segundo cinturón.
const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

const DEFAULT_REF_TIMEOUT_MS = 15 * 1000;

function parseCodeowners(content) {
    const rules = [];
    if (!content) return rules;
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        if (!line) continue;
        const tokens = line.split(/\s+/);
        if (tokens.length < 2) continue;
        const pattern = tokens[0];
        const owners = tokens.slice(1).filter((t) => t.startsWith('@') || t.includes('/'));
        if (!owners.length) continue;
        rules.push({ pattern, owners });
    }
    return rules;
}

function loadCodeowners(repoRoot) {
    const candidates = [
        path.join(repoRoot, '.github', 'CODEOWNERS'),
        path.join(repoRoot, 'CODEOWNERS'),
        path.join(repoRoot, 'docs', 'CODEOWNERS'),
    ];
    for (const file of candidates) {
        try {
            if (fs.existsSync(file)) {
                return parseCodeowners(fs.readFileSync(file, 'utf8'));
            }
        } catch {}
    }
    return [];
}

// ============================================================================
// #5420 — Carga FAIL-CLOSED de CODEOWNERS desde una ref git.
// ============================================================================
//
// Por qué existe: `loadCodeowners` (arriba) devuelve `[]` tanto cuando el
// archivo NO existe como cuando existe pero no pudo leerse. El camino de merge
// de delivery.js interpretaba esa lista vacía como "este PR no tiene owners
// humanos" y habilitaba el auto-merge — un FAIL-OPEN: perder el archivo (o
// tener el worktree local podado) alcanzaba para saltear el gate de CODEOWNERS.
//
// `loadCodeownersFromRef` cierra esa puerta con dos decisiones:
//
//   1. Resultado discriminado: devuelve exclusivamente `{ ok:true, rules }` o
//      `{ ok:false, reason }`. NUNCA colapsa un fallo de carga en `rules: []`,
//      así el caller no puede confundir "no pude leer" con "no hay owners".
//   2. Lee de una ref, no del filesystem: `git show origin/main:.github/CODEOWNERS`.
//      El head del PR podría estar modificando el propio CODEOWNERS para
//      borrarse del gate; la fuente de verdad es la rama principal. Además
//      funciona aunque el worktree local esté podado o desincronizado.
//
// Un archivo presente pero SIN reglas parseables es una configuración válida:
// significa que no hay rutas sujetas a aprobación de code owners. Sigue siendo
// fail-closed ante ausencia, fallo de lectura o ref inválida; sólo distinguimos
// esos errores de un archivo legíble e intencionalmente informativo.
//
// `loadCodeowners` se conserva intacto para los consumidores locales existentes
// (no críticos); sólo el gate de merge migra a este loader.

// Sanea una razón antes de propagarla: colapsa saltos de línea, tira caracteres
// de control, redacta valores con pinta de credencial y trunca. La `reason` viaja
// a logs, marker y Telegram — no puede filtrar secrets ni romper el formato.
function sanitizeRefReason(value, max = 200) {
    let txt = value == null ? '' : String(value);
    txt = txt.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
    txt = txt
        .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{10,}/g, '<redacted>')
        .replace(/\bAKIA[0-9A-Z]{12,}/g, '<redacted>')
        .replace(/\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<redacted>')
        .replace(/\b(token|secret|password|passwd|api[_-]?key)\s*[=:]\s*\S+/gi, '$1=<redacted>');
    txt = txt.replace(/\s{2,}/g, ' ').trim();
    return txt.length > max ? `${txt.slice(0, max - 1)}…` : txt;
}

/**
 * Carga CODEOWNERS desde una ref git (típicamente `origin/main`).
 *
 * @param {string} repoRoot              cwd del `git show` (cualquier checkout del repo).
 * @param {string} ref                   ref a leer, ej. `origin/main`.
 * @param {object} [options]
 * @param {function} [options.spawnImpl] inyectable para tests (firma de spawnSync).
 * @param {number}   [options.timeoutMs] timeout por invocación de `git show`.
 * @param {string[]} [options.paths]     rutas candidatas dentro de la ref.
 * @returns {{ok:true, rules:Array, ref:string, source:string}|{ok:false, reason:string}}
 */
function loadCodeownersFromRef(repoRoot, ref, options = {}) {
    const {
        spawnImpl = spawnSync,
        timeoutMs = DEFAULT_REF_TIMEOUT_MS,
        paths = CODEOWNERS_REF_PATHS,
    } = options;

    if (!repoRoot || typeof repoRoot !== 'string') {
        return { ok: false, reason: 'repoRoot ausente o invalido' };
    }
    if (typeof ref !== 'string' || !SAFE_REF_RE.test(ref)) {
        return { ok: false, reason: `ref invalida: ${sanitizeRefReason(ref, 60) || '(vacia)'}` };
    }

    const failures = [];
    for (const rel of paths) {
        let res;
        try {
            // Array de args + shell:false: sin interpolación de shell y sin el
            // mangling de paths de MSYS que sí sufre `git show a:b` en Git Bash.
            res = spawnImpl('git', ['show', `${ref}:${rel}`], {
                cwd: repoRoot,
                encoding: 'utf8',
                timeout: timeoutMs,
                windowsHide: true,
                shell: false,
            });
        } catch (e) {
            failures.push(`${rel}: excepcion ${sanitizeRefReason(e && e.message, 80)}`);
            continue;
        }
        if (!res || typeof res !== 'object') {
            failures.push(`${rel}: ejecutor sin resultado`);
            continue;
        }
        if (res.error) {
            failures.push(`${rel}: ${sanitizeRefReason(res.error.message, 80)}`);
            continue;
        }
        if (res.status !== 0) {
            // status 128 = ref o path inexistente. Cualquier status != 0 es fallo.
            const detail = sanitizeRefReason(res.stderr, 80);
            const code = res.status === null || res.status === undefined ? 'null' : res.status;
            failures.push(`${rel}: exit=${code}${detail ? ` ${detail}` : ''}`);
            continue;
        }
        const content = typeof res.stdout === 'string' ? res.stdout : '';
        const rules = parseCodeowners(content);
        return { ok: true, rules, ref, source: rel };
    }

    return {
        ok: false,
        reason: sanitizeRefReason(`no se pudo cargar CODEOWNERS desde ${ref} — ${failures.join(' | ')}`, 300),
    };
}

function patternToRegex(pattern) {
    let p = pattern;
    const anchorAtRoot = p.startsWith('/');
    if (anchorAtRoot) p = p.slice(1);
    const dirOnly = p.endsWith('/');
    if (dirOnly) p = p.slice(0, -1);

    const SD = '';
    const SS = '';
    const SQ = '';

    const tokenized = p
        .replace(/\*\*/g, SD)
        .replace(/\*/g, SS)
        .replace(/\?/g, SQ);

    const escaped = tokenized.replace(/[.+^$|()[\]{}\\]/g, '\\$&');

    let reBody = escaped
        .replace(new RegExp(SD + '/', 'g'), '(?:.*/)?')
        .replace(new RegExp('/' + SD, 'g'), '(?:/.*)?')
        .replace(new RegExp(SD, 'g'), '.*')
        .replace(new RegExp(SS, 'g'), '[^/]*')
        .replace(new RegExp(SQ, 'g'), '[^/]');

    const prefix = anchorAtRoot ? '^' : '^(?:.*/)?';
    const suffix = '(?:/.*)?$';
    return new RegExp(prefix + reBody + suffix);
}

function matchPath(rules, filePath) {
    const norm = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    let lastMatch = null;
    for (const rule of rules) {
        const re = patternToRegex(rule.pattern);
        if (re.test(norm)) lastMatch = rule;
    }
    return lastMatch ? lastMatch.owners.slice() : [];
}

function resolveOwners(rules, paths) {
    const all = new Set();
    for (const p of paths) {
        for (const o of matchPath(rules, p)) all.add(o);
    }
    return Array.from(all);
}

function isHumanOwner(owner) {
    return HUMAN_OWNERS.has(owner);
}

function getHumanOwners(rules, paths) {
    return resolveOwners(rules, paths).filter(isHumanOwner);
}

module.exports = {
    HUMAN_OWNERS,
    parseCodeowners,
    loadCodeowners,
    // #5420 — loader fail-closed desde ref git (lo consume el gate de merge).
    loadCodeownersFromRef,
    sanitizeRefReason,
    CODEOWNERS_REF_PATHS,
    patternToRegex,
    matchPath,
    resolveOwners,
    isHumanOwner,
    getHumanOwners,
};
