// =============================================================================
// canonical-facts.js — Diccionario determinístico claim → fuente canónica
// (#3895, split 1/3 del épico #3894).
//
// PROBLEMA QUE RESUELVE
// ---------------------
// Sherlock (`sherlock-verifier.js`) podía contradecir afirmaciones del Commander
// de forma ESPECULATIVA: si no podía probar lo contrario, igual marcaba una
// inconsistencia. Eso genera rebotes falsos y ruido. Este módulo invierte la
// lógica: para cada "claim" existe UNA fuente canónica (un comando determinístico
// contra git / gh / heartbeat / filesystem). Sherlock EJECUTA esa fuente y:
//   - solo contradice si el hecho real DISCREPA del claim   (status 'inconsistent')
//   - confirma si COINCIDE                                   (status 'consistent')
//   - declara 'not_verifiable' si NO puede ejecutar la fuente (permiso/herramienta/
//     parse/timeout) — NUNCA una contradicción especulativa.
//
// CONTRATO DEL DICCIONARIO
// ------------------------
//   CANONICAL_FACTS = {
//     [claimKey]: {
//       source: 'filesystem' | 'heartbeat' | 'git' | 'github-api',
//       argsBuilder(validatedParams) -> string[]   // SEC-1: valida adentro, LANZA si falla
//       parse(stdout) -> { value, status }          // SEC-5: try/catch, NUNCA throw
//     }
//   }
//
// INVARIANTES DE SEGURIDAD (heredadas del épico #3894)
// ----------------------------------------------------
//   SEC-1 (anti-inyección): cada `argsBuilder` valida CADA param con allowlist
//     DENTRO del builder y **lanza** si falla. Retorno SIEMPRE `string[]` para
//     `execFile` (sin shell). PR/run-id/issue → entero estricto vía
//     `normalizeIssueNumber()` (rechaza "5;rm", backticks). sha → /^[0-9a-f]{7,40}$/.
//     branch → patrón `agent/<issue>-*` DERIVADO del issue, NUNCA crudo del claim.
//     Prohibido `execSync`, concatenación de strings, y `--jq <expr>` derivado del
//     claim (un `--jq` malicioso es ejecución de código en `gh`).
//   SEC-5 (fail-open observable): `parse()` envuelve cualquier parseo en try/catch
//     y mapea la excepción a `{ status: 'not_verifiable' }` (un stdout malformado
//     o truncado no debe lanzar excepción no controlada → evita DoS por crash).
//     `resolveClaim()` aplica timeout duro vía `execFile` respetando el budget.
//
// USO
// ---
//   const { CANONICAL_FACTS, resolveClaim } = require('./canonical-facts');
//   const r = await resolveClaim('pr_mergeado', { pr: 1732, expected: true }, { ghApi });
//   // r === { value: true, status: 'consistent', source: 'github-api' }
// =============================================================================
'use strict';

// Presupuesto por defecto de un canonical individual. Coherente con
// DEFAULT_PER_SOURCE_BUDGET_MS del verificador independiente (200ms / source).
const DEFAULT_CLAIM_TIMEOUT_MS = 200;

// SEC-1 — allowlist de SHA git: hex de 7 a 40 chars, nada más.
const SHA_RE = /^[0-9a-f]{7,40}$/;

// -----------------------------------------------------------------------------
// normalizeIssueNumber — reuso de la implementación canónica del verificador
// independiente (entero estricto, rechaza texto arbitrario). Lazy-require para
// evitar dependencia circular en tiempo de carga (independent-verifier importa
// este módulo). La función es pura, sin side-effects al resolverse.
// -----------------------------------------------------------------------------
function normalizeIssueNumber(raw) {
    return require('./sherlock-independent-verifier')._normalizeIssueNumber(raw);
}

// -----------------------------------------------------------------------------
// Helpers de parse (SEC-5). NUNCA lanzan: cualquier error → not_verifiable.
// -----------------------------------------------------------------------------
function parseJsonField(stdout, extract) {
    try {
        const j = JSON.parse(String(stdout == null ? '' : stdout));
        return { value: extract(j), status: 'ok' };
    } catch {
        return { value: null, status: 'not_verifiable' };
    }
}

// Cuenta líneas de rama no vacías en la salida de `git branch`. Tolera el
// prefijo `* `/`+ `/`remotes/`. Devuelve booleano (¿hay al menos una rama?).
function parseBranchPresence(stdout) {
    try {
        const lines = String(stdout == null ? '' : stdout)
            .split('\n')
            .map(s => s.replace(/^[*+\s]+/, '').trim())
            .filter(Boolean);
        return { value: lines.length > 0, status: 'ok' };
    } catch {
        return { value: null, status: 'not_verifiable' };
    }
}

// =============================================================================
// CANONICAL_FACTS — los 6 claims. Cada entrada: { source, argsBuilder, parse }.
// =============================================================================
const CANONICAL_FACTS = {
    // -------------------------------------------------------------------------
    // entregable_en_main — ¿la rama del agente está mergeada a origin/main?
    // Comando único: `git branch --all --merged origin/main --list *agent/<n>-*`.
    // `--merged origin/main` filtra ramas cuyo tip es alcanzable desde origin/main
    // (NO main local: puede estar stale → falsos negativos, ver #3846).
    // -------------------------------------------------------------------------
    entregable_en_main: {
        source: 'git',
        argsBuilder({ issue } = {}) {
            const n = normalizeIssueNumber(issue);
            if (n == null) throw new Error('issue_invalido');
            // branch DERIVADA del issue (glob), NUNCA cruda del claim (SEC-1).
            return ['branch', '--all', '--merged', 'origin/main', '--list', `*agent/${n}-*`];
        },
        parse(stdout) { return parseBranchPresence(stdout); },
    },

    // -------------------------------------------------------------------------
    // issue_cerrado — ¿el issue está cerrado en GitHub?
    // `gh issue view <n> --json state,closed`.
    // -------------------------------------------------------------------------
    issue_cerrado: {
        source: 'github-api',
        argsBuilder({ issue } = {}) {
            const n = normalizeIssueNumber(issue);
            if (n == null) throw new Error('issue_invalido');
            return ['issue', 'view', String(n), '--json', 'state,closed'];
        },
        parse(stdout) {
            return parseJsonField(stdout, (j) =>
                j.closed === true || String(j.state || '').toUpperCase() === 'CLOSED');
        },
    },

    // -------------------------------------------------------------------------
    // pr_mergeado — ¿el PR está mergeado?  `gh pr view <n> --json state,mergedAt`.
    // -------------------------------------------------------------------------
    pr_mergeado: {
        source: 'github-api',
        argsBuilder({ pr } = {}) {
            const n = normalizeIssueNumber(pr); // entero estricto (rechaza "5;rm")
            if (n == null) throw new Error('pr_invalido');
            return ['pr', 'view', String(n), '--json', 'state,mergedAt'];
        },
        parse(stdout) {
            return parseJsonField(stdout, (j) => !!j.mergedAt);
        },
    },

    // -------------------------------------------------------------------------
    // proceso_vivo — ¿el PID del heartbeat existe en la máquina?
    // source 'heartbeat': NO usa execFile; `resolveClaim` llama processCheck(pid).
    // argsBuilder valida el pid (entero positivo) y lo devuelve como array (SEC-1
    // uniforme: todo argsBuilder retorna string[]).
    // -------------------------------------------------------------------------
    proceso_vivo: {
        source: 'heartbeat',
        argsBuilder({ pid } = {}) {
            const n = normalizeIssueNumber(pid); // entero estricto positivo
            if (n == null) throw new Error('pid_invalido');
            return [String(n)];
        },
        // Para heartbeat el "stdout" es sintético ('alive'/'dead'); igual va con
        // try/catch por consistencia SEC-5.
        parse(stdout) {
            try {
                return { value: String(stdout).trim() === 'alive', status: 'ok' };
            } catch {
                return { value: null, status: 'not_verifiable' };
            }
        },
    },

    // -------------------------------------------------------------------------
    // rama_contiene_commits — ¿existe la rama agent/<issue>-* (con commits)?
    // `git branch --all --list *agent/<n>-*`. Distinto de entregable_en_main:
    // acá basta con que la rama EXISTA, no que esté mergeada.
    // -------------------------------------------------------------------------
    rama_contiene_commits: {
        source: 'git',
        argsBuilder({ issue } = {}) {
            const n = normalizeIssueNumber(issue);
            if (n == null) throw new Error('issue_invalido');
            return ['branch', '--all', '--list', `*agent/${n}-*`];
        },
        parse(stdout) { return parseBranchPresence(stdout); },
    },

    // -------------------------------------------------------------------------
    // workflow_paso — ¿la ejecución de workflow (run-id) terminó con éxito?
    // `gh run view <run-id> --json conclusion,status,headSha`.
    // SEC-1: run-id → entero estricto; sha (opcional) → /^[0-9a-f]{7,40}$/ y se
    // valida aunque no se concatene al comando (rechaza sha no-hex en el builder).
    // -------------------------------------------------------------------------
    workflow_paso: {
        source: 'github-api',
        argsBuilder({ runId, sha } = {}) {
            const n = normalizeIssueNumber(runId); // run-id es entero estricto
            if (n == null) throw new Error('run_id_invalido');
            if (sha != null && !SHA_RE.test(String(sha))) {
                throw new Error('sha_invalido'); // rechaza non-hex, ;rm, backticks
            }
            return ['run', 'view', String(n), '--json', 'conclusion,status,headSha'];
        },
        parse(stdout) {
            return parseJsonField(stdout, (j) =>
                String(j.status || '').toLowerCase() === 'completed' &&
                String(j.conclusion || '').toLowerCase() === 'success');
        },
    },
};

// -----------------------------------------------------------------------------
// compareToExpected — traduce el `value` canónico + el `expected` del claim a un
// status tri-estado. Los claims son ASERCIONES POSITIVAS: por defecto el claim
// afirma `expected === true` (ej. pr_mergeado afirma "está mergeado"). Si el
// canónico coincide → 'consistent'; si discrepa → 'inconsistent'.
// -----------------------------------------------------------------------------
function compareToExpected(value, expected) {
    return value === expected ? 'consistent' : 'inconsistent';
}

// =============================================================================
// resolveClaim(claimKey, params, impls) → { value, status, source }
//
//   status ∈ { 'consistent', 'inconsistent', 'not_verifiable' }
//
//   params: identificadores del claim (issue/pr/pid/runId/sha) + `expected`
//           opcional (default true — aserción positiva).
//   impls:  { gitImpl, ghApi, processCheck, fsImpl, cwd, timeoutMs }
//           Inyectables; por defecto se reusan las impls del verificador
//           independiente (`defaultGitImpl`/`defaultGhApi`/`defaultProcessCheck`).
//
// FAIL-OPEN (SEC-5): cualquier falla de build/exec/parse → 'not_verifiable',
// NUNCA una excepción y NUNCA una contradicción especulativa.
// =============================================================================
async function resolveClaim(claimKey, params = {}, impls = {}) {
    const fact = CANONICAL_FACTS[claimKey];
    if (!fact) {
        return { value: null, status: 'not_verifiable', source: null };
    }
    const source = fact.source;
    const expected = (params && 'expected' in params) ? params.expected : true;

    // SEC-1 — el builder valida adentro y LANZA si algún param no pasa la
    // allowlist. Un throw acá NO es una contradicción: es no_verificable.
    let args;
    try {
        args = fact.argsBuilder(params || {});
        if (!Array.isArray(args)) throw new Error('args_no_array');
    } catch {
        return { value: null, status: 'not_verifiable', source };
    }

    const iv = require('./sherlock-independent-verifier');
    const cwd = impls.cwd;
    const timeoutMs = Number.isFinite(impls.timeoutMs) ? impls.timeoutMs : DEFAULT_CLAIM_TIMEOUT_MS;

    // ---- source 'heartbeat': process check directo (sin execFile) ----------
    if (source === 'heartbeat') {
        const proc = typeof impls.processCheck === 'function'
            ? impls.processCheck
            : iv._defaultProcessCheck;
        try {
            const pid = Number(args[0]);
            const alive = !!proc(pid);
            return { value: alive, status: compareToExpected(alive, expected), source };
        } catch {
            return { value: null, status: 'not_verifiable', source };
        }
    }

    // ---- source 'filesystem': existencia vía fsImpl -------------------------
    if (source === 'filesystem') {
        const _fs = impls.fsImpl || require('node:fs');
        try {
            const exists = _fs.existsSync(args[0]);
            return { value: exists, status: compareToExpected(exists, expected), source };
        } catch {
            return { value: null, status: 'not_verifiable', source };
        }
    }

    // ---- source 'git' | 'github-api': execFile array (sin shell) ------------
    const impl = source === 'git'
        ? (typeof impls.gitImpl === 'function' ? impls.gitImpl : iv._defaultGitImpl)
        : (typeof impls.ghApi === 'function' ? impls.ghApi : iv._defaultGhApi);

    let res;
    try {
        res = await impl({ args, cwd, timeoutMs });
    } catch {
        return { value: null, status: 'not_verifiable', source };
    }
    if (!res || !res.ok) {
        // herramienta ausente / permiso / timeout / exit-code ≠ 0 → fail-open.
        return { value: null, status: 'not_verifiable', source };
    }

    const parsed = fact.parse(res.stdout);
    if (!parsed || parsed.status !== 'ok') {
        return { value: parsed ? parsed.value : null, status: 'not_verifiable', source };
    }
    return { value: parsed.value, status: compareToExpected(parsed.value, expected), source };
}

module.exports = {
    CANONICAL_FACTS,
    resolveClaim,
    // exports para tests / reuso
    _SHA_RE: SHA_RE,
    _normalizeIssueNumber: normalizeIssueNumber,
    _compareToExpected: compareToExpected,
    _parseJsonField: parseJsonField,
    _parseBranchPresence: parseBranchPresence,
    DEFAULT_CLAIM_TIMEOUT_MS,
};
