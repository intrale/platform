#!/usr/bin/env node
'use strict';

// =============================================================================
// ghost-artifact-lint.js — Linter del invariant del filtro `isMarkerArtifact`
// en carpetas operacionales del pipeline V2 (#3638 CA-F-9..F-11).
//
// Objetivo
// --------
// Garantizar que cualquier componente del pipeline JS que lea directorios
// operacionales (`.pipeline/definicion/**`, `.pipeline/desarrollo/**`) aplique
// `isMarkerArtifact` al resultado. Sin este filtro, archivos auxiliares
// (`.comment.md`, `.guidance.txt`, `.reason.json`) aparecen como markers
// fantasma y rompen el invariante del Pulpo (incidente 2026-05-11 con
// `#3073.pipeline-dev.guidance.txt`).
//
// Heurística (regex pragmática sobre source)
// ------------------------------------------
// Para cada archivo `.js` bajo `.pipeline/` (excluyendo node_modules/tests/
// allowlist):
//   1. Buscar matches de `fs.readdirSync(...)` o `fs.readdir(...)` cuyo path
//      argumento contenga literales `'definicion'` o `'desarrollo'`, o
//      variables que se ven definidas con esos literales en el mismo archivo.
//   2. Para cada match, verificar que dentro de ±25 líneas haya una
//      referencia a `isMarkerArtifact`.
//   3. Si no, emitir violation `{ file, line, snippet, reason }`.
//
// Allowlist (`ghost-artifact-lint.allowlist.json`)
// ------------------------------------------------
// Permite excepciones documentadas:
//   {
//     "files": ["lib/foo.js"],            // archivo entero excluido
//     "rules": [ { "file": "lib/bar.js", "line": 42, "reason": "..." } ]
//   }
//
// Salida
// ------
// CLI:
//   node .pipeline/lib/ghost-artifact-lint.js [--check]
//     exit 0: clean
//     exit 1: violations encontradas (lista + paths)
//     exit 2: error interno
//
// API:
//   const { lint } = require('./ghost-artifact-lint');
//   const { violations, scanned } = lint({ pipelineRoot, allowlist });
// =============================================================================

const fs = require('fs');
const path = require('path');

const LOG_PREFIX = '[ghost-artifact-lint]';

const DEFAULT_PIPELINE_ROOT = path.resolve(__dirname, '..');
const ALLOWLIST_FILE = 'ghost-artifact-lint.allowlist.json';

// Carpetas / archivos excluidos por convención del scan (no son código que
// lea estado operacional en runtime del pulpo).
const SKIP_DIRS = new Set([
    'node_modules', '__tests__', '_test-helpers', 'tests', 'archived',
    'archivado', 'audit', 'audio', 'logs', 'events', 'tmp', 'sessions',
    'metrics', 'definicion', 'desarrollo', 'servicios', 'quota-snapshots',
    'snapshots', 'fixtures', 'assets',
]);

// El propio cleaner y el propio lint quedan exentos por construcción
// (el cleaner barre carpetas operacionales con su propia lógica, ya
// auditada por este mismo issue).
const SELF_EXEMPT = new Set([
    'lib/ghost-artifact-cleaner.js',
    'lib/ghost-artifact-lint.js',
    'lib/marker-artifact.js',
]);

// Regex que matchea fs.readdirSync(...) o fs.readdir(...) capturando el primer
// argumento (path). Multi-línea robusto: matchea hasta el primer `,` o `)`.
const READDIR_RE = /\bfs\s*\.\s*readdir(?:Sync)?\s*\(\s*([^,)]+)/g;

// Identificadores que sugieren que estamos leyendo una carpeta operacional.
const OPS_HINTS = ['definicion', 'desarrollo', 'pendiente', 'trabajando', 'listo', 'procesado', 'PIPELINE_DIR', 'stateDir', 'phaseDir', 'pipeDir'];

function defaultLogger() {
    return {
        info: (m) => console.log(`${LOG_PREFIX} ${m}`),
        warn: (m) => console.warn(`${LOG_PREFIX} ${m}`),
        error: (m) => console.error(`${LOG_PREFIX} ${m}`),
    };
}

function loadAllowlist(pipelineRoot) {
    const file = path.join(pipelineRoot, 'lib', ALLOWLIST_FILE);
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const j = JSON.parse(raw);
        const files = new Set((j.files || []).map(f => f.replace(/\\/g, '/')));
        const rules = (j.rules || []).map(r => ({
            file: (r.file || '').replace(/\\/g, '/'),
            line: r.line,
            reason: r.reason || '',
        }));
        return { files, rules };
    } catch {
        return { files: new Set(), rules: [] };
    }
}

function walkJs(root) {
    const out = [];
    function recurse(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            if (e.isSymbolicLink()) continue;
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue;
                if (e.name.startsWith('.')) continue;
                recurse(path.join(dir, e.name));
            } else if (e.isFile()) {
                if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) {
                    out.push(path.join(dir, e.name));
                }
            }
        }
    }
    recurse(root);
    return out;
}

function pathPosixRel(pipelineRoot, absolute) {
    return path.relative(pipelineRoot, absolute).split(path.sep).join('/');
}

function lineOfOffset(source, offset) {
    let line = 1;
    for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++;
    return line;
}

function lookupContext(source, line, radius = 25) {
    const lines = source.split('\n');
    const start = Math.max(0, line - 1 - radius);
    const end = Math.min(lines.length, line - 1 + radius + 1);
    return lines.slice(start, end).join('\n');
}

/**
 * Heurística "argumento parece carpeta operacional":
 *   - Literal contiene 'definicion' / 'desarrollo' / state names.
 *   - O usa un identificador que en el mismo archivo se ve construido con
 *     esos literales.
 */
function looksLikeOpsPath(arg, fullSource, scopeText) {
    const lit = arg.trim();
    // Caso 1 — literal directo: el argumento contiene un string literal con
    // 'definicion' o 'desarrollo' (con o sin sub-carpeta de estado).
    const litRootRe = /['"`][^'"`]*(?:definicion|desarrollo)\b[^'"`]*['"`]/;
    if (litRootRe.test(lit)) return true;
    // Caso 2 — identifier: el argumento es un nombre de variable. Para
    // evitar falsos positivos en archivos grandes (pulpo.js tiene cientos
    // de `dir`/`pipeDir`/`trabajandoDir` legítimos), exigimos que la
    // asignación con literal ops esté en el contexto local (±25 líneas).
    // Si no, lo dejamos pasar.
    const idRe = /^[A-Za-z_$][\w$]*$/;
    if (idRe.test(lit) && scopeText) {
        // Identificadores obviamente operacionales (por su nombre) Y un
        // literal ops en el contexto local — match.
        const opsLitLocal = /['"`](?:definicion|desarrollo)\b/;
        const isOpsName = /(?:trabajando|pendiente|listo|procesado|phaseDir|pipeDir|stateDir|PIPELINE_DIR|stateDir|opsDir)/.test(lit);
        if (isOpsName && opsLitLocal.test(scopeText)) return true;
        // Asignación local con literal ops: `const dir = '.../definicion/...'`
        // o `const dir = path.join(..., 'pendiente')`.
        const localAssignRe = new RegExp(`(?:const|let|var)\\s+${lit}\\s*=[^\\n]*['"\`][^'"\`]*(?:definicion|desarrollo|pendiente|trabajando|procesado|listo)\\b`);
        if (localAssignRe.test(scopeText)) return true;
    }
    return false;
}

function hasFilterNearby(source, line) {
    const ctx = lookupContext(source, line, 25);
    // Acepta variantes locales (`isMarkerArtifactPulpo`, etc.) que delegan en
    // la fuente canónica de `lib/marker-artifact.js`. Lo que importa es que
    // el filtro se aplique cerca del readdir; la variante de nombre es legacy.
    return /isMarkerArtifact[A-Za-z]*\b/.test(ctx);
}

function lintFile(absolute, pipelineRoot, allowlist) {
    const rel = pathPosixRel(pipelineRoot, absolute);
    if (allowlist.files.has(rel)) return [];
    if (SELF_EXEMPT.has(rel)) return [];
    let src;
    try { src = fs.readFileSync(absolute, 'utf8'); }
    catch { return []; }

    const out = [];
    READDIR_RE.lastIndex = 0;
    let m;
    while ((m = READDIR_RE.exec(src)) !== null) {
        const arg = m[1];
        const line = lineOfOffset(src, m.index);
        const localScope = lookupContext(src, line, 25);
        if (!looksLikeOpsPath(arg, src, localScope)) continue;
        if (hasFilterNearby(src, line)) continue;
        // ¿Está en allowlist puntual?
        const ruled = allowlist.rules.find(r => r.file === rel && r.line === line);
        if (ruled) continue;
        out.push({
            file: rel,
            line,
            snippet: m[0].slice(0, 120),
            reason: 'fs.readdir(Sync) sobre carpeta operacional sin isMarkerArtifact cerca (±25 líneas)',
        });
    }
    return out;
}

function lint(opts = {}) {
    const pipelineRoot = opts.pipelineRoot || DEFAULT_PIPELINE_ROOT;
    const allowlist = opts.allowlist || loadAllowlist(pipelineRoot);
    const files = walkJs(pipelineRoot);
    const violations = [];
    for (const f of files) {
        for (const v of lintFile(f, pipelineRoot, allowlist)) {
            violations.push(v);
        }
    }
    return { scanned: files.length, violations };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function formatViolation(v) {
    return `LINT ERROR: ${v.file}:${v.line} usa fs.readdirSync sin isMarkerArtifact\n    snippet: ${v.snippet}\n    reason: ${v.reason}`;
}

function main() {
    const logger = defaultLogger();
    const argv = process.argv.slice(2);
    const checkMode = argv.includes('--check') || argv.length === 0;
    if (!checkMode) {
        logger.error('uso: node ghost-artifact-lint.js [--check]');
        process.exit(2);
    }
    try {
        const { scanned, violations } = lint();
        if (violations.length === 0) {
            logger.info(`OK — ${scanned} archivos JS escaneados, 0 violations`);
            process.exit(0);
        }
        logger.error(`${violations.length} violation(s) en ${scanned} archivos:`);
        for (const v of violations) {
            console.error(formatViolation(v));
        }
        console.error('');
        console.error('Para resolver:');
        console.error('  1) Importar `isMarkerArtifact` de `lib/marker-artifact.js` en el archivo afectado.');
        console.error('  2) Aplicar el filtro al resultado del readdir, ej:');
        console.error('     fs.readdirSync(dir).filter(f => !f.startsWith(".") && !isMarkerArtifact(f))');
        console.error('  3) Si el caso es legítimo (path no operacional), agregar entry en');
        console.error('     `.pipeline/lib/ghost-artifact-lint.allowlist.json` con justificación.');
        process.exit(1);
    } catch (e) {
        logger.error(`fatal: ${e.message}`);
        process.exit(2);
    }
}

if (require.main === module) main();

module.exports = {
    lint,
    // exposed for tests
    _internal: { walkJs, lintFile, loadAllowlist, looksLikeOpsPath, hasFilterNearby, READDIR_RE, SELF_EXEMPT, SKIP_DIRS },
};
