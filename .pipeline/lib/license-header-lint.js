#!/usr/bin/env node
// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// license-header-lint.js — Encabezado de copyright en los fuentes (#7591, épico
// #7589). La licencia sale de la decisión firmada de #7590
// (`docs/legal/licenciamiento.md`, commit firmado 8c5473bb3).
//
// Objetivo
// --------
// Que "todo fuente tiene su encabezado" no dependa de la memoria de nadie: si
// entra un archivo sin encabezado, el hook local y el job de CI lo marcan y
// dicen exactamente cómo arreglarlo.
//
// Encabezado (CA-2), con el comentario propio de cada lenguaje:
//
//   // Copyright (c) <año> <holder>
//   // SPDX-License-Identifier: <spdx>
//
// `holder` y `spdx` viven SOLO en `license-header-lint.config.json`. Se acepta
// cualquier año (`AAAA` o `AAAA-AAAA`): no obliga a reescribir todo en enero.
//
// Uso
// ---
//   node .pipeline/lib/license-header-lint.js --check                    repo completo (default)
//   node .pipeline/lib/license-header-lint.js --check --diff-env <VAR>   sólo lo cambiado vs la base (CI en PR)
//   node .pipeline/lib/license-header-lint.js --check --staged           sólo lo staged (hook pre-commit)
//   node .pipeline/lib/license-header-lint.js --check <paths...>         sólo esos archivos
//   node .pipeline/lib/license-header-lint.js --fix [paths...]           escribe (uso LOCAL, nunca en CI)
//
// Exit codes (mismo contrato que write-target-lint): 0 limpio · 1 rojo · 2 error
// de config (config/allowlist inválidas, base no-SHA, path fuera del repo).
//
// Seguridad
// ---------
// - SEC-3: `child_process` sólo como `execFileSync('git', [argv fijo])`, sin
//   shell. Los nombres de archivo nunca pasan por una línea de comandos.
// - SEC-7: lista de archivos por `git ls-files` (nunca walk del FS); no sigue
//   symlinks (`lstat`) y aborta si un `realpath` cae fuera del repo.
// - SEC-8: allowlist por extensión + exclusiones FIJAS (no configurables):
//   `*.conf`, `.env*`, `*credentials*`, `*secret*`, binarios y `.ps1` firmados.
// - SEC-4: la allowlist exige `motivo` y rechaza globs demasiado amplios.
// - SEC-10: en `--check` se leen sólo los primeros 2 KB de cada archivo.
// - SEC-11: la salida nunca incluye contenido de archivos.
//
// Sin dependencias npm ni config del pipeline: sólo módulos core de Node (el
// job de CI corre sin `npm ci`). No usa `fs.glob` ni `path.matchesGlob`
// (Node 22+): el CI corre Node 20.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PREFIX = 'license-header-lint:';
const SCRIPT_REL = '.pipeline/lib/license-header-lint.js';
const CONFIG_REL = '.pipeline/lib/license-header-lint.config.json';
const ALLOWLIST_REL = '.pipeline/lib/license-header-lint.allowlist.json';

const HEAD_BYTES = 2048;
const MAX_GIT_BUFFER = 64 * 1024 * 1024;
const AGGREGATE_FIX_MAX = 50;

/** Extensión → marcador de comentario de línea (CA-2). */
const COMMENT_BY_EXT = Object.freeze({
    '.kt': '//',
    '.kts': '//',
    '.js': '//',
    '.mjs': '//',
    '.cjs': '//',
    '.sh': '#',
    '.ps1': '#',
    '.py': '#',
});

/** Directorios fuente sobre los que una excepción `<dir>/**` es demasiado amplia (SEC-4). */
const SOURCE_DIRS = Object.freeze([
    'app', 'backend', 'users', 'shared', '.pipeline', '.pipeline/lib',
    'scripts', 'buildSrc', 'tools', 'qa',
]);

const WIDE_GLOBS = Object.freeze(['*', '**', '**/*', '*/**']);

const SPDX_RE = /^[A-Za-z0-9.+-]+$/;
const YEAR_RE = /^\d{4}(-\d{4})?$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const PS1_SIGNATURE = '# SIG # Begin signature block';

class ConfigError extends Error {}

// -----------------------------------------------------------------------------
// Utilidades puras (exportadas para tests)
// -----------------------------------------------------------------------------

/**
 * Escapa una PROPIEDAD de un workflow command de GitHub Actions
 * (`::error file=<prop>,line=1::`). Sin esto un path con `,` o `:` corta la
 * propiedad y uno con salto de línea inyecta otro comando.
 */
function escapeWorkflowProperty(value) {
    return String(value)
        .replace(/%/g, '%25')
        .replace(/\r/g, '%0D')
        .replace(/\n/g, '%0A')
        .replace(/:/g, '%3A')
        .replace(/,/g, '%2C');
}

/** Escapa el MENSAJE de un workflow command (`::error ...::<data>`). */
function escapeWorkflowData(value) {
    return String(value)
        .replace(/%/g, '%25')
        .replace(/\r/g, '%0D')
        .replace(/\n/g, '%0A');
}

/**
 * Path apto para mostrar en el log: si tiene caracteres de control (p. ej. un
 * salto de línea en el nombre), se muestra escapado para que no pueda fabricar
 * líneas falsas ni workflow commands en la salida.
 */
function displayPath(rel) {
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u001f\u007f]/.test(rel) ? JSON.stringify(rel) : rel;
}

/** Quoting POSIX para los comandos sugeridos: el dev puede copiar y pegar sin que el shell interprete nada. */
function shellQuote(rel) {
    if (/^[A-Za-z0-9._/@+=-]+$/.test(rel)) return rel;
    return "'" + rel.replace(/'/g, "'\\''") + "'";
}

/**
 * Glob → RegExp anclada. Sólo `**`, `*` y `?`; todo lo demás es literal.
 * `**` cruza directorios, `*` y `?` no.
 */
function globToRegExp(glob) {
    let re = '';
    let i = 0;
    while (i < glob.length) {
        const ch = glob[i];
        if (ch === '*') {
            if (glob[i + 1] === '*') {
                const atStart = i === 0 || glob[i - 1] === '/';
                const followedBySlash = glob[i + 2] === '/';
                if (atStart && followedBySlash) {
                    re += '(?:.*/)?';
                    i += 3;
                } else {
                    re += '.*';
                    i += 2;
                }
            } else {
                re += '[^/]*';
                i += 1;
            }
        } else if (ch === '?') {
            re += '[^/]';
            i += 1;
        } else {
            re += ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
            i += 1;
        }
    }
    return new RegExp('^' + re + '$');
}

/**
 * Motivo por el que un glob de la allowlist es demasiado amplio, o null si es
 * aceptable (SEC-4 / CA-10).
 */
function wideGlobReason(glob) {
    if (WIDE_GLOBS.includes(glob)) return `glob demasiado amplio ("${glob}")`;
    for (const dir of SOURCE_DIRS) {
        if (glob === `${dir}/**` || glob === `${dir}/**/*` || glob === `${dir}/*`) {
            return `glob demasiado amplio sobre el directorio fuente "${dir}/"`;
        }
    }
    // Generalización: un glob sin NINGÚN segmento literal (`**/*.js`, `*.kt`,
    // `*/*`) no está anclado a ningún directorio y apaga el gate en todo el repo.
    const segments = glob.split('/').filter(Boolean);
    if (!segments.some((s) => !/[*?]/.test(s))) {
        return `glob sin ningún directorio literal ("${glob}") — apaga el gate en todo el repo`;
    }
    return null;
}

/** Valida la config del header. Lanza ConfigError. */
function validateConfig(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ConfigError('la config no es un objeto JSON');
    }
    const holder = typeof raw.holder === 'string' ? raw.holder.trim() : '';
    const spdx = typeof raw.spdx === 'string' ? raw.spdx.trim() : '';
    if (!holder) throw new ConfigError('config: "holder" vacío o ausente');
    if (holder.includes('@')) throw new ConfigError('config: "holder" no puede contener "@" (sin emails, SEC-12)');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(holder)) throw new ConfigError('config: "holder" tiene caracteres de control');
    if (!SPDX_RE.test(spdx)) throw new ConfigError('config: "spdx" inválido (se espera ^[A-Za-z0-9.+-]+$)');
    return { holder, spdx };
}

/** Normaliza la lista de excepciones sin validar (para el diff de CA-11). */
function rawExceptions(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.exceptions)) return [];
    return raw.exceptions.map((e) => ({
        glob: e && typeof e.glob === 'string' ? e.glob.trim() : '',
        motivo: e && typeof e.motivo === 'string' ? e.motivo.trim() : '',
    }));
}

/** Valida la allowlist. Devuelve [{glob, motivo, re}]. Lanza ConfigError. */
function validateAllowlist(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.exceptions)) {
        throw new ConfigError('allowlist: se espera un objeto con "exceptions" (array)');
    }
    const errors = [];
    const out = [];
    raw.exceptions.forEach((e, idx) => {
        const n = idx + 1;
        const glob = e && typeof e.glob === 'string' ? e.glob.trim() : '';
        const motivo = e && typeof e.motivo === 'string' ? e.motivo.trim() : '';
        if (!glob) { errors.push(`excepción #${n}: falta "glob"`); return; }
        if (!motivo) { errors.push(`excepción #${n} ("${glob}"): falta "motivo" (toda excepción se justifica)`); return; }
        if (glob.startsWith('/') || glob.split('/').includes('..')) {
            errors.push(`excepción #${n} ("${glob}"): el glob tiene que ser relativo a la raíz y sin ".."`);
            return;
        }
        const wide = wideGlobReason(glob);
        if (wide) { errors.push(`excepción #${n}: ${wide}`); return; }
        out.push({ glob, motivo, re: globToRegExp(glob) });
    });
    if (errors.length) throw new ConfigError('allowlist inválida:\n' + errors.map((m) => `  - ${m}`).join('\n'));
    return out;
}

/**
 * Exclusión FIJA (SEC-8): no se puede quitar desde la allowlist. Devuelve el
 * motivo o null.
 */
function fixedExclusion(rel) {
    const base = path.posix.basename(rel).toLowerCase();
    if (base.endsWith('.conf')) return 'archivo .conf';
    if (base.startsWith('.env')) return 'archivo .env*';
    if (base.includes('credentials')) return 'nombre con "credentials"';
    if (base.includes('secret')) return 'nombre con "secret"';
    return null;
}

function commentFor(rel) {
    return COMMENT_BY_EXT[path.posix.extname(rel).toLowerCase()] || null;
}

function expectedLines(c, cfg, year) {
    return [`${c} Copyright (c) ${year} ${cfg.holder}`, `${c} SPDX-License-Identifier: ${cfg.spdx}`];
}

function isPyEncodingLine(line) {
    return /^[ \t\f]*#.*?coding[:=][ \t]*[-\w.]+/.test(line);
}

/**
 * Offset (en caracteres, sin BOM) donde va el encabezado: después del shebang
 * y, en .py, de la línea de encoding (PEP 263, líneas 1-2), EOL incluido.
 */
function splitPreamble(text, rel) {
    let offset = 0;
    const nextLine = () => {
        const nl = text.indexOf('\n', offset);
        const end = nl === -1 ? text.length : nl + 1;
        const line = text.slice(offset, nl === -1 ? text.length : nl).replace(/\r$/, '');
        return { line, end };
    };
    let first = nextLine();
    if (first.line.startsWith('#!')) {
        offset = first.end;
        first = nextLine();
    }
    if (path.posix.extname(rel).toLowerCase() === '.py' && offset < text.length && isPyEncodingLine(first.line)) {
        offset = first.end;
    }
    return offset;
}

/** Lee hasta 2 líneas a partir de `offset`, con su largo en caracteres (EOL incluido). */
function readLinesAt(text, offset, count) {
    const out = [];
    let pos = offset;
    for (let i = 0; i < count && pos < text.length; i++) {
        const nl = text.indexOf('\n', pos);
        const end = nl === -1 ? text.length : nl + 1;
        out.push({ line: text.slice(pos, nl === -1 ? text.length : nl).replace(/\r$/, ''), start: pos, end });
        pos = end;
    }
    return out;
}

/**
 * Clasifica el encabezado de un texto (sin BOM).
 * @returns {{status:'ok'|'missing'|'malformed', detail?:string, headerLines:number, keepCopyright?:string}}
 */
function classifyText(text, rel, cfg) {
    const c = commentFor(rel);
    const offset = splitPreamble(text, rel);
    const [a, b] = readLinesAt(text, offset, 2);
    const la = a ? a.line : '';
    const lb = b ? b.line : '';
    const cpPrefix = `${c} Copyright (c) `;
    const spdxPrefix = `${c} SPDX-License-Identifier:`;
    const spdxExpected = `${c} SPDX-License-Identifier: ${cfg.spdx}`;

    const isCp = la.startsWith(cpPrefix) || la.startsWith(`${c} Copyright`);
    let cpOk = false;
    if (la.startsWith(cpPrefix)) {
        const rest = la.slice(cpPrefix.length);
        const sp = rest.indexOf(' ');
        if (sp > 0) cpOk = YEAR_RE.test(rest.slice(0, sp)) && rest.slice(sp + 1) === cfg.holder;
    }

    if (isCp) {
        const spdxHere = lb.startsWith(spdxPrefix);
        if (cpOk && lb === spdxExpected) return { status: 'ok', headerLines: 2, offset };
        if (!cpOk) {
            return {
                status: 'malformed',
                detail: `línea Copyright distinta (se espera "${c} Copyright (c) <año> ${cfg.holder}")`,
                headerLines: spdxHere ? 2 : 1,
                offset,
            };
        }
        if (!spdxHere) {
            return { status: 'malformed', detail: 'falta la línea SPDX-License-Identifier', headerLines: 1, offset, keepCopyright: la };
        }
        return {
            status: 'malformed',
            detail: `SPDX-License-Identifier distinto (se espera "${cfg.spdx}")`,
            headerLines: 2,
            offset,
            keepCopyright: la,
        };
    }
    if (la.startsWith(spdxPrefix)) {
        return { status: 'malformed', detail: 'falta la línea Copyright', headerLines: 1, offset };
    }
    return { status: 'missing', detail: 'falta el encabezado', headerLines: 0, offset };
}

/** EOL dominante: `\r\n` si hay más CRLF que LF sueltos. */
function dominantEol(text) {
    const crlf = (text.match(/\r\n/g) || []).length;
    const lf = (text.match(/\n/g) || []).length - crlf;
    return crlf > lf ? '\r\n' : '\n';
}

/**
 * Devuelve el texto (sin BOM) con el encabezado aplicado, o null si ya estaba bien.
 */
function applyHeader(text, rel, cfg, year) {
    const cls = classifyText(text, rel, cfg);
    if (cls.status === 'ok') return null;
    const c = commentFor(rel);
    const eol = dominantEol(text);
    const [lineA, lineB] = expectedLines(c, cfg, year);
    const header = (cls.keepCopyright || lineA) + eol + lineB + eol;

    let prefix = text.slice(0, cls.offset);
    if (prefix.length > 0 && !prefix.endsWith('\n')) prefix += eol;

    let restStart = cls.offset;
    if (cls.headerLines > 0) {
        const lines = readLinesAt(text, cls.offset, cls.headerLines);
        restStart = lines[lines.length - 1].end;
    }
    const rest = text.slice(restStart);
    if (rest.length === 0) return prefix + header;
    // Una sola línea en blanco entre el encabezado y el contenido. Si el
    // contenido ya arrancaba con una línea en blanco, se reusa (idempotencia).
    const startsBlank = rest.startsWith('\n') || rest.startsWith('\r\n');
    return prefix + header + (startsBlank ? '' : eol) + rest;
}

// -----------------------------------------------------------------------------
// Acceso a git / filesystem
// -----------------------------------------------------------------------------

function git(repoRoot, args) {
    return execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: MAX_GIT_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
}

function splitZ(out) {
    return out.split('\0').filter(Boolean);
}

function detectRepoRoot(cwd) {
    try {
        return git(cwd, ['rev-parse', '--show-toplevel']).trim();
    } catch (_) {
        throw new ConfigError('no se pudo resolver la raíz del repo (¿se corre dentro de un checkout de git?)');
    }
}

function readJson(abs, label) {
    let txt;
    try {
        txt = fs.readFileSync(abs, 'utf8');
    } catch (_) {
        throw new ConfigError(`no se pudo leer ${label}`);
    }
    try {
        return JSON.parse(txt.replace(/^﻿/, ''));
    } catch (_) {
        throw new ConfigError(`${label} no es JSON válido`);
    }
}

function readHead(abs, bytes) {
    const fd = fs.openSync(abs, 'r');
    try {
        const buf = Buffer.alloc(bytes);
        const n = fs.readSync(fd, buf, 0, bytes, 0);
        return buf.subarray(0, n);
    } finally {
        fs.closeSync(fd);
    }
}

function writeAtomic(abs, content, mode) {
    const dir = path.dirname(abs);
    const tmp = path.join(dir, `.${path.basename(abs)}.lhl-${process.pid}.tmp`);
    try {
        fs.writeFileSync(tmp, content, { mode });
        fs.renameSync(tmp, abs);
        try { fs.chmodSync(abs, mode); } catch (_) { /* FS sin permisos POSIX */ }
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch (_) { /* ya no existe */ }
        throw err;
    }
}

/**
 * Resuelve el path real y aborta si sale del repo (SEC-7). Devuelve null si el
 * archivo no existe, es symlink o no es un archivo regular (se ignora).
 */
function resolveSafe(realRoot, repoRoot, rel) {
    const abs = path.join(repoRoot, rel);
    let st;
    try {
        st = fs.lstatSync(abs);
    } catch (_) {
        return { skip: 'no existe' };
    }
    if (st.isSymbolicLink()) return { skip: 'symlink (no se sigue)' };
    if (!st.isFile()) return { skip: 'no es un archivo regular' };
    const real = fs.realpathSync.native(abs);
    const relReal = path.relative(realRoot, real);
    if (!relReal || relReal.startsWith('..') || path.isAbsolute(relReal)) {
        throw new ConfigError(`path fuera del repo: ${displayPath(rel)}`);
    }
    return { abs, mode: st.mode & 0o7777 };
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

function parseArgs(argv) {
    const opts = { mode: 'check', staged: false, diffEnv: null, paths: [], repoRoot: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--check') opts.mode = 'check';
        else if (a === '--fix') opts.mode = 'fix';
        else if (a === '--staged') opts.staged = true;
        else if (a === '--diff-env') {
            opts.diffEnv = argv[++i];
            if (!opts.diffEnv) throw new ConfigError('--diff-env requiere el NOMBRE de una variable de entorno');
        } else if (a === '--repo-root') {
            opts.repoRoot = argv[++i];
            if (!opts.repoRoot) throw new ConfigError('--repo-root requiere un directorio');
        } else if (a === '--') {
            opts.paths.push(...argv.slice(i + 1));
            break;
        } else if (a.startsWith('--')) {
            throw new ConfigError(`opción desconocida: ${a}`);
        } else {
            opts.paths.push(a);
        }
    }
    if (opts.mode === 'fix' && (opts.staged || opts.diffEnv)) {
        throw new ConfigError('--fix no se combina con --staged ni --diff-env');
    }
    if (opts.staged && opts.diffEnv) throw new ConfigError('--staged y --diff-env son excluyentes');
    return opts;
}

/**
 * Lista los archivos a evaluar (relativos a la raíz, con `/`) y, en modo
 * diff/staged, la referencia base contra la que comparar la allowlist (CA-11).
 */
function listFiles(opts, repoRoot, env, cwd) {
    if (opts.diffEnv) {
        const base = String(env[opts.diffEnv] || '').trim();
        if (!SHA_RE.test(base)) {
            throw new ConfigError(`la variable ${opts.diffEnv} no contiene un SHA de 40 caracteres hex`);
        }
        let out;
        try {
            out = git(repoRoot, ['diff', '--name-only', '-z', '--diff-filter=ACMR', `${base}...HEAD`]);
        } catch (_) {
            throw new ConfigError('git diff contra la base falló (¿checkout con fetch-depth: 0?)');
        }
        return { files: splitZ(out), baseRef: base };
    }
    if (opts.staged) {
        const out = git(repoRoot, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']);
        let baseRef = null;
        try { git(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']); baseRef = 'HEAD'; } catch (_) { /* repo sin commits */ }
        return { files: splitZ(out), baseRef };
    }
    if (opts.paths.length) {
        const files = [];
        for (const p of opts.paths) {
            const abs = path.resolve(cwd, p);
            const rel = path.relative(repoRoot, abs);
            if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
                throw new ConfigError(`path fuera del repo: ${displayPath(p)}`);
            }
            files.push(rel.split(path.sep).join('/'));
        }
        return { files, baseRef: null };
    }
    return { files: splitZ(git(repoRoot, ['ls-files', '-z'])), baseRef: null };
}

/** Entradas de la allowlist agregadas respecto de la base (CA-11 / SEC-6). */
function addedExceptions(repoRoot, baseRef, files, currentRaw) {
    if (!baseRef || !files.includes(ALLOWLIST_REL)) return [];
    let baseRaw = null;
    try {
        baseRaw = JSON.parse(git(repoRoot, ['show', `${baseRef}:${ALLOWLIST_REL}`]).replace(/^﻿/, ''));
    } catch (_) {
        baseRaw = null; // archivo nuevo en este PR: todas sus entradas son agregadas
    }
    const key = (e) => `${e.glob}\u0000${e.motivo}`;
    const before = new Set(rawExceptions(baseRaw).map(key));
    return rawExceptions(currentRaw).filter((e) => !before.has(key(e)));
}

function main(argv, io = {}) {
    const stdout = io.stdout || ((s) => process.stdout.write(s + '\n'));
    const stderr = io.stderr || ((s) => process.stderr.write(s + '\n'));
    const env = io.env || process.env;
    const cwd = io.cwd || process.cwd();
    const year = io.year || new Date().getFullYear();

    try {
        const opts = parseArgs(argv);
        const repoRoot = path.resolve(opts.repoRoot || io.repoRoot || detectRepoRoot(cwd));
        const realRoot = fs.realpathSync.native(repoRoot);

        const cfg = validateConfig(readJson(path.join(repoRoot, CONFIG_REL), CONFIG_REL));
        const allowRaw = readJson(path.join(repoRoot, ALLOWLIST_REL), ALLOWLIST_REL);
        const { files, baseRef } = listFiles(opts, repoRoot, env, cwd);

        // CA-11: se informa ANTES de validar, así una excepción rechazada
        // (p. ej. "**") igual aparece listada en la salida del job.
        const added = addedExceptions(repoRoot, baseRef, files, allowRaw);
        if (added.length) {
            stdout(`${PREFIX} ⚠ Este PR agrega ${added.length} ${added.length === 1 ? 'excepción' : 'excepciones'}:`);
            for (const e of added) stdout(`  + ${displayPath(e.glob || '(sin glob)')} — ${e.motivo ? displayPath(e.motivo) : '(sin motivo)'}`);
            stdout('');
        }
        const allow = validateAllowlist(allowRaw);

        const stats = { reviewed: 0, excluded: 0, modified: 0, alreadyOk: 0 };
        const failures = [];
        const fixErrors = [];

        for (const rel of files) {
            if (!commentFor(rel)) continue;
            if (fixedExclusion(rel) || allow.some((e) => e.re.test(rel))) {
                stats.excluded++;
                continue;
            }
            const res = resolveSafe(realRoot, repoRoot, rel);
            if (res.skip) {
                if (res.skip !== 'no existe') stats.excluded++;
                continue;
            }
            const isPs1 = path.posix.extname(rel).toLowerCase() === '.ps1';
            const readAll = opts.mode === 'fix' || isPs1;
            const buf = readAll ? fs.readFileSync(res.abs) : readHead(res.abs, HEAD_BYTES);
            if (buf.includes(0)) { stats.excluded++; continue; }
            const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
            const text = buf.toString('utf8', hasBom ? 3 : 0);
            if (isPs1 && text.includes(PS1_SIGNATURE)) { stats.excluded++; continue; }

            stats.reviewed++;
            if (opts.mode === 'check') {
                const cls = classifyText(text, rel, cfg);
                if (cls.status !== 'ok') failures.push({ rel, detail: cls.status === 'missing' ? 'falta el encabezado' : `encabezado mal formado (${cls.detail})` });
                continue;
            }
            const next = applyHeader(text, rel, cfg, year);
            if (next === null) { stats.alreadyOk++; continue; }
            try {
                const out = Buffer.concat([hasBom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(next, 'utf8')]);
                writeAtomic(res.abs, out, res.mode);
                stats.modified++;
            } catch (err) {
                fixErrors.push({ rel, code: err && err.code ? err.code : 'ERROR' });
            }
        }

        if (opts.mode === 'fix') {
            stdout(`${PREFIX} ${stats.modified} modificados · ${stats.alreadyOk} ya estaban bien · ${stats.excluded} exceptuados`);
            for (const f of fixErrors) stderr(`${PREFIX} ✗ no se pudo escribir ${displayPath(f.rel)} (${f.code})`);
            return fixErrors.length ? 1 : 0;
        }

        if (!failures.length) {
            stdout(`${PREFIX} OK — ${stats.reviewed} revisados, ${stats.excluded} exceptuados`);
            return 0;
        }
        reportFailures(failures, stats, cfg, stdout, env);
        return 1;
    } catch (err) {
        if (err instanceof ConfigError) {
            stderr(`${PREFIX} error de configuración: ${err.message}`);
            return 2;
        }
        stderr(`${PREFIX} error inesperado: ${err && err.message ? err.message : String(err)}`);
        return 2;
    }
}

function reportFailures(failures, stats, cfg, stdout, env) {
    const n = failures.length;
    stdout(`${PREFIX} ${n} ${n === 1 ? 'archivo' : 'archivos'} sin encabezado de copyright válido (${stats.reviewed} revisados, ${stats.excluded} exceptuados)`);
    stdout('');
    const width = Math.min(70, Math.max(...failures.map((f) => displayPath(f.rel).length)));
    for (const f of failures) stdout(`  ✗ ${displayPath(f.rel).padEnd(width)}  ${f.detail}`);
    stdout('');

    const byComment = new Map();
    for (const f of failures) {
        const c = commentFor(f.rel);
        const ext = path.posix.extname(f.rel).toLowerCase();
        if (!byComment.has(c)) byComment.set(c, new Set());
        byComment.get(c).add(ext);
    }
    for (const [c, exts] of byComment) {
        const [a, b] = expectedLines(c, cfg, '<año>');
        stdout(`Encabezado esperado (${[...exts].sort().join(', ')}):`);
        stdout(`  ${a}`);
        stdout(`  ${b}`);
        stdout('');
    }

    stdout('Para corregir (uso local; después commiteá el resultado):');
    for (const f of failures) stdout(`  node ${SCRIPT_REL} --fix ${shellQuote(f.rel)}`);
    if (n > 1) {
        stdout('');
        if (n <= AGGREGATE_FIX_MAX) {
            stdout('Todos juntos:');
            stdout(`  node ${SCRIPT_REL} --fix ${failures.map((f) => shellQuote(f.rel)).join(' ')}`);
        } else {
            stdout('Todos juntos (repo completo):');
            stdout(`  node ${SCRIPT_REL} --fix`);
        }
    }

    if (env.GITHUB_ACTIONS === 'true') {
        for (const f of failures) {
            stdout(`::error file=${escapeWorkflowProperty(f.rel)},line=1::${escapeWorkflowData(`${PREFIX} ${f.detail}. Corregir con: node ${SCRIPT_REL} --fix <archivo>`)}`);
        }
    }
}

module.exports = {
    main,
    parseArgs,
    classifyText,
    applyHeader,
    validateConfig,
    validateAllowlist,
    wideGlobReason,
    globToRegExp,
    fixedExclusion,
    escapeWorkflowProperty,
    escapeWorkflowData,
    dominantEol,
    ConfigError,
    COMMENT_BY_EXT,
    CONFIG_REL,
    ALLOWLIST_REL,
};

if (require.main === module) {
    // `... | head` cierra el pipe antes de tiempo: no es un error del lint.
    process.stdout.on('error', (err) => { if (err && err.code !== 'EPIPE') throw err; });
    process.exitCode = main(process.argv.slice(2));
}
