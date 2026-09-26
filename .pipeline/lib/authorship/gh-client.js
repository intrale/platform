'use strict';
// =============================================================================
// #7632 — Adaptador mínimo de `gh` para el verificador de CI (RS-2 · RS-6).
//
// - Siempre `execFile('gh', [...args], { shell: false })`: nunca un string de
//   comando. El número se valida con `^\d{1,7}$` ANTES de invocar; si no
//   matchea, lanza sin llamar a `gh`.
// - 404 del issue → `not_found` (hallazgo). Cualquier otra cosa (403, rate
//   limit, red, JSON ilegible) → `error` (no se pudo verificar).
// - `GH_TOKEN` lo lee `gh` del entorno heredado; este módulo nunca lo imprime.
// =============================================================================

const childProcess = require('node:child_process');

const NUMBER = /^\d{1,7}$/;
const NOT_FOUND = /Could not resolve to an? (Issue|PullRequest)|HTTP 404/i;
const TIMEOUT_MS = 60 * 1000;
const MAX_BUFFER = 8 * 1024 * 1024;

function assertNumber(n) {
    const s = String(n == null ? '' : n);
    if (!NUMBER.test(s)) throw new Error('[authorship] número inválido: no se consulta a GitHub');
    return s;
}

function createGhClient({ execFileImpl = childProcess.execFile, env = process.env } = {}) {
    function run(args) {
        return new Promise((resolve) => {
            try {
                execFileImpl('gh', args, {
                    shell: false,
                    env,
                    timeout: TIMEOUT_MS,
                    maxBuffer: MAX_BUFFER,
                    windowsHide: true,
                }, (err, stdout, stderr) => {
                    resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
                });
            } catch (e) {
                resolve({ ok: false, stdout: '', stderr: String(e && e.message || '') });
            }
        });
    }

    /** @returns {Promise<'exists'|'not_found'|'error'>} */
    async function issueExists(n) {
        const num = assertNumber(n);
        const res = await run(['issue', 'view', num, '--json', 'number']);
        if (!res.ok) return NOT_FOUND.test(res.stderr) ? 'not_found' : 'error';
        try {
            const parsed = JSON.parse(res.stdout);
            return parsed && Number(parsed.number) === Number(num) ? 'exists' : 'error';
        } catch { return 'error'; }
    }

    /**
     * @returns {Promise<{ok:true, body:string, headRefName:string, commits:string[]}|{ok:false}>}
     *          `commits` = mensajes completos (título + cuerpo) en el orden de GitHub.
     */
    async function prView(n) {
        const num = assertNumber(n);
        const res = await run(['pr', 'view', num, '--json', 'body,headRefName,commits']);
        if (!res.ok) return { ok: false };
        try {
            const parsed = JSON.parse(res.stdout);
            if (!parsed || typeof parsed !== 'object') return { ok: false };
            const commits = (Array.isArray(parsed.commits) ? parsed.commits : []).map((c) => {
                const head = c && typeof c.messageHeadline === 'string' ? c.messageHeadline : '';
                const body = c && typeof c.messageBody === 'string' ? c.messageBody : '';
                return body ? `${head}\n\n${body}` : head;
            });
            return {
                ok: true,
                body: typeof parsed.body === 'string' ? parsed.body : '',
                headRefName: typeof parsed.headRefName === 'string' ? parsed.headRefName : '',
                commits,
            };
        } catch { return { ok: false }; }
    }

    return { issueExists, prView };
}

module.exports = { createGhClient, NUMBER };
