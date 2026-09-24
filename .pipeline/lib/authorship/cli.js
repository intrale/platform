#!/usr/bin/env node
'use strict';
// =============================================================================
// #7633 — CLI de autoría. Subcomando `export` (CA-6 · SE1 · SE5).
//
//   node .pipeline/lib/authorship/cli.js export --pr <N> [--pdf] [--out <dir>]
//   node .pipeline/lib/authorship/cli.js export --range <a>..<b> [--pdf] [--out <dir>]
//
// Seguridad:
//   - `--pr` sólo enteros positivos. Cada extremo de `--range` es un SHA
//     (7-40 hex) o un ref que pasa `git check-ref-format`, y nunca empieza con
//     `-`. Se valida ANTES de invocar git (`--range --output=x..HEAD` no llega).
//   - La salida va por default a `.pipeline/tmp/authorship-export/` del repo
//     (ignorado por git; el repo es público). `--out` se resuelve con
//     `path.resolve` y tiene que quedar DENTRO de ese directorio; un symlink se
//     rechaza.
//   - No envía nada a Telegram ni a Drive: sólo escribe archivos locales.
// =============================================================================

const fs = require('fs');
const path = require('path');

const exportChainLib = require('./export-chain');
const { createGitSource, defaultLog } = require('./git-source');

const MAX_COMMITS = 200;
const SHA = /^[0-9a-f]{7,40}$/;
const USAGE = [
    'Uso:',
    '  node .pipeline/lib/authorship/cli.js export --pr <N> [--pdf] [--out <dir>]',
    '  node .pipeline/lib/authorship/cli.js export --range <a>..<b> [--pdf] [--out <dir>]',
    '',
    'Genera la constancia de dirección humana (HTML y, con --pdf, PDF) en',
    '.pipeline/tmp/authorship-export/ (o en un subdirectorio de ahí con --out).',
].join('\n');

// -----------------------------------------------------------------------------
// Parseo y validación (puros)
// -----------------------------------------------------------------------------

function validateEnd(e, checkRefFormat) {
    if (typeof e !== 'string' || !e || e.startsWith('-')) return false;
    return SHA.test(e) || checkRefFormat(e) === true;
}

/**
 * @param {string} r — `a..b`
 * @param {{checkRefFormat: (ref:string) => boolean}} deps
 * @returns {{ok:boolean}}
 */
function validateRange(r, deps) {
    if (typeof r !== 'string' || !r || r.startsWith('-')) return { ok: false };
    const parts = r.split('..');
    if (parts.length !== 2) return { ok: false };
    // Los extremos se validan sin tocar git primero; recién si ninguno empieza
    // con '-' se consulta check-ref-format.
    if (parts.some((p) => !p || p.startsWith('-'))) return { ok: false };
    return { ok: parts.every((p) => validateEnd(p, deps.checkRefFormat)) };
}

function parsePr(v) {
    if (typeof v !== 'string' || !/^[0-9]{1,9}$/.test(v)) return null;
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * @param {string[]} argv — argumentos DESPUÉS de `export`.
 * @returns {{ok:true, opts:{pr?:number, range?:string, pdf:boolean, out:string|null}}|{ok:false, error:string}}
 */
function parseExportArgs(argv) {
    const opts = { pdf: false, out: null };
    const args = Array.isArray(argv) ? argv.slice() : [];
    const takeValue = (flag, inline, i) => {
        if (inline !== undefined) return { value: inline, next: i };
        if (i + 1 >= args.length) return { error: `falta el valor de ${flag}` };
        return { value: args[i + 1], next: i + 1 };
    };
    for (let i = 0; i < args.length; i++) {
        const raw = String(args[i]);
        const eq = raw.indexOf('=');
        const flag = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw;
        const inline = raw.startsWith('--') && eq > 0 ? raw.slice(eq + 1) : undefined;
        if (flag === '--pdf' && inline === undefined) { opts.pdf = true; continue; }
        if (flag === '--pr' || flag === '--range' || flag === '--out') {
            const t = takeValue(flag, inline, i);
            if (t.error) return { ok: false, error: t.error };
            i = t.next;
            if (flag === '--pr') {
                const n = parsePr(t.value);
                if (n === null) return { ok: false, error: '--pr tiene que ser un número entero positivo' };
                opts.pr = n;
            } else if (flag === '--range') {
                opts.range = String(t.value);
            } else {
                opts.out = String(t.value);
            }
            continue;
        }
        return { ok: false, error: `argumento desconocido: ${raw.slice(0, 40)}` };
    }
    if ((opts.pr !== undefined) === (opts.range !== undefined)) {
        return { ok: false, error: 'hay que indicar exactamente uno: --pr <N> o --range <a>..<b>' };
    }
    return { ok: true, opts };
}

function samePathOrInside(target, allowed) {
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const t = norm(target);
    const a = norm(allowed);
    return t === a || t.startsWith(a + path.sep);
}

function isSymlink(p, fsImpl) {
    try { return fsImpl.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/**
 * Resuelve el directorio de salida (SE5).
 * @returns {{ok:true, dir:string}|{ok:false, error:string}}
 */
function resolveOutDir(out, repoRoot, fsImpl = fs) {
    const allowed = path.resolve(repoRoot, '.pipeline', 'tmp', 'authorship-export');
    const target = out ? path.resolve(out) : allowed;
    if (!samePathOrInside(target, allowed)) {
        return { ok: false, error: 'el destino de --out tiene que quedar dentro de .pipeline/tmp/authorship-export/' };
    }
    // Ningún tramo entre `.pipeline/tmp` y el destino puede ser un symlink.
    let cur = target;
    const stop = path.dirname(path.resolve(repoRoot, '.pipeline', 'tmp'));
    while (samePathOrInside(cur, stop) && cur !== stop) {
        if (isSymlink(cur, fsImpl)) return { ok: false, error: 'el destino de la constancia no puede ser un enlace simbólico' };
        cur = path.dirname(cur);
    }
    return { ok: true, dir: target };
}

// La config se lee por la autoridad única (`lib/config-resolver`), nunca con un
// parseo propio del yaml. Sin config legible ⇒ null (todo commit sin bloque sale
// como "modo de prueba": nunca se inventa una vigencia).
function readGoLiveDate(repoRoot, resolveImpl) {
    try {
        const resolve = resolveImpl || require('../config-resolver').resolve;
        const cfg = resolve({ pipelineDir: path.join(repoRoot, '.pipeline') });
        const v = cfg && cfg.authorship && cfg.authorship.go_live_date;
        return typeof v === 'string' ? v : null;
    } catch { return null; }
}

function fileSlug(scope) {
    const base = scope.pr ? `pr-${scope.pr}` : `rango-${scope.range.replace('..', '-a-')}`;
    return base.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100);
}

function stamp(now) {
    return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// -----------------------------------------------------------------------------
// Ejecución
// -----------------------------------------------------------------------------

/**
 * @param {{pr?:number, range?:string, pdf?:boolean, out?:string|null}} opts
 * @param {{source?:object, fs?:object, now?:Date, renderPdf?:Function, repoRoot?:string, goLiveDate?:string|null}} [deps]
 * @returns {Promise<{ok:true, htmlPath:string, pdfPath:string|null, signed:number, total:number}|{ok:false, error:string}>}
 */
async function runExport(opts, deps = {}) {
    const source = deps.source || createGitSource();
    const fsImpl = deps.fs || fs;
    const now = deps.now || new Date();

    let scope;
    if (opts.range !== undefined) {
        if (!validateRange(opts.range, { checkRefFormat: source.checkRefFormat }).ok) {
            return { ok: false, error: 'rango inválido: se espera <a>..<b> con SHA o nombres de rama válidos' };
        }
        scope = { range: opts.range };
    } else {
        if (!Number.isSafeInteger(opts.pr) || opts.pr <= 0) return { ok: false, error: '--pr tiene que ser un número entero positivo' };
        scope = { pr: opts.pr };
    }

    const repoRoot = deps.repoRoot || source.repoRoot();
    if (!repoRoot) return { ok: false, error: 'no se pudo ubicar el repositorio: ejecutá el comando dentro del repo' };
    const outDir = resolveOutDir(opts.out, repoRoot, fsImpl);
    if (!outDir.ok) return outDir;

    let commits;
    if (scope.pr) {
        const pr = source.readPrMergeCommit(scope.pr);
        if (!pr.ok) return { ok: false, error: pr.publicMessage };
        const read = source.readCommits(pr.sha, { single: true });
        if (!read.ok) return { ok: false, error: read.publicMessage };
        commits = read.commits;
    } else {
        const read = source.readCommits(scope.range);
        if (!read.ok) return { ok: false, error: read.publicMessage };
        commits = read.commits;
    }
    if (commits.length > MAX_COMMITS) {
        return { ok: false, error: `el rango tiene ${commits.length} cambios; el máximo por constancia es ${MAX_COMMITS}` };
    }

    const titles = {};
    for (const n of exportChainLib.issuesOf(commits)) titles[n] = source.readIssueTitle(n);

    const goLiveDate = deps.goLiveDate !== undefined ? deps.goLiveDate : readGoLiveDate(repoRoot, deps.resolveConfig);
    const model = exportChainLib.buildChainModel({ scope, commits, titles, goLiveDate, now });
    const html = exportChainLib.renderChainHtml(model);

    fsImpl.mkdirSync(outDir.dir, { recursive: true });
    const htmlPath = path.join(outDir.dir, `constancia-autoria-${fileSlug(scope)}-${stamp(now)}.html`);
    fsImpl.writeFileSync(htmlPath, html, 'utf8');

    let pdfPath = null;
    if (opts.pdf) {
        const strict = require('../pdf-render-strict');
        const available = deps.isPuppeteerAvailable || strict.isPuppeteerAvailable;
        if (!deps.renderPdf && !available()) {
            return {
                ok: false,
                htmlPath,
                error: 'no está instalado el puppeteer de docs/qa/node_modules: se generó sólo el HTML (se puede imprimir a PDF desde el navegador)',
            };
        }
        const renderPdf = deps.renderPdf || strict.renderPdfStrict;
        pdfPath = await renderPdf(htmlPath, {
            outPath: htmlPath.replace(/\.html$/, '.pdf'),
            title: `Intrale · Constancia de autoría — ${exportChainLib.scopeTitle(model.scope)}`,
        });
    }
    return { ok: true, htmlPath, pdfPath, signed: model.count.signed, total: model.count.total };
}

async function main(argv = process.argv.slice(2), io = { out: process.stdout, err: process.stderr }) {
    const [cmd, ...rest] = argv;
    if (cmd !== 'export') {
        io.err.write(`${USAGE}\n`);
        return 2;
    }
    const parsed = parseExportArgs(rest);
    if (!parsed.ok) {
        io.err.write(`Error: ${parsed.error}\n\n${USAGE}\n`);
        return 2;
    }
    let res;
    try {
        res = await runExport(parsed.opts);
    } catch (e) {
        // El detalle puede traer paths del host: no se imprime entero.
        defaultLog(`[authorship-export] error inesperado: ${e && e.stack ? e.stack : e}`);
        io.err.write('Error: no se pudo generar la constancia (detalle en .pipeline/logs/authorship-export.log)\n');
        return 1;
    }
    if (!res.ok) {
        if (res.htmlPath) io.out.write(`HTML: ${res.htmlPath}\n`);
        io.err.write(`Error: ${res.error}\n`);
        return 1;
    }
    io.out.write(`Constancia generada: ${res.signed} de ${res.total} cambios con firma.\n`);
    io.out.write(`HTML: ${res.htmlPath}\n`);
    if (res.pdfPath) io.out.write(`PDF:  ${res.pdfPath}\n`);
    return 0;
}

if (require.main === module) {
    main().then((code) => { process.exitCode = code; });
}

module.exports = {
    MAX_COMMITS,
    parseExportArgs,
    validateRange,
    resolveOutDir,
    readGoLiveDate,
    runExport,
    main,
};
