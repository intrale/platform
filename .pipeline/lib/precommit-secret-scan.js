#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { sanitize } = require('../sanitizer');
const { SENSITIVE_PATHS, clasificarPath } = require('./sensitive-paths');

const SENSITIVE_PATTERNS = SENSITIVE_PATHS
    .filter((entry) => entry.escaneaContenido)
    .map((entry) => ({ name: entry.id, test: entry.test }));

class GitOperationError extends Error {
    constructor(operation, status, detail) {
        super(`Git falló durante ${operation} (código ${status == null ? 'sin estado' : status})${detail ? `: ${detail}` : ''}`);
        this.name = 'GitOperationError';
        this.operation = operation;
        this.status = status;
    }
}

function runGit(args, options = {}) {
    const result = spawnSync('git', args, {
        cwd: options.cwd,
        encoding: options.encoding === undefined ? null : options.encoding,
        maxBuffer: 50 * 1024 * 1024,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) {
        const detail = result.error ? result.error.message : String(result.stderr || '').trim();
        throw new GitOperationError(options.operation || args.join(' '), result.status, detail);
    }
    return result.stdout;
}

function normalizePath(value) {
    return String(value || '').replace(/\\/g, '/');
}

function parseNameStatusZ(output) {
    const fields = (Buffer.isBuffer(output) ? output.toString('utf8') : String(output)).split('\0');
    if (fields[fields.length - 1] === '') fields.pop();
    const changes = [];
    for (let index = 0; index < fields.length;) {
        const status = fields[index++];
        if (!/^[ACMR][0-9]*$/.test(status)) {
            throw new GitOperationError('interpretar git diff --name-status -z', null, `estado inesperado ${JSON.stringify(status)}`);
        }
        const count = /^[CR]/.test(status) ? 2 : 1;
        if (index + count > fields.length) {
            throw new GitOperationError('interpretar git diff --name-status -z', null, 'salida truncada');
        }
        changes.push({ status, paths: fields.slice(index, index + count).map(normalizePath) });
        index += count;
    }
    return changes;
}

function listChanges(options = {}) {
    const args = options.mode === 'range'
        ? ['diff', '--name-status', '-z', '--diff-filter=ACMR', '-M', '-C', '--find-copies-harder', options.base, options.head, '--']
        : ['diff', '--cached', '--name-status', '-z', '--diff-filter=ACMR', '-M', '-C', '--'];
    if (options.mode === 'range' && (!options.base || !options.head)) throw new Error('El modo --range requiere BASE y HEAD');
    const runner = options.git || runGit;
    return parseNameStatusZ(runner(args, { cwd: options.cwd, operation: 'enumerar paths del diff' }));
}

function isSensitive(stagedPath) {
    for (const pattern of SENSITIVE_PATTERNS) if (pattern.test(stagedPath)) return pattern.name;
    return null;
}

function countRedactions(text) {
    const tally = {};
    for (const match of text.match(/\[REDACTED:[A-Z_]+\]/g) || []) tally[match] = (tally[match] || 0) + 1;
    return tally;
}

function readStagedContent(stagedPath, options = {}) {
    const runner = options.git || runGit;
    return runner(['show', `:0:${stagedPath}`], {
        cwd: options.cwd,
        encoding: 'utf8',
        operation: `leer contenido staged de ${JSON.stringify(stagedPath)}`,
    });
}

function collectFindings(options = {}) {
    const paths = [...new Set(listChanges(options).flatMap((change) => change.paths))];
    const findings = [];
    for (const rel of paths) {
        const classification = clasificarPath(rel);
        if (classification && classification.requiereIgnore) {
            findings.push({ path: rel, ...classification, stagedSensitive: true });
            continue;
        }
        if (options.mode === 'range') continue;
        const kind = isSensitive(rel);
        if (!kind) continue;
        const content = readStagedContent(rel, options);
        const normalized = content.replace(/\r\n/g, '\n');
        let sanitized;
        try {
            sanitized = sanitize(normalized);
        } catch (error) {
            findings.push({ path: rel, id: kind, error: error.message || 'desconocido' });
            continue;
        }
        if (sanitized !== normalized) findings.push({ path: rel, id: kind, redactions: countRedactions(sanitized) });
    }
    return findings;
}

function formatFindings(findings) {
    const lines = ['Guardrail bloqueado: paths sensibles en el cambio.'];
    for (const finding of findings) {
        lines.push(`- path=${JSON.stringify(finding.path)} regla=${finding.id} clase=${finding.clase || 'credencial'}`);
        if (finding.stagedSensitive) lines.push('  causa=path del inventario que debe permanecer ignorado');
        else if (finding.error) lines.push(`  causa=falló el sanitizer (${finding.error})`);
        else lines.push(`  patrones=${Object.keys(finding.redactions || {}).join(',')}`);
    }
    lines.push('Remediación: quite cada path del índice y verifique la regla en .pipeline/lib/sensitive-paths.js y .gitignore.');
    return lines.join('\n') + '\n';
}

function parseArgs(argv) {
    if (argv.length === 0 || (argv.length === 1 && argv[0] === '--staged')) return { mode: 'staged' };
    if (argv[0] === '--range' && argv.length === 3) return { mode: 'range', base: argv[1], head: argv[2] };
    throw new Error('Uso: precommit-secret-scan.js --staged | --range BASE HEAD');
}

function main(argv = process.argv.slice(2), options = {}) {
    try {
        const findings = collectFindings({ ...parseArgs(argv), ...options });
        if (findings.length === 0) return 0;
        process.stderr.write(formatFindings(findings));
        return 1;
    } catch (error) {
        const operation = error instanceof GitOperationError ? ` operación=${error.operation}` : '';
        process.stderr.write(`Guardrail bloqueado por fallo técnico de Git:${operation} detalle=${error.message}\n`);
        return 2;
    }
}

if (require.main === module) process.exit(main());

module.exports = {
    SENSITIVE_PATTERNS,
    GitOperationError,
    isSensitive,
    countRedactions,
    collectFindings,
    formatFindings,
    main,
    __forTestsOnly__: { runGit, parseNameStatusZ, listChanges, readStagedContent, parseArgs },
};
