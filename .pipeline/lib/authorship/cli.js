#!/usr/bin/env node
'use strict';
// =============================================================================
// #7632 — CLI de autoría. Dispatcher `node cli.js <subcomando>`.
//
// Subcomandos:
//   verify --pr <N> [--config <path>]
//   verify --commit <SHA> --informative [--config <path>]
//   export --pr <N> | --range <a>..<b> [--pdf] [--out <dir>]   (#7633)
//
// Corre en GitHub Actions desde el checkout de `base_ref` (S4) bajo un
// sparse-checkout acotado: sólo built-ins de Node y módulos relativos listados
// en `pr-checks.yml`. Es el ÚNICO archivo que hace I/O (gh, git, fs, stdout);
// `verify.js`, `ci-mode.js` y `annotations.js` son puros.
//
// `export` (#7633) vive en `export-cli.js` y se carga en forma diferida con un
// path calculado: sus dependencias (git-source, config-resolver,
// pdf-render-strict) quedan FUERA del cierre de require que exige
// authorship-ci-packaging.test.js y del sparse-checkout de CI, que nunca
// ejecuta `export`.
// =============================================================================

const childProcess = require('node:child_process');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const verify = require('./verify');
const ciMode = require('./ci-mode');
const annotations = require('./annotations');
const { createGhClient } = require('./gh-client');

const SHA = /^[0-9a-f]{7,40}$/i;
const PR = /^\d{1,7}$/;

const HELP = `Uso:
  node .pipeline/lib/authorship/cli.js verify --pr <N> [--config <path>]
  node .pipeline/lib/authorship/cli.js verify --commit <SHA> --informative [--config <path>]
  node .pipeline/lib/authorship/cli.js export --pr <N> [--pdf] [--out <dir>]
  node .pipeline/lib/authorship/cli.js export --range <a>..<b> [--pdf] [--out <dir>]

verify --pr <N>
  Verifica que el mensaje de squash PROPUESTO de un PR agent/* traiga el
  bloque de autoría completo y consistente:
    1. hay bloque de trailers y es el último párrafo;
    2. los campos Intrale-* tienen formato válido;
    3. no hay claves Intrale-* duplicadas ni fuera del bloque;
    4. el issue de Intrale-Issue existe (consulta a GitHub con gh);
    5. el bloque authorship-anchor del body del PR coincide con el trailer.

  Mensaje propuesto (D-A): GitHub no expone el mensaje final antes del merge.
  Se reconstruye con la misma función que usa delivery
  (commit-builder.buildSquashMessage) a partir de las líneas Intrale-* del
  bloque <!-- authorship-anchor --> del body del PR y de los mensajes de los
  commits de la rama. Un merge manual que no pase por delivery lo cubre la
  auditoría de main (authorship-main-audit.yml).

  Modo (D-B): se lee del bloque "authorship:" del config.yaml indicado con
  --config (en CI, el de la rama base; nunca de labels ni archivos del PR).
    bloque ausente                       -> dry-run
    enabled: false  |  gate_mode: off    -> desactivado (notice, exit 0)
    gate_mode: dry-run (o sin gate_mode) -> dry-run (warning, exit 0)
    gate_mode: enforce                   -> enforce (error, exit 1)
    otro valor o bloque mal formado      -> enforce

verify --commit <SHA> --informative
  Misma validación sobre un commit ya integrado. Siempre sale con 0: sólo
  emite un warning por commit. Omite los commits anteriores a go_live_date.

export --pr <N> | --range <a>..<b> [--pdf] [--out <dir>]
  Genera la constancia de dirección humana (HTML y, con --pdf, PDF) en
  .pipeline/tmp/authorship-export/ (o en un subdirectorio de ahí con --out).
  Ver docs/legal/autoria.md.

Alcance: este check verifica CONSISTENCIA, NO AUTENTICIDAD. El trailer es texto
que el autor del PR puede escribir; un verde no es prueba de autoría y no debe
usarse como gate de confianza en ningún otro lado.
`;

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--informative') out.informative = true;
        else if (a === '--pr' || a === '--commit' || a === '--config') out[a.slice(2)] = argv[++i];
        else out._.push(a);
    }
    return out;
}

function readConfigText(fsImpl, configPath) {
    try { return fsImpl.readFileSync(configPath, 'utf8'); } catch { return null; }
}

function resolveModeSafe(fsImpl, configPath) {
    try {
        const block = ciMode.readAuthorshipBlock(readConfigText(fsImpl, configPath));
        return { mode: ciMode.resolveCiMode(block), block };
    } catch {
        return { mode: 'enforce', block: { malformed: true } };
    }
}

function writeSummary(fsImpl, env, text) {
    const file = env && env.GITHUB_STEP_SUMMARY;
    if (!file) return;
    try { fsImpl.appendFileSync(file, text); } catch { /* el summary es presentación */ }
}

function gitCommit(execFileImpl, sha) {
    return new Promise((resolve) => {
        try {
            execFileImpl('git', ['log', '-1', '--format=%cI%n%B', sha], {
                shell: false, timeout: 30 * 1000, maxBuffer: 1024 * 1024, windowsHide: true,
            }, (err, stdout) => {
                if (err) return resolve(null);
                const text = String(stdout || '');
                const nl = text.indexOf('\n');
                resolve(nl === -1 ? { date: text.trim(), message: '' } : { date: text.slice(0, nl).trim(), message: text.slice(nl + 1) });
            });
        } catch { resolve(null); }
    });
}

async function verifyPr({ args, ghClient, fsImpl, out, env }) {
    const { mode } = resolveModeSafe(fsImpl, args.config || '.pipeline/config.yaml');
    if (mode === 'disabled') {
        out(annotations.formatDisabledNotice());
        writeSummary(fsImpl, env, annotations.renderSummary({}, 'disabled'));
        return 0;
    }

    let result;
    try {
        const pr = String(args.pr == null ? '' : args.pr);
        if (!PR.test(pr)) {
            result = { findings: [{ code: 'UNVERIFIABLE' }], checks: { format: 'unknown', issue: 'unknown', anchor: 'unknown' } };
        } else {
            const view = await ghClient.prView(pr);
            if (!view || !view.ok) {
                result = { findings: [{ code: 'UNVERIFIABLE' }], checks: { format: 'unknown', issue: 'unknown', anchor: 'unknown' } };
            } else {
                const candidate = verify.extractIssueCandidate(view.body);
                // RS-2: sólo se consulta a GitHub con un número ya validado.
                const issueExists = candidate ? await ghClient.issueExists(candidate) : undefined;
                result = verify.verifyProposedMessage({
                    prBody: view.body,
                    commitMessages: view.commits,
                    issueExists,
                    headRef: view.headRefName,
                });
            }
        }
    } catch {
        // Riesgo `classify` + dry-run: una excepción no puede terminar en
        // exit ≠ 0 en dry-run (sería un freno falso, #7622).
        result = { findings: [{ code: 'UNVERIFIABLE' }], checks: { format: 'unknown', issue: 'unknown', anchor: 'unknown' } };
    }

    for (const f of result.findings) out(annotations.formatAnnotation({ code: f.code, issue: f.issue, mode }));
    writeSummary(fsImpl, env, annotations.renderSummary(result.checks, mode));
    if (!result.findings.length) out('Autoría del PR: trailer completo y consistente.');
    return mode === 'enforce' && result.findings.length ? 1 : 0;
}

async function verifyCommit({ args, fsImpl, out, execFileImpl }) {
    try {
        const sha = String(args.commit == null ? '' : args.commit);
        if (!SHA.test(sha)) return 0;
        const { block } = resolveModeSafe(fsImpl, args.config || '.pipeline/config.yaml');
        if (ciMode.resolveCiMode(block) === 'disabled') return 0;
        const commit = await gitCommit(execFileImpl, sha);
        if (!commit) return 0;
        const goLive = ciMode.goLiveMs(block);
        const date = Date.parse(commit.date);
        if (goLive !== null && !Number.isNaN(date) && date < goLive) return 0; // histórico
        const res = verify.verifyCommitMessage(commit.message);
        if (res.candidate && res.findings.length) out(annotations.formatAuditWarning(sha));
    } catch { /* informativo: nunca falla */ }
    return 0;
}

/**
 * @returns {Promise<number>} exit code
 */
async function main(argv = [], {
    ghClient,
    fsImpl = nodeFs,
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    execFileImpl = childProcess.execFile,
} = {}) {
    const out = (line) => stdout.write(`${line}\n`);
    if (Array.isArray(argv) && argv[0] === 'export') {
        // Carga diferida con path calculado (ver cabecera): fuera del cierre de CI.
        const exportCli = require(nodePath.join(__dirname, 'export-cli.js'));
        return exportCli.runExportCommand(argv.slice(1), { stdout, stderr });
    }
    const args = parseArgs(argv);
    const sub = args._[0];
    if (args.help || !sub) {
        (sub || args.help ? stdout : stderr).write(HELP);
        return args.help ? 0 : 2;
    }
    if (sub !== 'verify') {
        stderr.write(`Subcomando desconocido.\n\n${HELP}`);
        return 2;
    }
    if (args.commit !== undefined) {
        if (!args.informative) {
            stderr.write('verify --commit requiere --informative.\n');
            return 2;
        }
        return verifyCommit({ args, fsImpl, out, execFileImpl });
    }
    if (args.pr === undefined) {
        stderr.write(`Falta --pr <N> o --commit <SHA>.\n\n${HELP}`);
        return 2;
    }
    const client = ghClient || createGhClient({ execFileImpl, env });
    return verifyPr({ args, ghClient: client, fsImpl, out, env });
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}

module.exports = { main, HELP, parseArgs };
