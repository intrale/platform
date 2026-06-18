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
//       // ENUM CERRADO de fuentes (#3923 EP2-H3). Cualquier source nuevo se
//       // agrega aquí Y en LOCKSTEP a AUDIT_SOURCE_ENUM (sherlock-audit-jsonl.js)
//       // y al objeto not_verifiable_by_source (dashboard-slices.js).
//       source: 'filesystem' | 'heartbeat' | 'git' | 'github-api'
//             | 'pipeline-state'   // lectura+parse del YAML del work-file (hook read())
//             | 'waves',           // ola activa (lib/waves.getActiveWave)
//       argsBuilder(validatedParams) -> string[]   // SEC-1: valida adentro, LANZA si falla
//       read?(args, impls) -> string                // hook OPCIONAL (filesystem/pipeline-state):
//                                                   //   devuelve contenido para parse() (fail-open)
//       scan?(args, impls) -> value                 // hook OPCIONAL (heartbeat agregado):
//                                                   //   readdir acotado + processCheck → valor
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

const path = require('node:path');

// Presupuesto por defecto de un canonical individual. Coherente con
// DEFAULT_PER_SOURCE_BUDGET_MS del verificador independiente.
// #3924 (EP2-H4) — subido en LOCKSTEP con DEFAULT_PER_SOURCE_BUDGET_MS (800ms):
// subir uno sin el otro dejaría inconsistencia entre el árbitro canónico y el
// verificador. Override por entorno para tuning sin redeploy.
const DEFAULT_CLAIM_TIMEOUT_MS = (() => {
    const raw = process.env.SHERLOCK_CLAIM_TIMEOUT_MS;
    if (raw == null || raw === '') return 800;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 800;
})();

// SEC-1 — allowlist de SHA git: hex de 7 a 40 chars, nada más.
const SHA_RE = /^[0-9a-f]{7,40}$/;

// SEC-1 — allowlist del nombre de un marker de agente en `trabajando/`:
// `<issue>.<skill>` con issue entero y skill en kebab/alfanumérico.
const MARKER_RE = /^(\d+)\.([a-z0-9-]+)$/;

// SEC-1 — estados de carpeta del pipeline (enum cerrado, NO viene del claim).
const ESTADO_ENUM = new Set(['pendiente', 'trabajando', 'listo', 'procesado']);

// -----------------------------------------------------------------------------
// Resolución de paths del pipeline (#3923). `PIPELINE_DIR` es `.pipeline/`
// (lib/.., igual que waves.js). Override por entorno para tests aislados.
// `HEARTBEAT_DIR` es `.claude/hooks/` (peer de `.pipeline/`), donde viven los
// markers `agent-<issue>.heartbeat` con el `pid` del proceso del agente.
// -----------------------------------------------------------------------------
function pipelineRoot() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.join(__dirname, '..');
}
function heartbeatRoot() {
    if (process.env.CANONICAL_HEARTBEAT_DIR_OVERRIDE) return process.env.CANONICAL_HEARTBEAT_DIR_OVERRIDE;
    return path.join(pipelineRoot(), '..', '.claude', 'hooks');
}

// -----------------------------------------------------------------------------
// loadPipelineConfig — lee `config.yaml` (lazy-require de js-yaml con fallback,
// mismo patrón que waves.js:515). Cacheado por path resuelto: tests con distinto
// `PIPELINE_DIR_OVERRIDE` obtienen su propia entrada. FAIL-OPEN: cualquier error
// (yaml ausente, archivo ilegible) → `{}` (los enums quedan vacíos → argsBuilder
// lanza → not_verifiable).
// -----------------------------------------------------------------------------
const _cfgCache = new Map(); // cfgPath -> cfg
function loadPipelineConfig() {
    const cfgPath = path.join(pipelineRoot(), 'config.yaml');
    if (_cfgCache.has(cfgPath)) return _cfgCache.get(cfgPath);
    let cfg = {};
    try {
        // eslint-disable-next-line global-require
        const yaml = require('js-yaml'); // safe-by-default (yaml.load, sin !!js/function)
        cfg = yaml.load(require('node:fs').readFileSync(cfgPath, 'utf8')) || {};
    } catch {
        cfg = {}; // config ausente / yaml no disponible → enums vacíos.
    }
    _cfgCache.set(cfgPath, cfg);
    return cfg;
}
function _resetConfigCache() { _cfgCache.clear(); } // solo para tests

// Enums cerrados derivados de config.yaml (`pipelines.*`).
function pipelineEnum() {
    const cfg = loadPipelineConfig();
    return new Set(Object.keys(cfg.pipelines || {}));
}
function faseEnumFor(pipeline) {
    const cfg = loadPipelineConfig();
    const p = (cfg.pipelines || {})[pipeline];
    return new Set((p && Array.isArray(p.fases)) ? p.fases : []);
}
function skillEnumFor(pipeline, fase) {
    const cfg = loadPipelineConfig();
    const p = (cfg.pipelines || {})[pipeline];
    const spf = (p && p.skills_por_fase) || {};
    return new Set(Array.isArray(spf[fase]) ? spf[fase] : []);
}

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

// -----------------------------------------------------------------------------
// Helpers de corroboración del claim entregable_en_main (#4074). SEC-5: cualquier
// error de parse → valor neutro ([]/null), NUNCA throw. Se usan SOLO en la rama
// de corroboración cuando la rama agent/<n>-* fue borrada tras squash-merge.
// -----------------------------------------------------------------------------

// parseClosedByPrNumbers — extrae los números de PR que cerraron el issue del
// JSON de `gh issue view <n> --json closedByPullRequestsReferences`. Cada número
// pasa por `normalizeIssueNumber` (entero estricto) ANTES de poder usarse como
// arg (SEC-1: nunca se concatena un número crudo del JSON al comando). JSON
// malformado o sin el campo → [].
function parseClosedByPrNumbers(stdout) {
    try {
        const j = JSON.parse(String(stdout == null ? '' : stdout));
        const refs = Array.isArray(j.closedByPullRequestsReferences)
            ? j.closedByPullRequestsReferences
            : [];
        const nums = [];
        for (const r of refs) {
            const n = normalizeIssueNumber(r && r.number);
            if (n != null) nums.push(n);
        }
        return nums;
    } catch {
        return [];
    }
}

// parseMergedCommitOid — del JSON de `gh pr view <pr> --json state,mergedAt,
// mergeCommit`, devuelve el oid del merge-commit SOLO si el PR está realmente
// mergeado (`mergedAt` presente) y el oid es hex válido (SHA_RE). Si el PR no
// está mergeado, no tiene merge-commit, o el JSON es inválido → null. Esto evita
// falsos positivos: sin un oid verificable NO se puede afirmar "en main".
function parseMergedCommitOid(stdout) {
    try {
        const j = JSON.parse(String(stdout == null ? '' : stdout));
        if (!j.mergedAt) return null; // PR no mergeado → no corrobora
        const oid = (j.mergeCommit && typeof j.mergeCommit.oid === 'string')
            ? j.mergeCommit.oid
            : '';
        return SHA_RE.test(oid) ? oid : null;
    } catch {
        return null;
    }
}

// -----------------------------------------------------------------------------
// Helpers de parse nuevos (#3923). Todos SEC-5: try/catch → not_verifiable,
// NUNCA throw. El loader YAML es `js-yaml` ≥4 `load` (safe-by-default).
// -----------------------------------------------------------------------------

// parseWorkFilePhase — extrae `fase` del YAML del work-file. Valor categórico
// (string). YAML malformado/truncado/gigante → not_verifiable (anti-DoS).
function parseWorkFilePhase(stdout) {
    try {
        // eslint-disable-next-line global-require
        const doc = require('js-yaml').load(String(stdout == null ? '' : stdout)) || {};
        if (typeof doc !== 'object' || Array.isArray(doc)) return { value: null, status: 'not_verifiable' };
        return { value: String(doc.fase || ''), status: 'ok' };
    } catch {
        return { value: null, status: 'not_verifiable' };
    }
}

// parseQaLabels — true si el PR tiene al menos un label `qa:*`. El filtro vive
// SOLO acá (en parse), NUNCA como `--jq` derivado del claim (SEC-1, anti-RCE).
function parseQaLabels(stdout) {
    return parseJsonField(stdout, (j) =>
        (Array.isArray(j.labels) ? j.labels : [])
            .some(l => String((l && l.name) || '').startsWith('qa:')));
}

// parseActiveAgents — normaliza el conteo (number) producido por el hook scan().
function parseActiveAgents(stdout) {
    try {
        const n = Number(stdout);
        if (!Number.isFinite(n)) return { value: null, status: 'not_verifiable' };
        return { value: n, status: 'ok' };
    } catch {
        return { value: null, status: 'not_verifiable' };
    }
}

// parseActiveWave — normaliza el identificador categórico (string) de la ola
// activa. '' representa "no hay ola activa".
function parseActiveWave(stdout) {
    try {
        return { value: stdout == null ? '' : String(stdout), status: 'ok' };
    } catch {
        return { value: null, status: 'not_verifiable' };
    }
}

// =============================================================================
// CANONICAL_FACTS — 10 claims (#3923). Cada entrada: { source, argsBuilder,
// parse, [read], [scan] }.
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
        // ---------------------------------------------------------------------
        // resolve() (#4074) — anti-falso-negativo del flag "s/main".
        //
        // `--merged origin/main --list *agent/<n>-*` devuelve vacío para CUALQUIER
        // entregable integrado por **squash-merge**: el squash crea un commit
        // nuevo, así que el tip de la rama agent/<n>-* NUNCA es ancestro de
        // origin/main — exista la rama o haya sido borrada tras el merge. El parse
        // plano concluía `false` en ese caso → falso negativo "s/main" para
        // issues que SÍ están en main (incidente #4052/#4051/#4039).
        //
        // Diseño conservador (CA #4074: "ante la duda, not_verifiable; nunca un
        // true espurio"). Sólo afirma con señales POSITIVAS verificables y JAMÁS
        // emite un `false` (la presencia real en main vía squash no se puede
        // refutar con el tip de la rama):
        //   1. rama agent/<n>-* mergeada a origin/main (merge no-squash) → true.
        //   2. PR que cerró el issue + mergeado + merge-commit ES ancestro de
        //      origin/main (cubre squash-merge, con o sin rama borrada)    → true.
        //   3. sin ninguna señal positiva verificable → not_verifiable (NO false).
        //
        // Usa `origin/main` (no main local stale, ver #3846). fail-open (SEC-5):
        // cualquier fallo de git/gh → not_verifiable, jamás throw.
        async resolve({ issue } = {}, helpers = {}) {
            const git = typeof helpers.git === 'function' ? helpers.git : null;
            const gh = typeof helpers.gh === 'function' ? helpers.gh : null;
            const n = normalizeIssueNumber(issue);
            if (n == null || !git) return { value: null, verifiable: false };

            // (1) Señal primaria: rama agent/<n>-* MERGEADA a origin/main. Sólo
            // detecta merges no-squash (tip ancestro). Positivo → true.
            const merged = await git(['branch', '--all', '--merged', 'origin/main', '--list', `*agent/${n}-*`]);
            if (merged && merged.ok) {
                const p = parseBranchPresence(merged.stdout);
                if (p.status === 'ok' && p.value === true) return { value: true, verifiable: true };
            }

            // (2) Corroboración robusta (cubre squash-merge): el/los PR que
            // cerraron el issue, mergeado(s), cuyo merge-commit ES ancestro de
            // origin/main. NO se usa la mera EXISTENCIA de la rama como señal de
            // ausencia (un squash-merge la deja sin mergear-por-tip aunque el
            // entregable esté en main).
            if (!gh) return { value: null, verifiable: false };
            let prNumbers = [];
            try {
                const iv = await gh(['issue', 'view', String(n), '--json', 'closedByPullRequestsReferences']);
                if (iv && iv.ok) prNumbers = parseClosedByPrNumbers(iv.stdout);
            } catch { /* fail-open */ }

            for (const pr of prNumbers) {
                let oid = null;
                try {
                    const pv = await gh(['pr', 'view', String(pr), '--json', 'state,mergedAt,mergeCommit']);
                    if (pv && pv.ok) oid = parseMergedCommitOid(pv.stdout);
                } catch { /* fail-open: probar el siguiente PR */ }
                if (oid) {
                    // SEC-1: `oid` ya pasó SHA_RE en parseMergedCommitOid (hex puro).
                    const anc = await git(['merge-base', '--is-ancestor', oid, 'origin/main']);
                    if (anc && anc.ok) return { value: true, verifiable: true };
                }
            }

            // (3) Sin señal positiva verificable → not_verifiable (NUNCA false ni
            // true espurio). Ante la duda, el flag "s/main" no se muestra (#4074).
            return { value: null, verifiable: false };
        },
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

    // =========================================================================
    // #3923 EP2-H3 — 4 claims nuevos (diccionario: 6 → 10).
    // =========================================================================

    // -------------------------------------------------------------------------
    // estado_fase_issue — ¿en qué fase del pipeline está el work-file del issue?
    // source 'pipeline-state': lee+parsea el YAML en
    // `.pipeline/<pipeline>/<fase>/<estado>/<issue>.<skill>` vía hook read().
    // CATEGÓRICO: el `value` es el nombre de fase (string); `expected` debe
    // viajar como string. SEC: el path se DERIVA de enums cerrados validados
    // (config.yaml) + `normalizeIssueNumber`, nunca de segmentos crudos del
    // claim; se verifica contención dentro de `.pipeline/` (anti path-traversal).
    // -------------------------------------------------------------------------
    estado_fase_issue: {
        source: 'pipeline-state',
        argsBuilder({ issue, pipeline, fase, estado, skill } = {}) {
            const n = normalizeIssueNumber(issue);
            if (n == null) throw new Error('issue_invalido');
            if (!pipelineEnum().has(pipeline)) throw new Error('pipeline_invalido');
            if (!faseEnumFor(pipeline).has(fase)) throw new Error('fase_invalida');
            if (!ESTADO_ENUM.has(estado)) throw new Error('estado_invalido');
            if (!skillEnumFor(pipeline, fase).has(skill)) throw new Error('skill_invalido');
            // path DERIVADO de enums validados, NUNCA segmentos crudos (SEC-1).
            const base = path.resolve(pipelineRoot());
            const p = path.resolve(base, pipeline, fase, estado, n + '.' + skill);
            if (p !== base && !p.startsWith(base + path.sep)) throw new Error('path_traversal');
            return [p];
        },
        read(args, impls) {
            return ((impls && impls.fsImpl) || require('node:fs')).readFileSync(args[0], 'utf8');
        },
        parse(stdout) { return parseWorkFilePhase(stdout); },
    },

    // -------------------------------------------------------------------------
    // agentes_activos — ¿cuántos agentes están efectivamente vivos?
    // source 'heartbeat' (agregado): readdir ACOTADO no-recursivo de cada
    // `<pipeline>/<fase>/trabajando/` (markers `<issue>.<skill>`), cruzado con el
    // heartbeat `agent-<issue>.heartbeat` (PID) + processCheck (existencia, sin
    // kill/señales). Devuelve el conteo de issues con proceso vivo (number).
    // Coherente con "fuente de verdad = filesystem/OS, no agent-registry".
    // -------------------------------------------------------------------------
    agentes_activos: {
        source: 'heartbeat',
        argsBuilder() { return []; }, // sin params: conteo global
        scan(args, impls) {
            const _fs = (impls && impls.fsImpl) || require('node:fs');
            const proc = (impls && typeof impls.processCheck === 'function')
                ? impls.processCheck
                : require('./sherlock-independent-verifier')._defaultProcessCheck;
            const root = path.resolve(pipelineRoot());
            const hbRoot = heartbeatRoot();
            const cfg = loadPipelineConfig();
            const live = new Set();
            for (const [pname, pdef] of Object.entries(cfg.pipelines || {})) {
                const fases = (pdef && Array.isArray(pdef.fases)) ? pdef.fases : [];
                for (const fase of fases) {
                    const dir = path.join(root, pname, fase, 'trabajando');
                    let entries = [];
                    try { entries = _fs.readdirSync(dir); } catch { continue; } // dir ausente → 0
                    for (const name of entries) {
                        const m = MARKER_RE.exec(String(name));
                        if (!m) continue; // nombres no `<issue>.<skill>` se ignoran (SEC)
                        const issue = m[1];
                        try {
                            const hb = JSON.parse(_fs.readFileSync(
                                path.join(hbRoot, `agent-${issue}.heartbeat`), 'utf8'));
                            const pid = Number(hb && hb.pid);
                            if (Number.isInteger(pid) && pid > 0 && proc(pid)) live.add(issue);
                        } catch { /* sin heartbeat / pid muerto → no cuenta */ }
                    }
                }
            }
            return live.size;
        },
        parse(stdout) { return parseActiveAgents(stdout); },
    },

    // -------------------------------------------------------------------------
    // labels_qa_pr — ¿el PR tiene algún label `qa:*`?
    // REUSA el patrón de pr_mergeado (param `pr` → entero estricto). El comando
    // es LITERAL `['pr','view',<n>,'--json','labels']`; el filtro `qa:*` vive
    // EXCLUSIVAMENTE en parse(). PROHIBIDO `--jq` derivado del claim (anti-RCE).
    // -------------------------------------------------------------------------
    labels_qa_pr: {
        source: 'github-api',
        argsBuilder({ pr } = {}) {
            const n = normalizeIssueNumber(pr);
            if (n == null) throw new Error('pr_invalido');
            return ['pr', 'view', String(n), '--json', 'labels']; // literal, sin --jq
        },
        parse(stdout) { return parseQaLabels(stdout); },
    },

    // -------------------------------------------------------------------------
    // ola_activa — ¿cuál es la ola activa del pipeline?
    // source 'waves': lectura local de `.pipeline/waves.json` vía
    // `lib/waves.getActiveWave()` (degradación con gracia ya incorporada).
    // CATEGÓRICO: `value` = nombre de la ola (o '' si no hay); `expected` string.
    // -------------------------------------------------------------------------
    ola_activa: {
        source: 'waves',
        argsBuilder() { return []; }, // sin params: lectura local
        parse(stdout) { return parseActiveWave(stdout); },
    },
};

// =============================================================================
// CLAIM_DOMAINS — #3936 EP4-H3 (CA-5a). Dominio de cada claim para que la métrica
// de "reducción de correcciones de Sherlock por estado del repo" sea filtrable
// del audit JSONL SIN reparsear texto libre. Los claims que refieren a una de las
// 5 dimensiones del bloque de estado (issues, branches, PRs, ola, builds) son
// `repo_state`; el resto (liveness de procesos, fase del work-file) es `other`.
// Enum cerrado en lockstep con CLAIM_DOMAIN_ENUM (sherlock-audit-jsonl.js).
// =============================================================================
const CLAIM_DOMAINS = Object.freeze({
    // branches activas
    rama_contiene_commits: 'repo_state',
    entregable_en_main: 'repo_state',
    // issues abiertos / cerrados
    issue_cerrado: 'repo_state',
    // PRs abiertos / mergeados / labels
    pr_mergeado: 'repo_state',
    labels_qa_pr: 'repo_state',
    // ola activa
    ola_activa: 'repo_state',
    // estado de builds / CI
    workflow_paso: 'repo_state',
    // fuera de las 5 dimensiones del pack de estado
    estado_fase_issue: 'other',
    agentes_activos: 'other',
    proceso_vivo: 'other',
});

// claimDomain — devuelve el dominio de un claim (default 'other' para claims
// desconocidos). Pura, sin side-effects.
function claimDomain(claimKey) {
    return CLAIM_DOMAINS[claimKey] || 'other';
}

// -----------------------------------------------------------------------------
// compareToExpected — traduce el `value` canónico + el `expected` del claim a un
// status tri-estado. Los claims son ASERCIONES POSITIVAS: por defecto el claim
// afirma `expected === true` (ej. pr_mergeado afirma "está mergeado"). Si el
// canónico coincide → 'consistent'; si discrepa → 'inconsistent'.
// -----------------------------------------------------------------------------
function compareToExpected(value, expected) {
    return value === expected ? 'consistent' : 'inconsistent';
}

// -----------------------------------------------------------------------------
// statusFor — variante segura para claims CATEGÓRICOS/numéricos (#3923). Un
// claim cuyo `value` NO es booleano y que se resuelve SIN un `expected` explícito
// (el caller no provee contra qué comparar, ej. la wiring genérica del verifier)
// NO puede producir una contradicción: no hay aserción del Commander que
// refutar. En ese caso → 'not_verifiable' (NUNCA contradicción especulativa,
// SEC-5). Para valores booleanos o con `expected` explícito, compara normal.
// -----------------------------------------------------------------------------
function statusFor(value, expected, hasExplicitExpected) {
    if (!hasExplicitExpected && typeof value !== 'boolean') return 'not_verifiable';
    return compareToExpected(value, expected);
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
    const hasExplicitExpected = !!(params && 'expected' in params);
    const expected = hasExplicitExpected ? params.expected : true;

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

    // ---- Hook resolve() OPCIONAL (#4074): resolución multi-señal -------------
    // Si la entrada define resolve(), orquesta sus propias llamadas (git/gh) y
    // devuelve { value, verifiable }. Permite corroboración anti-falso-negativo
    // sin romper el patrón single-command del resto de los claims. fail-open
    // (SEC-5): cualquier throw o `verifiable !== true` → not_verifiable.
    if (typeof fact.resolve === 'function') {
        const gitImpl = typeof impls.gitImpl === 'function' ? impls.gitImpl : iv._cachedGitImpl;
        const ghApi = typeof impls.ghApi === 'function' ? impls.ghApi : iv._cachedGhApi;
        const runGit = (a) => gitImpl({ args: a, cwd, timeoutMs });
        const runGh = (a) => ghApi({ args: a, cwd, timeoutMs });
        try {
            const out = await fact.resolve(params || {}, { git: runGit, gh: runGh });
            if (!out || out.verifiable !== true || out.value == null) {
                return { value: out ? out.value : null, status: 'not_verifiable', source };
            }
            return { value: out.value, status: compareToExpected(out.value, expected), source };
        } catch {
            return { value: null, status: 'not_verifiable', source };
        }
    }

    // ---- source 'heartbeat': process check directo (sin execFile) ----------
    if (source === 'heartbeat') {
        const proc = typeof impls.processCheck === 'function'
            ? impls.processCheck
            : iv._defaultProcessCheck;
        // Hook scan() OPCIONAL (#3923): agregado readdir+processCheck (agentes_activos).
        if (typeof fact.scan === 'function') {
            try {
                const value = fact.scan(args, { ...impls, processCheck: proc });
                return { value, status: statusFor(value, expected, hasExplicitExpected), source };
            } catch {
                return { value: null, status: 'not_verifiable', source };
            }
        }
        try {
            const pid = Number(args[0]);
            const alive = !!proc(pid);
            return { value: alive, status: compareToExpected(alive, expected), source };
        } catch {
            return { value: null, status: 'not_verifiable', source };
        }
    }

    // ---- source 'waves': ola activa vía lib/waves.getActiveWave (#3923) -----
    if (source === 'waves') {
        try {
            const getActive = (typeof impls.getActiveWave === 'function')
                ? impls.getActiveWave
                : require('./waves').getActiveWave;
            const w = getActive();
            // identificador categórico de la ola: nombre, con fallback a número.
            const raw = w
                ? (w.name != null ? w.name : (w.number != null ? w.number : ''))
                : '';
            const parsed = fact.parse(raw);
            if (!parsed || parsed.status !== 'ok') {
                return { value: parsed ? parsed.value : null, status: 'not_verifiable', source };
            }
            return { value: parsed.value, status: statusFor(parsed.value, expected, hasExplicitExpected), source };
        } catch {
            return { value: null, status: 'not_verifiable', source };
        }
    }

    // ---- source 'filesystem' | 'pipeline-state' ----------------------------
    // Hook read() OPCIONAL (#3923): lee contenido y delega a parse() (fail-open).
    // Si la entrada NO define read(), se conserva el comportamiento `existsSync`
    // histórico (no-regresión para los claims `filesystem` existentes).
    if (source === 'filesystem' || source === 'pipeline-state') {
        const _fs = impls.fsImpl || require('node:fs');
        if (typeof fact.read === 'function') {
            let content;
            try {
                content = fact.read(args, impls);
            } catch {
                return { value: null, status: 'not_verifiable', source }; // archivo ausente, etc.
            }
            const parsed = fact.parse(content);
            if (!parsed || parsed.status !== 'ok') {
                return { value: parsed ? parsed.value : null, status: 'not_verifiable', source };
            }
            return { value: parsed.value, status: statusFor(parsed.value, expected, hasExplicitExpected), source };
        }
        try {
            const exists = _fs.existsSync(args[0]);
            return { value: exists, status: compareToExpected(exists, expected), source };
        } catch {
            return { value: null, status: 'not_verifiable', source };
        }
    }

    // ---- source 'git' | 'github-api': execFile array (sin shell) ------------
    // #3924 — sin inyección de test usamos la impl CACHEADA compartida con el
    // verificador independiente (misma caché TTL → dedup cross-consumidor). Con
    // inyección (`gitImpl`/`ghApi`) bypasseamos la caché.
    const impl = source === 'git'
        ? (typeof impls.gitImpl === 'function' ? impls.gitImpl : iv._cachedGitImpl)
        : (typeof impls.ghApi === 'function' ? impls.ghApi : iv._cachedGhApi);

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
    CLAIM_DOMAINS,
    claimDomain,
    resolveClaim,
    // exports para tests / reuso
    _SHA_RE: SHA_RE,
    _MARKER_RE: MARKER_RE,
    _ESTADO_ENUM: ESTADO_ENUM,
    _normalizeIssueNumber: normalizeIssueNumber,
    _compareToExpected: compareToExpected,
    _statusFor: statusFor,
    _parseJsonField: parseJsonField,
    _parseBranchPresence: parseBranchPresence,
    _parseClosedByPrNumbers: parseClosedByPrNumbers,
    _parseMergedCommitOid: parseMergedCommitOid,
    _parseWorkFilePhase: parseWorkFilePhase,
    _parseQaLabels: parseQaLabels,
    _parseActiveAgents: parseActiveAgents,
    _parseActiveWave: parseActiveWave,
    _pipelineEnum: pipelineEnum,
    _faseEnumFor: faseEnumFor,
    _skillEnumFor: skillEnumFor,
    _loadPipelineConfig: loadPipelineConfig,
    _resetConfigCache,
    DEFAULT_CLAIM_TIMEOUT_MS,
};
