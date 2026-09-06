#!/usr/bin/env node
// =============================================================================
// report-prose-deps.js — #6902 CA-6
//
// Barrido de markers históricos: recorre los issues ABIERTOS con
// `blocked:dependencies` y reporta cuáles tienen referencias que provienen de
// la PROSA del marker en vez de estar declaradas como item de lista.
//
// Antes de #6902 esas referencias entraban como dependencias duras. Después del
// fix ya no cuentan — pero eso significa que un marker histórico puede haber
// estado bloqueado por una dependencia que hoy desaparece, o que un autor quiso
// declarar algo de verdad y lo escribió en prosa. Las dos situaciones necesitan
// ojo humano, así que este script SÓLO LEE Y LISTA: no edita issues, no toca
// labels, no reposta markers.
//
// Uso:
//   node .pipeline/scripts/report-prose-deps.js
//   node .pipeline/scripts/report-prose-deps.js --json
//   node .pipeline/scripts/report-prose-deps.js --limit 100
//
// Salida por defecto: texto legible con el issue, cada referencia sospechosa y
// la línea donde apareció (pedido explícito del UX: un listado de números
// pelados obliga a reabrir cada marker a mano y el reporte deja de usarse).
// =============================================================================

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const {
    extractDependencyBlock,
    parseDependencyCommentDetailed,
    analyzeDependencyBlock,
} = require(path.join(__dirname, '..', 'lib', 'dep-comment-parser'));

const GH_BIN = process.env.GH_BIN
    || (process.platform === 'win32' ? 'C:\\Workspaces\\gh-cli\\bin\\gh.exe' : 'gh');

const LABEL = 'blocked:dependencies';

function parseArgs(argv) {
    const out = { json: false, limit: 100 };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--json') out.json = true;
        else if (argv[i] === '--limit') {
            const n = parseInt(argv[i + 1], 10);
            if (Number.isFinite(n) && n > 0) out.limit = Math.min(n, 500);
            i++;
        }
    }
    return out;
}

function gh(args, timeout = 30000) {
    return execFileSync(GH_BIN, args, { encoding: 'utf8', timeout, windowsHide: true });
}

function listBlockedIssues(limit) {
    const raw = gh(['issue', 'list', '--label', LABEL, '--state', 'open',
        '--json', 'number,title', '--limit', String(limit)]);
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
}

function fetchIssue(number) {
    const raw = gh(['issue', 'view', String(number), '--json', 'body,comments'], 20000);
    const parsed = JSON.parse(raw || '{}');
    return {
        body: typeof parsed.body === 'string' ? parsed.body : '',
        comments: Array.isArray(parsed.comments) ? parsed.comments : [],
    };
}

/**
 * Referencias sospechosas de un issue: las del marker canónico (comentario más
 * reciente) más las del bloque escrito directamente en el body.
 */
function inspect(issue, data) {
    const hallazgos = [];

    const detalle = parseDependencyCommentDetailed(data.comments, issue.number);
    for (const entry of (detalle.ignored || [])) {
        hallazgos.push({ fuente: 'comment', ...entry });
    }

    const bodyBlock = extractDependencyBlock(data.body);
    if (bodyBlock !== null) {
        const analisis = analyzeDependencyBlock(bodyBlock, issue.number);
        for (const entry of analisis.ignored) hallazgos.push({ fuente: 'body', ...entry });
    }

    return {
        issue: issue.number,
        title: issue.title || '',
        deps: detalle.deps === null ? null : detalle.deps,
        hallazgos,
    };
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    let issues;
    try {
        issues = listBlockedIssues(args.limit);
    } catch (e) {
        console.error(`No se pudo listar issues con ${LABEL}: ${e.message}`);
        console.error('Verificá el gh CLI: export PATH="/c/Workspaces/gh-cli/bin:$PATH"');
        process.exit(1);
    }

    const resultados = [];
    const errores = [];
    for (const issue of issues) {
        try {
            resultados.push(inspect(issue, fetchIssue(issue.number)));
        } catch (e) {
            errores.push({ issue: issue.number, error: e.message });
        }
    }

    const contaminados = resultados.filter((r) => r.hallazgos.length > 0);

    if (args.json) {
        console.log(JSON.stringify({
            generado: new Date().toISOString(),
            revisados: resultados.length,
            contaminados: contaminados.length,
            issues: contaminados,
            errores,
        }, null, 2));
        return;
    }

    console.log('# Markers con dependencias provenientes de prosa (#6902 CA-6)');
    console.log('');
    console.log(`Issues abiertos con \`${LABEL}\` revisados: ${resultados.length}`);
    console.log(`Con referencias en prosa: ${contaminados.length}`);
    console.log('');

    if (contaminados.length === 0) {
        console.log('Ningún marker declara dependencias en prosa. Nada que revisar.');
    }

    for (const r of contaminados) {
        console.log(`## #${r.issue} — ${r.title}`);
        console.log('');
        console.log(`Dependencias declaradas: ${r.deps === null ? '(sin marker canónico)' : (r.deps.length ? r.deps.map((n) => '#' + n).join(', ') : '(ninguna)')}`);
        console.log('');
        for (const h of r.hallazgos) {
            console.log(`- ${h.numbers.map((n) => '#' + n).join(', ')} — en ${h.fuente}, línea ${h.lineNo + 1} del bloque:`);
            console.log(`  > ${h.line}`);
        }
        console.log('');
    }

    if (errores.length > 0) {
        console.log('## Issues no legibles');
        console.log('');
        for (const e of errores) console.log(`- #${e.issue}: ${e.error}`);
        console.log('');
    }

    console.log('---');
    console.log('');
    console.log('Estas referencias NO se toman como dependencia desde #6902. Si alguna era real,');
    console.log('reposteá el marker declarándola como bullet (`- #N — motivo`) y dejando la prosa');
    console.log('detrás de una línea `---`: gana el comentario más reciente.');
    console.log('');
    console.log('Este reporte no corrige nada por su cuenta — es para revisión humana.');
}

if (require.main === module) main();

module.exports = { inspect, parseArgs };
