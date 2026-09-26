// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
// =============================================================================
// #7633 — Único módulo con I/O de git y gh del export de autoría.
//
// Reglas (SE1 · SE6 · D-A2):
//   - Siempre `execFile` con array de argumentos: nunca shell ni string armado.
//   - El rango llega YA validado por el CLI, y además va después de
//     `--end-of-options`: git nunca lo interpreta como opción.
//   - Ante un error se devuelve SÓLO un `publicMessage` genérico. El stderr de
//     git/gh (que puede traer paths del host, usuarios o una URL con token) va
//     al log local del pipeline, nunca al valor de retorno ni al HTML.
//   - No lee `approval-channel.jsonl` ni ningún otro estado del host.
// =============================================================================

const childProcess = require('child_process');

const REPO = 'intrale/platform';
const TIMEOUT_MS = 60000;
const MAX_BUFFER = 64 * 1024 * 1024;
const LOG_DESTINO = 'logs/authorship-export.log';

// Separadores de `git log`: NUL entre campos, RS (0x1e) entre commits.
const LOG_FORMAT = '--format=%H%x00%cI%x00%B%x1e';

function defaultExecFile(cmd, args, opts = {}) {
    return childProcess.execFileSync(cmd, args, {
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...opts,
    });
}

/**
 * Registra el detalle de un fallo en el log local. Nunca lanza. Si el destino
 * no se puede resolver (ambiente sin declarar), `write-target` ya avisó por
 * stderr y el detalle se descarta: jamás termina en el export.
 */
function defaultLog(line) {
    try {
        const fs = require('fs');
        const path = require('path');
        const file = require('../write-target').safeWritePath(process.env,
            { canal: 'logs', destino: LOG_DESTINO }, 'logs', 'authorship-export.log');
        if (!file) return;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch { /* el log es best-effort */ }
}

function errorDetail(err) {
    if (!err) return 'error desconocido';
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    return `${err.message || err}${stderr ? ` | stderr: ${stderr}` : ''}`;
}

/**
 * @param {{execFileImpl?: Function, log?: Function, cwd?: string}} [deps]
 */
function createGitSource({ execFileImpl = defaultExecFile, log = defaultLog, cwd } = {}) {
    const run = (cmd, args) => execFileImpl(cmd, args, cwd ? { cwd } : {});

    function fail(publicMessage, err, context) {
        log(`[authorship-export] ${context}: ${errorDetail(err)}`);
        return { ok: false, publicMessage };
    }

    /** true si `ref` es un nombre de ref válido para git (incluye `HEAD`). */
    function checkRefFormat(ref) {
        if (typeof ref !== 'string' || !ref || ref.startsWith('-')) return false;
        try {
            run('git', ['check-ref-format', '--allow-onelevel', ref]);
            return true;
        } catch { return false; }
    }

    /**
     * @param {string} revs — rango `a..b` ya validado, o un SHA suelto.
     * @param {{single?: boolean}} [opts]
     * @returns {{ok:true, commits:Array<{sha,date,message}>}|{ok:false, publicMessage:string}}
     */
    function readCommits(revs, { single = false } = {}) {
        const args = ['log', LOG_FORMAT];
        if (single) args.push('-1');
        args.push('--end-of-options', revs);
        let out;
        try { out = run('git', args); } catch (e) {
            return fail('no se pudieron leer los cambios pedidos de la rama principal (¿falta un git fetch?)', e, 'git log');
        }
        const commits = String(out).split('\x1e')
            .map((chunk) => chunk.replace(/^\r?\n/, ''))
            .filter((chunk) => chunk.trim())
            .map((chunk) => {
                const [sha, date, ...rest] = chunk.split('\x00');
                return { sha: String(sha || '').trim(), date: String(date || '').trim(), message: rest.join('\x00') };
            });
        return { ok: true, commits };
    }

    /**
     * @returns {{ok:true, sha:string, title:string}|{ok:false, publicMessage:string}}
     */
    function readPrMergeCommit(pr) {
        let data;
        try {
            data = JSON.parse(run('gh', ['pr', 'view', String(pr), '--repo', REPO, '--json', 'mergeCommit,title,number,state']));
        } catch (e) {
            return fail(`no se pudo obtener el Pull Request #${pr}`, e, `gh pr view ${pr}`);
        }
        const sha = data && data.mergeCommit && data.mergeCommit.oid;
        if (!data || data.state !== 'MERGED' || typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
            return { ok: false, publicMessage: `el Pull Request #${pr} no está integrado a la rama principal: no hay constancia que generar` };
        }
        return { ok: true, sha, title: typeof data.title === 'string' ? data.title : '' };
    }

    /**
     * @returns {{ok:true, title:string}|{ok:false, publicMessage:string}}
     */
    function readIssueTitle(n) {
        try {
            const data = JSON.parse(run('gh', ['issue', 'view', String(n), '--repo', REPO, '--json', 'title']));
            if (data && typeof data.title === 'string') return { ok: true, title: data.title };
            return fail(`no se pudo obtener el título de #${n}`, new Error('respuesta sin título'), `gh issue view ${n}`);
        } catch (e) {
            return fail(`no se pudo obtener el título de #${n}`, e, `gh issue view ${n}`);
        }
    }

    /** Raíz del repo desde el que se exporta ('' si no se puede resolver). */
    function repoRoot() {
        try { return String(run('git', ['rev-parse', '--show-toplevel'])).trim(); } catch (e) {
            fail('', e, 'git rev-parse');
            return '';
        }
    }

    return { checkRefFormat, readCommits, readPrMergeCommit, readIssueTitle, repoRoot };
}

module.exports = { createGitSource, defaultLog, LOG_FORMAT, LOG_DESTINO };
