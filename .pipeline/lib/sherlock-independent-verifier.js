// =============================================================================
// sherlock-independent-verifier.js — Recolección de evidencia INDEPENDIENTE
// para el verificador adversarial Sherlock (#3846).
//
// PROBLEMA QUE RESUELVE
// ---------------------
// Hasta este módulo, Sherlock (`sherlock-verifier.js`) contrastaba el análisis
// del Commander contra un `systemState` que el PROPIO Commander observó. Ese
// snapshot derivaba de los mismos marcadores del pipeline (waves.json,
// heartbeats, archivos de fase `procesado/<issue>.*`) que el Commander ya
// había leído. Resultado: Sherlock solo detectaba incoherencias INTERNAS entre
// la respuesta y el snapshot, nunca refutaba las premisas de fondo.
//
// Caso real (2026-06-06/07): #3722 reportaba `escape-html.js` "procesado y
// aprobado" en todas las fases, pero el código nunca se mergeó a main ni
// existía en disco. Sherlock no lo detectó porque su "estado real" ERA el
// systemState que afirmaba "procesado".
//
// SOLUCIÓN
// --------
// `collectIndependentEvidence()` arma evidencia contrastando fuentes de verdad
// REALES, independientes del systemState:
//   - filesystem: existencia de archivos de fase y entregables en disco.
//   - git directo: `git ls-tree origin/main` y ramas `agent/<issue>-*` (¿el
//     entregable está realmente en main?).
//   - github-api (gh CLI): estado real de PR/issue (merged? open? closed?).
//   - heartbeat: ¿el PID que dice "trabajando" existe de verdad en la máquina?
//
// La evidencia se arma ANTES del prompt fiscal y se inyecta en una sección
// `<independent_evidence>` separada del `<system_state>` (preserva CA-SEC-2).
//
// INVARIANTES
// -----------
//   - FAIL-OPEN (back-compat): si cualquier source falla o no hay acceso, el
//     collector NO bloquea — devuelve lo que pudo recolectar. Sherlock sigue
//     funcionando igual que hoy (sin sección independent_evidence).
//   - PERFORMANCE (<500ms total): cada source tiene presupuesto propio
//     (~200ms); si lo excede se abandona y se sigue con el siguiente.
//   - CA-SEC-10: outputs de git/gh se capean en tamaño y NUNCA se construyen
//     comandos con entrada cruda del usuario — el issueNumber se normaliza a
//     entero antes de cualquier shell-out (no hay interpolación de strings
//     arbitrarios en argumentos de git/gh).
//
// USO
// ---
//   const { collectIndependentEvidence, formatIndependentEvidence } =
//       require('./sherlock-independent-verifier');
//   const evidence = await collectIndependentEvidence({ issueNumber, pipelineDir });
//   const text = formatIndependentEvidence(evidence); // → string para el prompt
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Presupuestos de performance (ver "Notas técnicas / Performance" del #3846).
const DEFAULT_PER_SOURCE_BUDGET_MS = 200;
const DEFAULT_TOTAL_BUDGET_MS = 500;

// CA-SEC-10 — cap de payload por finding y total. Outputs de git/gh pueden ser
// grandes; recortamos para no inflar el prompt fiscal ni dar superficie a un
// DoS de payload.
const MAX_FINDING_DETAIL_CHARS = 600;
const MAX_FINDINGS = 24;

// -----------------------------------------------------------------------------
// normalizeIssueNumber — CA-SEC-10. El issueNumber SIEMPRE debe ser entero
// positivo. Devuelve el número o null. Esto garantiza que nunca pasamos texto
// arbitrario del usuario a `git`/`gh` (los argumentos derivan solo de este
// entero validado).
// -----------------------------------------------------------------------------
function normalizeIssueNumber(raw) {
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || n > 1e9) return null;
    return n;
}

// -----------------------------------------------------------------------------
// deriveRepoRoot — el repoRoot es el padre de `.pipeline`. Si pipelineDir no
// termina en `.pipeline`, lo usamos tal cual (los tests inyectan tmp dirs).
// -----------------------------------------------------------------------------
function deriveRepoRoot(pipelineDir) {
    if (!pipelineDir) return process.cwd();
    const base = path.basename(pipelineDir);
    if (base === '.pipeline') return path.resolve(pipelineDir, '..');
    return pipelineDir;
}

// -----------------------------------------------------------------------------
// capDetail — recorta un detalle a MAX_FINDING_DETAIL_CHARS con marcador.
// -----------------------------------------------------------------------------
function capDetail(s) {
    const str = String(s == null ? '' : s);
    if (str.length <= MAX_FINDING_DETAIL_CHARS) return str;
    return str.slice(0, MAX_FINDING_DETAIL_CHARS) + ' …[truncado CA-SEC-10]';
}

// -----------------------------------------------------------------------------
// defaultGitImpl — ejecuta `git` con args (array, NUNCA shell string) y timeout.
// Devuelve Promise<{ ok, stdout, code }>. Fail-open: cualquier error → ok:false.
// -----------------------------------------------------------------------------
function defaultGitImpl({ args, cwd, timeoutMs }) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (r) => { if (!settled) { settled = true; resolve(r); } };
        try {
            execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
                (err, stdout) => {
                    if (err) return done({ ok: false, stdout: String(stdout || ''), code: err.code });
                    done({ ok: true, stdout: String(stdout || ''), code: 0 });
                });
        } catch (e) {
            done({ ok: false, stdout: '', code: e && e.code });
        }
    });
}

// -----------------------------------------------------------------------------
// defaultGhApi — ejecuta `gh` con args (array) y timeout. Mismo contrato que
// gitImpl. Fail-open. Si `gh` no está instalado → ok:false (no bloquea).
// -----------------------------------------------------------------------------
function defaultGhApi({ args, cwd, timeoutMs }) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (r) => { if (!settled) { settled = true; resolve(r); } };
        try {
            execFile('gh', args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
                (err, stdout) => {
                    if (err) return done({ ok: false, stdout: String(stdout || ''), code: err.code });
                    done({ ok: true, stdout: String(stdout || ''), code: 0 });
                });
        } catch (e) {
            done({ ok: false, stdout: '', code: e && e.code });
        }
    });
}

// -----------------------------------------------------------------------------
// defaultProcessCheck — chequea si un PID está vivo. `process.kill(pid, 0)` no
// mata: solo verifica existencia (lanza ESRCH si no existe). Cross-platform.
// -----------------------------------------------------------------------------
function defaultProcessCheck(pid) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return false;
    try {
        process.kill(n, 0);
        return true;
    } catch (e) {
        // EPERM = existe pero sin permisos (lo tratamos como vivo).
        return e && e.code === 'EPERM';
    }
}

// -----------------------------------------------------------------------------
// pushFinding — agrega un finding respetando el cap CA-SEC-10.
//   source: 'filesystem' | 'git' | 'github-api' | 'heartbeat'
//   kind:   etiqueta corta del tipo de hecho (ej. 'phase_marker', 'branch_in_main')
//   summary: hecho ground-truth en una línea (lo que Sherlock contrasta)
//   detail:  contexto adicional (capeado)
// -----------------------------------------------------------------------------
function pushFinding(findings, { source, kind, summary, detail }) {
    if (findings.length >= MAX_FINDINGS) return;
    findings.push({
        source,
        kind,
        summary: capDetail(summary),
        detail: detail == null ? null : capDetail(detail),
    });
}

// =============================================================================
// collectIndependentEvidence — orquesta las 4 sources con fail-open y budget.
//
// Params (todos opcionales salvo issueNumber):
//   issueNumber   — entero del issue (CA-SEC-10: se normaliza).
//   pipelineDir   — dir `.pipeline` (para archivos de fase y heartbeats).
//   repoRoot      — raíz del repo git (default: padre de pipelineDir).
//   phaseDirs     — override de las carpetas de fase a inspeccionar.
//   fsImpl        — inyectable (default node:fs).
//   gitImpl       — inyectable async ({args,cwd,timeoutMs}) → {ok,stdout,code}.
//   ghApi         — inyectable async (mismo contrato que gitImpl).
//   processCheck  — inyectable (pid) → boolean.
//   now           — inyectable () → ms (para budget en tests).
//   log           — inyectable (tag, msg).
//   perSourceBudgetMs / totalBudgetMs — presupuestos de performance.
//   enabledSources — set/array para limitar qué sources correr (default todas).
//
// Devuelve:
//   {
//     ok: boolean,              // false solo si issueNumber inválido
//     issueNumber: number|null,
//     findings: [ {source,kind,summary,detail} ],
//     sources: [ ...successfully consulted ],
//     sourcesChecked: [ ...attempted ],
//     durationMs: number,
//     error: string|null,
//   }
// =============================================================================
async function collectIndependentEvidence(opts = {}) {
    const {
        issueNumber,
        pipelineDir,
        repoRoot: repoRootArg,
        phaseDirs,
        fsImpl,
        gitImpl,
        ghApi,
        processCheck,
        now,
        log,
        perSourceBudgetMs,
        totalBudgetMs,
        enabledSources,
    } = opts;

    const _fs = fsImpl || fs;
    const _git = typeof gitImpl === 'function' ? gitImpl : defaultGitImpl;
    const _gh = typeof ghApi === 'function' ? ghApi : defaultGhApi;
    const _proc = typeof processCheck === 'function' ? processCheck : defaultProcessCheck;
    const _log = typeof log === 'function' ? log : () => {};
    const _now = typeof now === 'function' ? now : Date.now;
    const PER = Number.isFinite(perSourceBudgetMs) ? perSourceBudgetMs : DEFAULT_PER_SOURCE_BUDGET_MS;
    const TOTAL = Number.isFinite(totalBudgetMs) ? totalBudgetMs : DEFAULT_TOTAL_BUDGET_MS;

    const start = _now();
    const findings = [];
    const sources = [];
    const sourcesChecked = [];

    const issueNum = normalizeIssueNumber(issueNumber);
    if (issueNum == null) {
        return {
            ok: false,
            issueNumber: null,
            findings,
            sources,
            sourcesChecked,
            durationMs: _now() - start,
            error: 'invalid_issue_number',
        };
    }

    const repoRoot = repoRootArg || deriveRepoRoot(pipelineDir);
    const wantSource = (name) => {
        if (!enabledSources) return true;
        const set = Array.isArray(enabledSources) ? new Set(enabledSources) : enabledSources;
        return set.has(name);
    };
    const budgetLeft = () => TOTAL - (_now() - start);
    const sourceBudget = () => Math.max(0, Math.min(PER, budgetLeft()));

    // -------------------------------------------------------------------------
    // SOURCE 1 — filesystem: marcadores de fase en `procesado/<issue>.*`.
    // El systemState afirma "procesado/aprobado"; acá verificamos si esos
    // archivos EXISTEN realmente en disco (y los listamos).
    // -------------------------------------------------------------------------
    if (wantSource('filesystem') && budgetLeft() > 0) {
        sourcesChecked.push('filesystem');
        try {
            const dirs = Array.isArray(phaseDirs) && phaseDirs.length
                ? phaseDirs
                : defaultPhaseDirs(pipelineDir);
            const markers = [];
            for (const d of dirs) {
                let entries = [];
                try {
                    entries = _fs.readdirSync(d);
                } catch { continue; }
                for (const name of entries) {
                    // Match `<issue>.` o `<issue>-` para evitar falsos positivos
                    // (ej. 384 vs 3846). Los archivos de fase son `<issue>.<skill>`.
                    if (name.startsWith(`${issueNum}.`) || name.startsWith(`${issueNum}-`)) {
                        markers.push(path.join(path.basename(path.dirname(d)) || '', path.basename(d), name));
                    }
                }
            }
            if (markers.length) {
                pushFinding(findings, {
                    source: 'filesystem',
                    kind: 'phase_markers_present',
                    summary: `Existen ${markers.length} archivo(s) de fase para #${issueNum} en disco.`,
                    detail: markers.join('\n'),
                });
            } else {
                pushFinding(findings, {
                    source: 'filesystem',
                    kind: 'phase_markers_absent',
                    summary: `NO existe ningún archivo de fase en disco para #${issueNum} (procesado/trabajando/listo).`,
                    detail: `Carpetas inspeccionadas: ${dirs.length}.`,
                });
            }
            sources.push('filesystem');
        } catch (e) {
            _log('sherlock-ie', `filesystem source falló (fail-open): ${e && e.message}`);
        }
    }

    // -------------------------------------------------------------------------
    // SOURCE 2 — heartbeat: ¿el PID que dice "trabajando" existe de verdad?
    // Detecta heartbeats zombi (#3719/#3827): marcadores de agentes muertos que
    // siguen "trabajando" y bloquean el cupo de ejecución.
    // -------------------------------------------------------------------------
    if (wantSource('heartbeat') && budgetLeft() > 0) {
        sourcesChecked.push('heartbeat');
        try {
            const hbInfo = readHeartbeat({ fsImpl: _fs, repoRoot, pipelineDir, issueNum });
            if (hbInfo && hbInfo.exists) {
                if (hbInfo.pid != null) {
                    const alive = _proc(hbInfo.pid);
                    pushFinding(findings, {
                        source: 'heartbeat',
                        kind: alive ? 'heartbeat_pid_alive' : 'heartbeat_pid_dead',
                        summary: alive
                            ? `Heartbeat de #${issueNum} apunta a PID ${hbInfo.pid} y ese proceso ESTÁ VIVO.`
                            : `Heartbeat de #${issueNum} apunta a PID ${hbInfo.pid} pero ese proceso NO EXISTE (heartbeat zombi).`,
                        detail: `Archivo: ${hbInfo.file}`,
                    });
                } else {
                    pushFinding(findings, {
                        source: 'heartbeat',
                        kind: 'heartbeat_no_pid',
                        summary: `Heartbeat de #${issueNum} existe pero no expone un PID parseable.`,
                        detail: `Archivo: ${hbInfo.file}`,
                    });
                }
            } else {
                pushFinding(findings, {
                    source: 'heartbeat',
                    kind: 'heartbeat_absent',
                    summary: `No hay heartbeat activo para #${issueNum} (ningún agente lo está trabajando según FS).`,
                    detail: null,
                });
            }
            sources.push('heartbeat');
        } catch (e) {
            _log('sherlock-ie', `heartbeat source falló (fail-open): ${e && e.message}`);
        }
    }

    // -------------------------------------------------------------------------
    // SOURCE 3 — git directo: ¿el branch del agente está mergeado a origin/main?
    // Usamos origin/main (NO main local) — guru verificó empíricamente que main
    // local puede estar stale y reportar falsos negativos (#3846 nota técnica).
    // -------------------------------------------------------------------------
    if (wantSource('git') && budgetLeft() > 0) {
        sourcesChecked.push('git');
        try {
            // Ramas agent/<issue>-* (locales o remotas).
            const br = await _git({
                args: ['branch', '--all', '--list', `*agent/${issueNum}-*`],
                cwd: repoRoot,
                timeoutMs: sourceBudget(),
            });
            const branches = br && br.ok
                ? br.stdout.split('\n').map(s => s.replace(/^[*+\s]+/, '').trim()).filter(Boolean)
                : [];

            if (branches.length && budgetLeft() > 0) {
                // ¿La rama del agente está contenida en origin/main? Si NO, su
                // entregable todavía no llegó a main (posible entregable fantasma).
                const local = branches.find(b => !b.startsWith('remotes/')) || branches[0];
                const merged = await _git({
                    args: ['branch', '--all', '--contains', local, '--list', '*origin/main*'],
                    cwd: repoRoot,
                    timeoutMs: sourceBudget(),
                });
                const inMain = !!(merged && merged.ok && /origin\/main/.test(merged.stdout));
                pushFinding(findings, {
                    source: 'git',
                    kind: inMain ? 'branch_merged_to_main' : 'branch_not_in_main',
                    summary: inMain
                        ? `La rama del agente para #${issueNum} (${local}) YA está contenida en origin/main.`
                        : `La rama del agente para #${issueNum} (${local}) NO está contenida en origin/main (entregable no mergeado).`,
                    detail: `Ramas detectadas: ${branches.join(', ')}`,
                });
            } else {
                pushFinding(findings, {
                    source: 'git',
                    kind: 'branch_absent',
                    summary: `No existe ninguna rama agent/${issueNum}-* en el repo (ni local ni remota).`,
                    detail: null,
                });
            }
            sources.push('git');
        } catch (e) {
            _log('sherlock-ie', `git source falló (fail-open): ${e && e.message}`);
        }
    }

    // -------------------------------------------------------------------------
    // SOURCE 4 — github-api (gh CLI): estado REAL del issue y sus PRs. Fallback
    // a git si el repo local estuviera corrupto/stale (threat model #3846).
    // -------------------------------------------------------------------------
    if (wantSource('github-api') && budgetLeft() > 0) {
        sourcesChecked.push('github-api');
        try {
            const res = await _gh({
                args: ['issue', 'view', String(issueNum), '--json', 'state,closed,title'],
                cwd: repoRoot,
                timeoutMs: sourceBudget(),
            });
            if (res && res.ok && res.stdout.trim()) {
                let parsed = null;
                try { parsed = JSON.parse(res.stdout); } catch { /* ignore */ }
                if (parsed && parsed.state) {
                    pushFinding(findings, {
                        source: 'github-api',
                        kind: 'issue_state',
                        summary: `GitHub reporta el issue #${issueNum} en estado ${parsed.state}${parsed.closed ? ' (cerrado)' : ''}.`,
                        detail: parsed.title ? `Título: ${parsed.title}` : null,
                    });
                }
            }
            // PRs asociados al issue (linked / por rama).
            if (budgetLeft() > 0) {
                const prRes = await _gh({
                    args: ['pr', 'list', '--state', 'all', '--search', String(issueNum),
                        '--json', 'number,state,headRefName,mergedAt', '--limit', '10'],
                    cwd: repoRoot,
                    timeoutMs: sourceBudget(),
                });
                if (prRes && prRes.ok && prRes.stdout.trim()) {
                    let prs = null;
                    try { prs = JSON.parse(prRes.stdout); } catch { /* ignore */ }
                    if (Array.isArray(prs) && prs.length) {
                        const summary = prs.map(p =>
                            `PR #${p.number} [${p.state}${p.mergedAt ? ', merged' : ''}] ${p.headRefName || ''}`.trim()
                        ).join('; ');
                        const anyMerged = prs.some(p => p.mergedAt);
                        pushFinding(findings, {
                            source: 'github-api',
                            kind: anyMerged ? 'pr_merged' : 'pr_not_merged',
                            summary: anyMerged
                                ? `GitHub reporta PR(s) MERGEADO(s) asociados a #${issueNum}.`
                                : `GitHub NO reporta ningún PR mergeado asociado a #${issueNum}.`,
                            detail: summary,
                        });
                    }
                }
            }
            sources.push('github-api');
        } catch (e) {
            _log('sherlock-ie', `github-api source falló (fail-open): ${e && e.message}`);
        }
    }

    return {
        ok: true,
        issueNumber: issueNum,
        findings: findings.slice(0, MAX_FINDINGS),
        sources,
        sourcesChecked,
        durationMs: _now() - start,
        error: null,
    };
}

// -----------------------------------------------------------------------------
// defaultPhaseDirs — carpetas de fase donde viven los marcadores de issue.
// Cubre las 4 colas del lifecycle del pipeline para ambos pipelines.
// -----------------------------------------------------------------------------
function defaultPhaseDirs(pipelineDir) {
    if (!pipelineDir) return [];
    const states = ['pendiente', 'trabajando', 'listo', 'procesado'];
    const phases = [
        ['desarrollo', 'dev'],
        ['desarrollo', 'validacion'],
        ['desarrollo', 'verificacion'],
        ['desarrollo', 'aprobacion'],
        ['definicion', 'analisis'],
        ['definicion', 'criterios'],
    ];
    const dirs = [];
    for (const [pipe, fase] of phases) {
        for (const st of states) {
            dirs.push(path.join(pipelineDir, pipe, fase, st));
        }
    }
    return dirs;
}

// -----------------------------------------------------------------------------
// readHeartbeat — localiza y parsea el heartbeat del issue. Los heartbeats
// viven en `.claude/hooks/agent-<issue>.heartbeat`. Tolera tanto JSON ({pid})
// como texto plano `pid=NNN` / número suelto.
// -----------------------------------------------------------------------------
function readHeartbeat({ fsImpl, repoRoot, pipelineDir, issueNum }) {
    const _fs = fsImpl || fs;
    const candidates = [];
    if (repoRoot) candidates.push(path.join(repoRoot, '.claude', 'hooks', `agent-${issueNum}.heartbeat`));
    if (pipelineDir) {
        candidates.push(path.join(deriveRepoRoot(pipelineDir), '.claude', 'hooks', `agent-${issueNum}.heartbeat`));
        candidates.push(path.join(pipelineDir, 'heartbeats', `agent-${issueNum}.heartbeat`));
    }
    for (const file of candidates) {
        let raw;
        try {
            raw = _fs.readFileSync(file, 'utf8');
        } catch { continue; }
        return { exists: true, file, pid: parsePid(raw) };
    }
    return { exists: false, file: null, pid: null };
}

// -----------------------------------------------------------------------------
// parsePid — extrae un PID de un heartbeat en varios formatos posibles.
// -----------------------------------------------------------------------------
function parsePid(raw) {
    if (raw == null) return null;
    const txt = String(raw).trim();
    // JSON con campo pid
    try {
        const obj = JSON.parse(txt);
        if (obj && Number.isInteger(Number(obj.pid))) return Number(obj.pid);
    } catch { /* not json */ }
    // pid=NNN
    const kv = txt.match(/pid\s*[=:]\s*(\d+)/i);
    if (kv) return Number(kv[1]);
    // número suelto
    const bare = txt.match(/\b(\d{2,})\b/);
    if (bare) return Number(bare[1]);
    return null;
}

// -----------------------------------------------------------------------------
// formatIndependentEvidence — renderiza la evidencia a un bloque de texto plano
// para inyectar en el prompt fiscal. NO incluye delimitadores XML — eso lo pone
// `buildFiscalPrompt` (separación de responsabilidades + CA-SEC-2). Devuelve ''
// si no hay findings (el caller decide no agregar la sección).
// -----------------------------------------------------------------------------
function formatIndependentEvidence(evidence) {
    if (!evidence || !Array.isArray(evidence.findings) || !evidence.findings.length) return '';
    const lines = [];
    lines.push(`Fuentes consultadas: ${(evidence.sources || []).join(', ') || 'ninguna'}.`);
    lines.push('Hechos ground-truth (contrastá el análisis contra esto):');
    for (const f of evidence.findings) {
        const detail = f.detail ? ` — ${f.detail.replace(/\s+/g, ' ').trim()}` : '';
        lines.push(`- [${f.source}/${f.kind}] ${f.summary}${detail}`);
    }
    return lines.join('\n');
}

module.exports = {
    collectIndependentEvidence,
    formatIndependentEvidence,
    // exports para tests / reuso
    _normalizeIssueNumber: normalizeIssueNumber,
    _deriveRepoRoot: deriveRepoRoot,
    _defaultPhaseDirs: defaultPhaseDirs,
    _readHeartbeat: readHeartbeat,
    _parsePid: parsePid,
    _defaultProcessCheck: defaultProcessCheck,
    _capDetail: capDetail,
    MAX_FINDINGS,
    MAX_FINDING_DETAIL_CHARS,
    DEFAULT_PER_SOURCE_BUDGET_MS,
    DEFAULT_TOTAL_BUDGET_MS,
};
