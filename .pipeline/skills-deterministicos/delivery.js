#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const trace = require('../lib/traceability');
const git = require('./lib/git-ops');
const codeowners = require('./lib/codeowners');
// #4658 — Escalado fail-closed ante conflicto de merge REAL. Sólo CONSUMO de la
// infra de operador ausente de #4632 (nunca la modificamos): política
// (fail-closed + mensajería), audit tamper-evident y saneo de texto libre.
const absencePolicy = require('../lib/operator-absence-policy');
const absenceAudit = require('../lib/operator-absence-audit');
const operatorGate = require('../lib/operator-gate');
const { sanitizeReason } = require('../lib/kernel-actions-audit');
// #5864 — dueño único de la invariante "imposible qa:passed + qa:failed".
const gateLabelReconciler = require('../lib/gate-label-reconciler');
// #5864 SEC-2 — procedencia del PR destino (defensa contra PRs de fork).
const prProvenance = require('../lib/pr-provenance');
// #5420 — Verificación de procedencia de la rama del PR antes de mergear.
// Se CONSUME la implementación canónica (#5419): es `git fetch` + `git log`
// contra la allowlist de committers, no necesita worktree y no se duplica acá.
const { verifyRemoteBranchOrigin } = require('../lib/worktree-resolver');
const { classifyChecks, describeInformationalChecks } = require('../lib/human-block-triggers');
// #6431 - lector/clasificador de los checks REQUERIDOS del ruleset de la rama
// base. Se importa el modulo entero (no funciones sueltas) para que el wiring
// de produccion arme el reader con `EXPECTED_PR_REPO` y la rama base del merge.
const requiredChecks = require('../lib/required-checks');

// #5420 — Ref desde la que se carga CODEOWNERS para el gate de merge. Fija a
// `origin/main` a propósito: el head del PR podría estar modificando el propio
// CODEOWNERS para sacarse del gate, y el worktree local puede estar podado.
const OWNERS_REF = 'origin/main';

// REPO_ROOT: ubicación central donde el pulpo escribe logs/heartbeats/markers.
// Siempre apunta al checkout principal del monorepo (no al worktree del agente),
// porque el pulpo lee/escribe esos archivos desde un único lugar.
const REPO_ROOT = process.env.PIPELINE_REPO_ROOT || process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
const HOOKS_DIR = path.join(REPO_ROOT, '.claude', 'hooks');
const LOG_DIR = path.join(REPO_ROOT, '.pipeline', 'logs');

// WORK_DIR: directorio del worktree del agente — donde realmente vive la
// rama `agent/<issue>-*` y los cambios a entregar. Para fase `entrega` el
// pulpo nos spawnea con `cwd: <worktree>` (pulpo.js useExistingWorktree
// incluye 'entrega' desde #2519/#2547) y desde #2523 rev-1 además puede
// pasar PIPELINE_WORKTREE explícito.
//
// Sin esta separación, REPO_ROOT cae a `path.resolve(__dirname, '..', '..')`
// = `<monorepo>/platform` (el checkout principal compartido entre worktrees
// vía .git symlink) y todas las operaciones git corren contra la rama
// arbitraria del ROOT (típicamente `fix/dashboard-pause-optimistic-ui` o
// la sesión interactiva de Leo). Incidente real (#2523 rev-2, 2026-04-27
// 03:12 UTC):
//
//   delivery del #2523 corrió con cwd=ROOT y leyó branch=
//   `fix/dashboard-pause-optimistic-ui`, abortó con
//   `Worktree incorrecto: ... esperaba "agent/2523-"`.
//
// Mismo patrón de bug que linter.js #2523 rev-1 (ver linter.js L39-48).
const WORK_DIR = process.env.PIPELINE_WORKTREE || process.cwd() || REPO_ROOT;

const HEARTBEAT_INTERVAL_MS = 30 * 1000;

const QA_LABELS_OK = new Set(['qa:passed', 'qa:skipped']);

function parseArgs(argv) {
    const args = { issue: null, trabajando: null, autoMerge: true, dryRun: false };
    for (const a of argv.slice(2)) {
        if (/^\d+$/.test(a) && !args.issue) { args.issue = parseInt(a, 10); continue; }
        if (a === '--no-auto-merge') { args.autoMerge = false; continue; }
        if (a === '--dry-run') { args.dryRun = true; continue; }
        const kv = a.match(/^--([\w-]+)=(.+)$/);
        if (kv) {
            if (kv[1] === 'trabajando') args.trabajando = kv[2];
        }
    }
    args.issue = args.issue || (process.env.PIPELINE_ISSUE ? Number(process.env.PIPELINE_ISSUE) : null);
    args.trabajando = args.trabajando || process.env.PIPELINE_TRABAJANDO || null;
    return args;
}

function startHeartbeat(issue) {
    if (!issue) return { stop: () => {} };
    try { fs.mkdirSync(HOOKS_DIR, { recursive: true }); } catch {}
    const hbFile = path.join(HOOKS_DIR, `agent-${issue}.heartbeat`);
    const writeHb = () => {
        try {
            fs.writeFileSync(hbFile, JSON.stringify({
                issue, skill: 'delivery', pid: process.pid, model: 'deterministic',
                ts: new Date().toISOString(),
            }) + '\n');
        } catch {}
    };
    writeHb();
    const iv = setInterval(writeHb, HEARTBEAT_INTERVAL_MS);
    iv.unref?.();
    return {
        stop: () => {
            clearInterval(iv);
            try { fs.unlinkSync(hbFile); } catch {}
        },
    };
}

function readMarker(trabajandoPath) {
    if (!trabajandoPath || !fs.existsSync(trabajandoPath)) return {};
    try {
        const txt = fs.readFileSync(trabajandoPath, 'utf8');
        const out = {};
        for (const ln of txt.split(/\r?\n/)) {
            const m = ln.match(/^([\w_]+)\s*:\s*(.*)$/);
            if (!m) continue;
            let v = m[2].trim();
            if (v.startsWith('"') && v.endsWith('"')) {
                try { v = JSON.parse(v); } catch {}
            }
            out[m[1]] = v;
        }
        return out;
    } catch { return {}; }
}

function updateMarker(trabajandoPath, payload) {
    if (!trabajandoPath) return;
    try {
        let existing = '';
        if (fs.existsSync(trabajandoPath)) {
            existing = fs.readFileSync(trabajandoPath, 'utf8');
        }
        const lines = existing.split(/\r?\n/).filter(Boolean);
        const kept = [];
        for (const ln of lines) {
            const m = ln.match(/^([\w_]+)\s*:/);
            if (m && (m[1] in payload)) continue;
            kept.push(ln);
        }
        const appended = [];
        for (const [k, v] of Object.entries(payload)) {
            if (v === null || v === undefined) continue;
            const val = typeof v === 'string' ? JSON.stringify(v) : String(v);
            appended.push(`${k}: ${val}`);
        }
        fs.writeFileSync(trabajandoPath, [...kept, ...appended].join('\n') + '\n', 'utf8');
    } catch (e) {
        process.stderr.write(`[delivery] No se pudo actualizar marker: ${e.message}\n`);
    }
}

function fetchIssueTitle(issue) {
    const r = git.runGh(['issue', 'view', String(issue), '--json', 'title,labels'], { cwd: WORK_DIR });
    if (r.exit_code !== 0) return { title: null, labels: [] };
    try {
        const json = JSON.parse(r.stdout);
        return {
            title: json.title || null,
            labels: (json.labels || []).map((l) => l.name),
        };
    } catch { return { title: null, labels: [] }; }
}

// #5864 SEC-2 — Repo esperado del head de todo PR que adoptemos o etiquetemos.
// Ver `lib/pr-provenance.js` para el vector completo (repo público + patrón de
// rama predecible ⇒ un fork puede abrir un PR con la rama `agent/<issue>-…`).
const EXPECTED_PR_REPO = process.env.PIPELINE_REPO || prProvenance.DEFAULT_REPO;

/**
 * Busca el PR abierto del pipeline para `branch`.
 *
 * SEC-2: `gh pr list --head <branch>` NO filtra por owner y devuelve también
 * PRs cuyo head vive en un fork. Adoptar uno de esos como "el PR del issue"
 * haría que delivery le propague el `qa:passed` y le abra el gate de merge.
 * Por eso se descarta todo PR que no supere `checkPrProvenance`, y si no queda
 * ninguno se devuelve `null` (fail-closed): el flujo sigue por la rama de
 * "no hay PR" y crea el PR legítimo desde la rama de origin.
 */
function findExistingPR(branch, { ghImpl = git.runGh, log = () => {} } = {}) {
    const r = ghImpl(['pr', 'list', '--head', branch, '--state', 'open', '--json', prProvenance.PR_PROVENANCE_FIELDS.join(',')], { cwd: WORK_DIR });
    if (!r || r.exit_code !== 0) return null;
    let arr;
    try { arr = JSON.parse(r.stdout); } catch { return null; }
    if (!Array.isArray(arr) || !arr.length) return null;

    const own = [];
    for (const p of arr) {
        const prov = prProvenance.checkPrProvenance(p, { branch, repo: EXPECTED_PR_REPO });
        if (prov.ok) { own.push(p); continue; }
        log(`[delivery] PR #${(p && p.number) || '?'} descartado por procedencia (${prov.reason}${prov.detail ? `: ${prov.detail}` : ''})`
            + ` — no se adopta como PR del issue ni recibe labels de gate`);
    }
    if (!own.length) return null;

    const chosen = own[0];
    return {
        number: chosen.number,
        url: chosen.url,
        labels: (chosen.labels || []).map((l) => l.name),
    };
}

/**
 * Lee del PR destino, en UNA sola llamada, los labels frescos y los datos de
 * procedencia. Devuelve `null` ante cualquier problema (fail-closed: sin datos
 * no se escribe el label).
 */
function fetchPrForGateWrite(prNumber, { ghImpl = git.runGh } = {}) {
    const r = ghImpl(['pr', 'view', String(prNumber), '--json', prProvenance.PR_PROVENANCE_FIELDS.join(',')], { cwd: WORK_DIR });
    if (!r || r.exit_code !== 0) return null;
    try {
        const j = JSON.parse(r.stdout);
        return (j && typeof j === 'object' && !Array.isArray(j)) ? j : null;
    } catch { return null; }
}

function getPRLabels(prNumber, { ghImpl = git.runGh } = {}) {
    const r = ghImpl(['pr', 'view', String(prNumber), '--json', 'labels'], { cwd: WORK_DIR });
    if (r.exit_code !== 0) return [];
    try {
        return (JSON.parse(r.stdout).labels || []).map((l) => l.name);
    } catch { return []; }
}

function hasQaGate(labels) {
    return labels.some((l) => QA_LABELS_OK.has(l));
}

// ============================================================================
// #5864 — Propagación del label de gate QA issue → PR.
// ============================================================================
//
// El ciclo de QA aplica el label sobre el ISSUE (`gate-label-reconciler.js` es
// su dueño único desde #4572) y el gate previo al merge lo busca en el PR
// (`hasQaGate(snapshot.labels)`, Fase 5). Ese tramo nunca se cerraba: los PRs
// #5519 / #5788 / #5790 tenían el ciclo de QA completo con `qa:passed` en el
// issue, nacían con `needs-definition` y quedaban frenados hasta que un humano
// copiaba el label a mano.
//
// Se implementa ACÁ, y no en GATE 0 del pulpo ni en el CLI manual
// `.pipeline/delivery.js`, porque este es el único punto del runtime donde el
// PR ya existe y todavía no se mergeó:
//   - GATE 0 corre en la promoción `verificacion → linteo`; el PR lo crea esta
//     misma fase `entrega`, varias fases después. Ahí el PR no existe todavía.
//   - `.pipeline/delivery.js` es el CLI manual (#2870). El provider
//     determinístico resuelve `skills-deterministicos/<skill>.js`, así que ese
//     archivo NO se ejecuta en la fase `entrega`.
//
// Reglas (fail-closed, nunca relaja el gate):
//   - SEC-1: el vínculo issue↔PR lo establece la RAMA (`agent/<issue>-…`),
//     jamás el `Closes #<n>` del cuerpo (lo escribe quien abre el PR).
//   - SEC-2: ante ausencia o conflicto de labels de gate en el issue no se
//     escribe nada. Nunca se infiere aprobación por falta de datos.
//   - SEC-3: unidireccional. El issue es la única autoridad; el PR es destino
//     y jamás origen.
//   - CA-4: el estado proyectado del PR pasa por `assertMutualExclusion`, así
//     que es imposible dejarlo con `qa:passed` + `qa:failed`.

// Universo de labels de gate que pueden vivir en el PR. Incluye `qa:skipped`
// (CA-1 lo nombra explícitamente y el gate de Fase 5 ya lo acepta), que el
// reconciliador NO conoce a propósito — ampliarle `GATE_LABELS` es #5869.
const QA_GATE_LABELS = ['qa:passed', 'qa:skipped', 'qa:failed', 'qa:pending'];
// Labels que MANTIENEN cerrado el gate. Si el issue tiene uno de estos, se
// propaga igual: propagar la verdad negativa es correcto y no destraba nada.
const QA_GATE_BLOCKING = new Set(['qa:failed', 'qa:pending']);

/**
 * Decide (función PURA, sin gh ni fs) qué labels de gate escribir en el PR.
 *
 * @returns {{ok:false, reason:string, labels?:string[], branch?:string}
 *          |{ok:true, target:string, toAdd:string[], toRemove:string[]}}
 */
function buildPrGatePropagation({ issue, prNumber, branch, issueLabels, prLabels, prHead } = {}) {
    const issueNum = parseInt(issue, 10);
    if (!Number.isInteger(issueNum) || issueNum <= 0) return { ok: false, reason: 'sin_issue' };
    const pr = parseInt(prNumber, 10);
    if (!Number.isInteger(pr) || pr <= 0) return { ok: false, reason: 'pr_no_resuelto' };

    // SEC-1 — resolución estricta por rama. `agent/5864-…` NO matchea el issue
    // 586 ni el 58640: el separador `-` es parte del prefijo exigido.
    if (typeof branch !== 'string' || !branch.startsWith(`agent/${issueNum}-`)) {
        return { ok: false, reason: 'rama_no_corresponde_al_issue', branch: branch || null };
    }

    // SEC-2 — procedencia del PR DESTINO. El chequeo de arriba valida la rama
    // LOCAL; éste valida el PR sobre el que realmente se va a escribir. Sin él,
    // un PR abierto desde un fork con la rama `agent/<issue>-<skill>` recibiría
    // el `qa:passed` del issue y con eso pasaría el gate de merge (que audita
    // la rama de origin, no el head del fork, y mergea el SHA del fork).
    // Fail-closed: si no hay datos de procedencia, no se escribe nada.
    const prov = prProvenance.checkPrProvenance(prHead, { branch, repo: EXPECTED_PR_REPO });
    if (!prov.ok) {
        return { ok: false, reason: prov.reason, detail: prov.detail || null, prNumber: pr };
    }
    // El PR consultado tiene que ser el mismo que vamos a editar: si `gh` nos
    // devolvió otro número, la referencia no es confiable.
    if (prHead.number !== undefined && parseInt(prHead.number, 10) !== pr) {
        return { ok: false, reason: 'procedencia_desconocida', detail: `pr consultado #${prHead.number} ≠ destino #${pr}` };
    }

    const norm = (list) => [...new Set(
        (Array.isArray(list) ? list : [])
            .map((l) => ((l && typeof l === 'object' && l.name) ? String(l.name) : String(l))),
    )];
    const issueGates = norm(issueLabels).filter((l) => QA_GATE_LABELS.includes(l));
    const currentPr = norm(prLabels);

    if (issueGates.length === 0) return { ok: false, reason: 'issue_sin_label_de_gate' };

    // Precedencia determinística. Un issue con señal negativa Y positiva a la
    // vez es un estado incoherente: no se toca el PR (SEC-2).
    const blocking = issueGates.filter((l) => QA_GATE_BLOCKING.has(l));
    const passing = issueGates.filter((l) => QA_LABELS_OK.has(l));
    if (blocking.length > 1 || (blocking.length > 0 && passing.length > 0)) {
        return { ok: false, reason: 'labels_de_gate_en_conflicto', labels: issueGates };
    }
    const target = blocking.length === 1
        ? blocking[0]
        : (passing.includes('qa:passed') ? 'qa:passed' : 'qa:skipped');

    const toRemove = QA_GATE_LABELS.filter((l) => l !== target && currentPr.includes(l));
    const toAdd = currentPr.includes(target) ? [] : [target];

    // CA-4 / SEC-R4 — el guard del dueño único corre sobre el estado proyectado
    // DEL PR (SEC-4: labels del PR, nunca los del issue).
    const projected = new Set(currentPr);
    for (const l of toRemove) projected.delete(l);
    for (const l of toAdd) projected.add(l);
    gateLabelReconciler.assertMutualExclusion(projected, { target, toAdd, toRemove });

    if (toAdd.length === 0 && toRemove.length === 0) {
        return { ok: false, reason: 'pr_ya_reconciliado', labels: [target] };
    }
    return { ok: true, target, toAdd, toRemove };
}

/**
 * Aplica la propagación contra GitHub. NUNCA es fatal: si falla, el PR queda
 * sin el label y la Fase 5 bloquea fail-closed, que es el comportamiento
 * correcto. Devuelve los labels efectivamente aplicados (o `[]`).
 */
function propagateGateLabelToPr({ issue, prNumber, branch, issueLabels, log = () => {}, ghImpl = git.runGh } = {}) {
    let decision;
    try {
        // Una sola consulta trae labels FRESCOS (SEC-4: los del PR, nunca los
        // del issue) y los datos de procedencia (SEC-2), leídos acá mismo para
        // minimizar la ventana TOCTOU contra el `gh pr edit`.
        const prHead = fetchPrForGateWrite(prNumber, { ghImpl });
        const prLabels = (prHead && Array.isArray(prHead.labels))
            ? prHead.labels.map((l) => ((l && l.name) ? l.name : String(l)))
            : [];
        decision = buildPrGatePropagation({ issue, prNumber, branch, issueLabels, prLabels, prHead });
    } catch (e) {
        log(`[delivery] gate QA issue→PR: no se propaga (${(e && e.message || '').slice(0, 200)})`);
        return [];
    }
    if (!decision.ok) {
        log(`[delivery] gate QA issue→PR: no se propaga al PR #${prNumber} (${decision.reason})`);
        return [];
    }
    // Un solo `gh pr edit` con removes + add: GitHub lo aplica como una única
    // edición, así que no existe ventana con `qa:passed` y `qa:failed` juntos.
    const editArgs = ['pr', 'edit', String(prNumber)];
    for (const l of decision.toRemove) editArgs.push('--remove-label', l);
    for (const l of decision.toAdd) editArgs.push('--add-label', l);
    let res;
    try {
        res = ghImpl(editArgs, { cwd: WORK_DIR, timeoutMs: 60 * 1000 });
    } catch (e) {
        log(`[delivery] gate QA issue→PR: gh pr edit lanzó excepción (${(e && e.message || '').slice(0, 200)})`);
        return [];
    }
    if (!res || res.exit_code !== 0) {
        const err = ((res && (res.stderr || res.stdout)) || '').slice(0, 200);
        log(`[delivery] gate QA issue→PR: gh pr edit falló (${err || 'sin stderr'}) — el gate sigue cerrado`);
        return [];
    }
    log(`[delivery] gate QA issue→PR: PR #${prNumber} → ${decision.target}`
        + (decision.toRemove.length ? ` (quitados: ${decision.toRemove.join(',')})` : '')
        + ` [desde el issue #${issue}]`);
    return decision.toAdd;
}

function getPRChangedPaths(prNumber) {
    const r = git.runGh(['pr', 'view', String(prNumber), '--json', 'files'], { cwd: WORK_DIR });
    if (r.exit_code !== 0) return [];
    try {
        return (JSON.parse(r.stdout).files || []).map((f) => f.path);
    } catch { return []; }
}

// ============================================================================
// #5420 — Snapshot único del PR para el gate crítico de merge.
// ============================================================================
//
// Antes, el gate leía labels (`getPRLabels`) y paths (`getPRChangedPaths`) en
// llamadas separadas, y el PUT de merge no fijaba ningún SHA. Eso deja una
// ventana TOCTOU: entre "leí los labels" y "mergeé" el head del PR puede
// moverse, y se termina mergeando un árbol que NUNCA pasó los gates.
//
// `getPRSnapshot` toma labels, files, rama y SHA del head en UNA sola llamada.
// Ese snapshot es la única fuente de verdad del intento: los gates se evalúan
// sobre él y el PUT viaja con `sha=<headRefOid>` del mismo snapshot.
//
// Fail-closed en todos los bordes: gh que falla, JSON inválido, head sin SHA o
// sin rama, y PR sin archivos → `{ ok:false, reason }`. NUNCA se degrada a
// listas vacías (una lista de archivos vacía haría que CODEOWNERS no matchee
// nada y el PR pase como "sin owners humanos").
//
// #6012 CA-1 — El estado de mergeabilidad (`mergeable`, `mergeStateStatus`,
// `state`) se lee en LA MISMA llamada que los gates. No se agrega una lectura
// separada a propósito: una segunda llamada reabriría la ventana TOCTOU que
// #5420 cerró (leí el estado → alguien pushea → mergeo con el estado viejo).

// Enums cerrados de la API de GitHub. Cualquier valor fuera de la lista se
// normaliza a `null` — ver `normalizeMergeState`.
// #6431 SEC-11/A-R9 — La rama base del merge es una CONSTANTE del codigo, no
// un dato leido del PR. `fetchRequiredContexts` la interpola en el path de
// `rules/branches/<branch>`, y usar ahi `snapshot.headRefName` (texto que
// controla quien abre el PR) permitiria leer las reglas de OTRO recurso.
const MERGE_BASE_BRANCH = 'main';

const MERGE_STATE_VALUES = new Set([
    'BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE',
]);
const PR_STATE_VALUES = new Set(['OPEN', 'CLOSED', 'MERGED']);
const MERGEABLE_VALUES = new Set(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
// #6431 D-E - Enum cerrado de `reviewDecision`. `''` (lo que devuelve
// `gh pr view --json` cuando no hay review requerida) y `null` (lo que
// devuelve GraphQL) normalizan los dos a `null`, y ese `null` NO significa
// "no lei": quien codifica la distincion leido/no-leido es el flag
// estructural `reviewDecisionRead`, jamas el valor. Usar el valor como
// senal de lectura es exactamente el defecto que D-E documenta.
const REVIEW_DECISION_VALUES = new Set(['REVIEW_REQUIRED', 'CHANGES_REQUESTED', 'APPROVED']);

// #6012 CA-1/CA-4 — Normalizador PURO del estado de mergeabilidad.
//
// Por qué `null` y no `{ok:false}`: si GitHub omite (o renombra) uno de estos
// campos, un `ok:false` bloquearía TODA entrega, no sólo el caso del 405 — el
// blast radius sería el pipeline entero. El fail-closed correcto acá es
// devolver `null` ("no tengo señal") y dejar que el clasificador caiga en su
// default terminal: `null` NUNCA habilita el reintento, sólo un `'UNKNOWN'`
// explícito del servidor lo hace. Los campos duros (headRefOid, headRefName,
// files) mantienen su `ok:false` — ahí la ausencia sí es lectura degradada.
function normalizeMergeState(parsed = {}) {
    const pick = (value, allowed) => {
        const v = typeof value === 'string' ? value.trim().toUpperCase() : '';
        return allowed.has(v) ? v : null;
    };
    const src = (parsed && typeof parsed === 'object') ? parsed : {};
    return {
        mergeStateStatus: pick(src.mergeStateStatus, MERGE_STATE_VALUES),
        state: pick(src.state, PR_STATE_VALUES),
        mergeable: pick(src.mergeable, MERGEABLE_VALUES),
        reviewDecision: pick(src.reviewDecision, REVIEW_DECISION_VALUES),
    };
}

// Campos del snapshot, en ESCALERA de 3 niveles (#6431 R8/G7).
//
// Antes eran dos y el fallback era todo-o-nada: un `gh` que no conociera UN
// campo nuevo se caia al set legacy y apagaba de golpe `mergeStateStatus`
// (#6012) Y `statusCheckRollup` (#6384) Y `reviewDecision` (#6431). O sea: un
// binario viejo desactivaba en silencio tres fixes de una. Con la escalera, cada
// nivel cede SOLO lo que el `gh` no entiende.
const SNAPSHOT_FIELDS = 'labels,files,headRefOid,headRefName,mergeable,mergeStateStatus,state,statusCheckRollup,reviewDecision';
const SNAPSHOT_FIELDS_6012 = 'labels,files,headRefOid,headRefName,mergeable,mergeStateStatus,state,statusCheckRollup';
const SNAPSHOT_FIELDS_LEGACY = 'labels,files,headRefOid,headRefName';

function getPRSnapshot(prNumber, { ghImpl = git.runGh, cwd = WORK_DIR, logAppend } = {}) {
    const log = typeof logAppend === 'function' ? logAppend : () => {};
    const view = (fields) => ghImpl(
        ['pr', 'view', String(prNumber), '--json', fields],
        { cwd, timeoutMs: 60 * 1000 },
    );
    let res;
    let nivel = 1;
    // #6012 — Degradación explícita: un `gh` viejo que no conozca alguno de los
    // campos nuevos sale != 0 con "Unknown JSON field". Sin fallback, ese `gh`
    // bloquearía TODAS las entregas (riesgo ALTO identificado por el arquitecto).
    //
    // #6431 R8/G7 — La degradación es DIRIGIDA, no ciega. `gh` dice EN EL ERROR
    // qué campo no conoce, así que se salta directo al nivel que lo suelta en
    // vez de bajar peldaño por peldaño:
    //   - no conoce `reviewDecision`  → nivel 2 (conserva #6012 y #6384);
    //   - no conoce `mergeStateStatus`/`statusCheckRollup` → nivel 3 directo.
    // Antes de esto el fallback era todo-o-nada: un `gh` que no entendiera UN
    // campo apagaba de golpe tres fixes. Y bajar de a un peldaño gastaría una
    // llamada de más contra un binario que ya sabemos que no soporta el nivel 2.
    const campoDesconocido = (r) => {
        if (!r || r.exit_code === 0) return null;
        const texto = `${r.stderr || ''}\n${r.stdout || ''}`;
        if (!/unknown\s+json\s+field/i.test(texto)) return null;
        const m = texto.match(/unknown\s+json\s+field:?\s*"?([A-Za-z]+)"?/i);
        return (m && m[1]) || 'desconocido';
    };
    try {
        res = view(SNAPSHOT_FIELDS);
        // #6431 CA-UX-5 — La degradación NUNCA es muda. Sin estos logs, un `gh`
        // viejo apaga el fix en silencio y nadie se entera de por qué volvieron
        // los `needs-human`.
        let campo = campoDesconocido(res);
        if (campo && /^reviewDecision$/i.test(campo)) {
            nivel = 2;
            log('[delivery] gate merge: snapshot degradado a nivel 2 (sin reviewDecision) — la review no se puede leer, la rama BLOCKED escala fail-closed; #6012 y #6384 siguen activos');
            res = view(SNAPSHOT_FIELDS_6012);
            campo = campoDesconocido(res);
        }
        if (campo) {
            nivel = 3;
            log(`[delivery] gate merge: snapshot degradado a nivel 3 (el gh instalado no conoce ${codeowners.sanitizeRefReason(campo, 40)}) — clasificación de checks deshabilitada, comportamiento previo a #6012`);
            res = view(SNAPSHOT_FIELDS_LEGACY);
        }
    } catch (e) {
        return { ok: false, reason: `gh pr view lanzó excepción: ${codeowners.sanitizeRefReason(e && e.message, 120)}` };
    }
    if (!res || typeof res !== 'object') {
        return { ok: false, reason: 'gh pr view sin resultado' };
    }
    if (res.exit_code !== 0) {
        const detail = codeowners.sanitizeRefReason(res.stderr || res.stdout, 160);
        return { ok: false, reason: `gh pr view exit=${res.exit_code}${detail ? `: ${detail}` : ''}` };
    }
    let parsed;
    try {
        parsed = JSON.parse(res.stdout);
    } catch {
        return { ok: false, reason: 'gh pr view devolvió JSON inválido' };
    }
    if (!parsed || typeof parsed !== 'object') {
        return { ok: false, reason: 'gh pr view devolvió un JSON que no es objeto' };
    }

    const headRefOid = typeof parsed.headRefOid === 'string' ? parsed.headRefOid.trim() : '';
    const headRefName = typeof parsed.headRefName === 'string' ? parsed.headRefName.trim() : '';
    if (!/^[0-9a-f]{7,40}$/i.test(headRefOid)) {
        return { ok: false, reason: 'headRefOid ausente o con formato inesperado' };
    }
    if (!headRefName) {
        return { ok: false, reason: 'headRefName ausente' };
    }

    const labels = Array.isArray(parsed.labels)
        ? parsed.labels.map((l) => (l && typeof l.name === 'string' ? l.name : null)).filter(Boolean)
        : [];
    const files = Array.isArray(parsed.files)
        ? parsed.files.map((f) => (f && typeof f.path === 'string' ? f.path : null)).filter(Boolean)
        : [];
    // Un PR SIEMPRE toca archivos: una lista vacía es una lectura degradada, no
    // un PR inocuo. Tratarla como "no matchea CODEOWNERS" sería fail-open.
    if (!files.length) {
        return { ok: false, reason: 'gh pr view no devolvió archivos del PR (lectura degradada)' };
    }

    return {
        ok: true, labels, files, headRefOid, headRefName,
        // #6384/#6431 — Disciplina de dos valores: `null` = "no lo leí" (el `gh`
        // no conoce el campo, o degradamos de nivel), `[]` = "lo leí y está
        // vacío" (el commit todavía no tiene ningún check instanciado: la
        // ventana ciega exacta del episodio). Colapsarlos haría que el pre-check
        // de #6431 dispare sobre snapshots degradados, que es lo contrario de
        // lo que queremos.
        statusCheckRollup: Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : null,
        // #6431 D-E — Flag ESTRUCTURAL de lectura. Sólo el nivel 1 de la
        // escalera trae `reviewDecision`; en los niveles 2 y 3 el campo ni
        // siquiera se pidió, así que su ausencia no dice NADA sobre la review —
        // y leerla como "no hay review pendiente" sería reportar un "faltan
        // aprobaciones" real como carrera de CI (A-R12).
        reviewDecisionRead: nivel === 1,
        snapshotFieldsLevel: nivel,
        ...normalizeMergeState(parsed),
    };
}

// #6431 — Fabrica del lector de checks requeridos, aislada para que el test de
// wiring pueda verificar que produccion la usa. `baseBranch` sale de la
// constante del merge (SEC-11) y `repo` de `EXPECTED_PR_REPO`, nunca de un
// campo devuelto por GitHub.
function buildRequiredChecksReader({ cwd = WORK_DIR, repo = EXPECTED_PR_REPO, baseBranch = MERGE_BASE_BRANCH } = {}) {
    return requiredChecks.createRequiredChecksReader({ cwd, repo, baseBranch });
}

function applyNeedsHumanLabel(issue, prNumber, owners, repoRoot) {
    const lbl = git.runGh(
        ['issue', 'edit', String(issue), '--add-label', 'needs-human'],
        { cwd: repoRoot, timeoutMs: 30 * 1000 }
    );
    const ownersList = owners.join(' ');
    const body = `🛑 Merge bloqueado — este PR toca paths con CODEOWNERS humano (${ownersList}). Requiere review manual antes de mergear.`;
    const cmt = git.runGh(
        ['pr', 'comment', String(prNumber), '--body', body],
        { cwd: repoRoot, timeoutMs: 30 * 1000 }
    );
    return { labelExitCode: lbl.exit_code, commentExitCode: cmt.exit_code };
}

function tmpFile(prefix, content) {
    const file = path.join(LOG_DIR, `${prefix}-${process.pid}-${Date.now()}.tmp`);
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
    fs.writeFileSync(file, content, 'utf8');
    return file;
}

// ============================================================================
// #4658 — Detección de conflicto de merge REAL y escalado fail-closed.
// ============================================================================

// classifyMergeFailure — decisión PURA sobre el outcome de `gh api .../merge`.
// Separada de main() para testearse sin invocar gh. La API REST de GitHub
// devuelve, ante integración no-limpia:
//   - 405 (Method Not Allowed) → "Pull Request is not mergeable" (conflicto real).
//   - 409 (Conflict)           → "Head branch was modified" / merge conflict.
// Ese caso NO es un fallo de infra ni un rebote técnico: es un conflicto de
// merge genuino que debe ESCALAR al operador (no rebotar a dev en loop). Todo
// otro exit_code != 0 (red, auth, timeout, 5xx) sigue siendo rebote técnico.
//
// #5420 — Con el `sha` pinneado en el PUT (ver `attemptMergeWithGates`), el 409
// deja de ser un único caso: GitHub responde 409 tanto ante un conflicto real
// como cuando el head se movió entre la lectura de los gates y el merge. Ese
// segundo caso NO es "no mergeable": es exactamente la protección funcionando,
// y corresponde REINTENTAR con un snapshot nuevo (reevaluando todos los gates),
// no escalar al operador. Se distingue por el mensaje, no por el status pelado:
// un 409 ambiguo se mantiene como conflicto terminal (fail-closed).
//
// #6012 — El 405 dejaba de ser ambiguo sólo en apariencia. GitHub también lo
// devuelve mientras TODAVÍA ESTÁ CALCULANDO la mergeabilidad del PR recién
// creado (`mergeStateStatus: UNKNOWN`), y ahí no hay ningún conflicto: es una
// condición transitoria que el propio pipeline resuelve esperando. Tomarla como
// conflicto convertía una entrega sana en un `needs-human` permanente (PRs
// #6010 / #6011, mergeados después sin un solo cambio de código).
//
// La señal autoritativa NO es el status HTTP pelado ni `mergeable`: es
// `mergeStateStatus` + `statusCheckRollup`, que distinguen estos cinco casos:
//
//   UNKNOWN  → GitHub está calculando       → transitorio, se espera y reintenta
//   DIRTY    → conflicto CONFIRMADO         → escala al operador
//   BLOCKED + checks pending                → transitorio, se espera y reintenta
//   BLOCKED + checks failing/green/unknown  → escala, JAMÁS reintenta
//   DRAFT    → PR en borrador               → escala, JAMÁS reintenta
//   null/otro→ sin señal                    → default fail-closed (= hoy)
//
// BLOCKED sólo entra al reintento con checks pendientes explícitos y techo
// temporal. Checks rojos, verdes o ilegibles mantienen el fail-closed, evitando
// un bucle silencioso que esconda "faltan aprobaciones" (OWASP A04). DRAFT jamás
// reintenta. `mergeable` NO se usa para decidir: con branch
// protection frenando el merge vale `MERGEABLE`, así que clasificar por él
// mandaría un control activo al camino transitorio.
//
// `ctx` ausente o incompleto ⇒ comportamiento idéntico al previo a #6012:
// 405 = conflicto terminal, no reintentable. El default fail-closed no se
// relaja (CA-4).
//
// Shape: { conflict, retryable, kind, httpStatus, confirmed, reason }.
//   kind: 'ok' | 'head-changed' | 'not-mergeable' | 'mergeability-unknown'
//       | 'checks-in-flight' | 'gate-block' | 'generic'
function classifyMergeFailure(res = {}, ctx = {}) {
    if (!res || res.exit_code === 0) {
        return { conflict: false, retryable: false, kind: 'ok', httpStatus: null, reason: 'ok' };
    }
    const text = `${res.stderr || ''}\n${res.stdout || ''}`;
    const httpMatch = text.match(/\bHTTP\s+(\d{3})\b/i);
    const httpStatus = httpMatch ? parseInt(httpMatch[1], 10) : null;

    const notMergeableText = /\bnot\s+mergeable\b/i.test(text) || /\bmerge\s+conflict\b/i.test(text);
    // Señales de "el head se movió": mensaje canónico de GitHub ante `sha` viejo.
    const headChangedText = !notMergeableText && (
        /\bhead\s+branch\s+was\s+modified\b/i.test(text)
        || /\bbase\s+branch\s+was\s+modified\b/i.test(text)
        || /\bhead\s+(?:branch\s+)?sha\b[^\n]*\b(?:did\s+not|does\s+not|doesn't)\s+match\b/i.test(text)
    );
    if (headChangedText) {
        return {
            conflict: true,
            retryable: true,
            kind: 'head-changed',
            httpStatus,
            reason: httpStatus ? `http_${httpStatus}_head_changed` : 'head_changed_text',
        };
    }

    // 405/409 son las señales autoritativas de "no mergeable" del merge squash.
    if (httpStatus === 405 || httpStatus === 409) {
        const mergeState = normalizeMergeState(ctx).mergeStateStatus;
        // El 409 NO se reclasifica: su semántica canónica es "head branch was
        // modified" y ya tiene su propio camino (#5420, arriba). Sólo el 405
        // admite lectura transitoria, y sólo con UNKNOWN explícito del servidor.
        if (httpStatus === 405 && mergeState === 'UNKNOWN') {
            return {
                conflict: false, retryable: true, kind: 'mergeability-unknown',
                httpStatus, confirmed: false, reason: 'http_405_mergeability_unknown',
            };
        }
        if (mergeState === 'BLOCKED') {
            // #6431 A-4 — `ctx.requiredChecks` es el veredicto YA calculado por
            // `lib/required-checks.js` (las lecturas impuras viven en
            // `attemptMergeWithGates`; esta funcion sigue siendo pura y sincrona).
            //
            // Presente => decide EN EXCLUSIVA. `classifyChecks` NO se consulta:
            // dos clasificadores para la misma rama es el defecto que G3 marco,
            // y la forma en que se manifiesta es concreta — con el rollup
            // poblado, `classifyChecks` cortaria antes y el cotejo de app
            // (SEC-2, el control de seguridad entero) se saltearia.
            //
            // Ausente => camino legacy de #6384, byte por byte. Eso es lo que
            // mantiene `delivery-merge-6347.test.js` verde sin tocarlo (T19) y
            // la suite sin red (el reader tiene default `null`, A-2).
            const rc = ctx.requiredChecks;
            if (!rc || typeof rc !== 'object' || typeof rc.verdict !== 'string') {
                // #6599 - si el ctx trae la lista de requeridos, el camino legacy
                // tampoco pesa checks sin poder de veto. Sin lista, `classifyChecks`
                // se comporta EXACTAMENTE como antes (fail-closed, CA-5).
                const checks = classifyChecks(ctx.statusCheckRollup, {
                    requiredContexts: ctx.requiredContexts,
                    requiredContextsRead: ctx.requiredContextsRead,
                });
                if (checks.state === 'pending') {
                    return {
                        conflict: false, retryable: true, kind: 'checks-in-flight',
                        httpStatus, confirmed: false, checks, blockedByRuleset: true,
                        reason: 'required_checks_in_flight',
                    };
                }
                return {
                    conflict: false, retryable: false, kind: 'gate-block', httpStatus, confirmed: false,
                    gate: checks.state === 'failing' ? 'checks-failing' : 'branch-protection',
                    checks, blockedByRuleset: true,
                    reason: `http_${httpStatus}_blocked_checks_${checks.state}`,
                };
            }

            const gateBlock = (gate, reason) => ({
                conflict: false, retryable: false, kind: 'gate-block', httpStatus, confirmed: false,
                gate, requiredChecks: rc, reason,
            });

            // ORDEN ESTRICTO (3.c). La review se evalua ANTES que los checks, y
            // la LECTURA de la review antes que su valor.
            //
            // (1) CA-10/A-R12 — Si `reviewDecision` no se pudo leer (escalera
            //     degradada a nivel 2 o 3), un "faltan aprobaciones" real es
            //     indistinguible de "no hay review pendiente". Sin lectura no se
            //     entra JAMAS al camino transitorio.
            if (ctx.reviewDecisionRead !== true) {
                return gateBlock('branch-protection-unreadable', `http_${httpStatus}_blocked_review_no_leida`);
            }
            // (2) CA-4 — Una review faltante escala aunque haya checks pendientes:
            //     esperar por la CI no va a hacer aparecer una aprobacion humana.
            const reviewDecision = normalizeMergeState(ctx).reviewDecision;
            if (reviewDecision === 'REVIEW_REQUIRED' || reviewDecision === 'CHANGES_REQUESTED') {
                return gateBlock('branch-protection-review', `http_${httpStatus}_blocked_review_${reviewDecision.toLowerCase()}`);
            }
            // (3) A-R6/CA-20 — No se pudo evaluar el requerido (ruleset ilegible,
            //     truncamiento, homonimo de otra app, estado fuera del enum, head
            //     movido). Fail-closed con la causa, nunca un gate-block mudo.
            if (rc.verdict === 'unusable') {
                return gateBlock('branch-protection-unreadable', `http_${httpStatus}_blocked_requeridos_${rc.cause || 'ilegibles'}`);
            }
            // (4) Un requerido en rojo. Esperar no lo va a poner en verde.
            if (rc.verdict === 'blocking') {
                return gateBlock('branch-protection-checks-red', `http_${httpStatus}_blocked_check_en_rojo`);
            }
            // (5) EL DELTA DE #6431. Un requerido que todavia no reporto: es una
            //     carrera con la CI, no un control ejerciendose. El `kind` y el
            //     `reason` conservan el nombre de #6384 a proposito — cambia la
            //     implementacion, no el contrato (D-B/G3); renombrarlos obligaria
            //     a editar `delivery-merge-6347.test.js`, que T19 prohibe.
            if (rc.verdict === 'pending') {
                return {
                    conflict: false, retryable: true, kind: 'checks-in-flight',
                    httpStatus, confirmed: false, requiredChecks: rc,
                    reason: 'required_checks_in_flight',
                };
            }
            // (6) CA-5 — TODOS los requeridos en verde y GitHub igual dice
            //     BLOCKED => hay OTRO control ejerciendose que no deja rastro en
            //     el rollup. Verificados tres activos en `main`:
            //     `required_review_thread_resolution`,
            //     `require_extra_approval_for_unattributed_changes` y
            //     `copilot_code_review`. Nunca cae al camino transitorio.
            if (rc.verdict === 'green') {
                return gateBlock('branch-protection-other', `http_${httpStatus}_blocked_requeridos_verdes`);
            }
            // Veredicto desconocido (el enum crecio y esta funcion no se
            // actualizo): fail-closed, jamas "asumo que se puede esperar".
            return gateBlock('branch-protection-unreadable', `http_${httpStatus}_blocked_veredicto_desconocido`);
        }
        if (mergeState === 'DRAFT') {
            return {
                conflict: false, retryable: false, kind: 'gate-block', httpStatus, confirmed: false,
                gate: 'pr-draft',
                reason: `http_${httpStatus}_${mergeState.toLowerCase()}`,
            };
        }
        // DIRTY = conflicto CONFIRMADO. `null` / cualquier otro estado = default
        // fail-closed: conflicto terminal igual que hoy, pero marcado
        // `confirmed:false` para que el log y el texto al operador no afirmen un
        // conflicto que nadie verificó (CA-9 / CA-UX-1).
        return {
            conflict: true, retryable: false, kind: 'not-mergeable', httpStatus,
            confirmed: mergeState === 'DIRTY', reason: `http_${httpStatus}`,
        };
    }
    // Defensa textual: gh puede envolver el status en el cuerpo del error.
    // `confirmed:false` — la detección es por texto, no por estado del servidor.
    if (notMergeableText) {
        return { conflict: true, retryable: false, kind: 'not-mergeable', httpStatus, confirmed: false, reason: 'not_mergeable_text' };
    }
    return { conflict: false, retryable: false, kind: 'generic', httpStatus, reason: 'generic_error' };
}

// #5420 — Confirmación ESTRICTA del PUT de merge. Un exit_code 0 no alcanza:
// la respuesta tiene que ser JSON válido con `merged === true`. Cualquier otra
// cosa (no-JSON, `merged:false`, campo ausente) es fallo — no habilita el DELETE
// de la rama, no registra SHA y no omite la escalada a `needs-human`.
//
// `transportOk` distingue "la llamada HTTP salió bien pero el merge no ocurrió"
// (no reintentable: no es un problema de SHA ni de red) de "la llamada falló"
// (que sí pasa por `classifyMergeFailure`).
function confirmMergeResponse(res = {}) {
    if (!res || typeof res !== 'object' || res.exit_code !== 0) {
        return { ok: false, transportOk: false, sha: null, reason: 'gh api merge terminó con error' };
    }
    let parsed;
    try {
        parsed = JSON.parse(res.stdout);
    } catch {
        return { ok: false, transportOk: true, sha: null, reason: 'respuesta del merge no es JSON válido' };
    }
    if (!parsed || typeof parsed !== 'object') {
        return { ok: false, transportOk: true, sha: null, reason: 'respuesta del merge no es un objeto JSON' };
    }
    if (parsed.merged !== true) {
        return {
            ok: false,
            transportOk: true,
            sha: null,
            reason: `respuesta del merge sin merged:true (merged=${JSON.stringify(parsed.merged)})`,
        };
    }
    const sha = typeof parsed.sha === 'string' && parsed.sha.trim() ? parsed.sha.trim() : null;
    return { ok: true, transportOk: true, sha, reason: 'merged' };
}

// Máximo de intentos del gate de merge. 2 = el intento original + UN reintento
// ante head movido. No más: reintentar en loop contra un head que se mueve solo
// quema cuota y esconde un problema real.
const MAX_MERGE_ATTEMPTS = 2;

// #6012 CA-8 — Presupuesto SEPARADO para la espera de mergeabilidad. No comparte
// contador con MAX_MERGE_ATTEMPTS a propósito: si la espera del 405 consumiera
// el único reintento de `head-changed`, un head que se mueve después escalaría
// de más (hallazgo BAJO de security).
const MAX_MERGEABILITY_WAITS = 6;
// Backoff acotado: 1+2+4+8+8+8 = 31 s de techo TOTAL por invocación (no por
// intento). Queda muy por debajo del timeoutMs de 3 min del propio PUT.
const MERGEABILITY_BACKOFF_MS = [1000, 2000, 4000, 8000, 8000, 8000];
const DEFAULT_MERGE_CHECKS_TIMEOUT_MS = 6 * 60 * 1000;
// #6431 D-C — Backoff propio del camino de checks requeridos. Los valores
// arrancan CORTOS a proposito: el episodio se resolvia en 19 segundos, y el
// backoff viejo ([15s, 30s, 60s]) gastaba la primera espera entera en una
// ventana que ya se habia cerrado. Suma ~104 s de techo total por invocacion.
const CHECKS_BACKOFF_MS = [2000, 4000, 8000, 15000, 15000, 30000, 30000];
// #6431 CA-15 — Presupuesto DURO de esperas por checks, en enteros. La
// terminacion del bucle deja de depender del wall-clock: con
// `mergeChecksTimeoutMs: Infinity` el loop igual termina aca. Es el cuarto
// presupuesto independiente, junto a MAX_MERGE_ATTEMPTS, MAX_MERGEABILITY_WAITS
// y el propio `mergeChecksTimeoutMs`.
const MAX_CHECKS_WAITS = 7;

function loadMergeChecksTimeoutMs() {
    try {
        const config = require('../lib/config-resolver').resolve({
            pipelineDir: path.join(WORK_DIR, '.pipeline'),
        });
        const value = config && config.delivery && Number(config.delivery.merge_checks_timeout_ms);
        return Number.isFinite(value) && value > 0 ? value : DEFAULT_MERGE_CHECKS_TIMEOUT_MS;
    } catch {
        return DEFAULT_MERGE_CHECKS_TIMEOUT_MS;
    }
}

// Buffer compartido de 4 bytes para `sleepSync`. Nunca hacemos `Atomics.notify`:
// se usa puramente como sleep que CEDE la CPU (a diferencia de un busy-wait,
// que bajo carga no deja schedulear a nadie más). Mismo patrón que
// `.pipeline/lib/file-lock.js` — se copia acá, en vez de importarlo, porque
// file-lock NO lo exporta y no vale la pena ampliar su superficie pública.
const SLEEP_SHARED = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
    if (!(ms > 0)) return;
    try {
        Atomics.wait(SLEEP_SHARED, 0, 0, ms);
    } catch {
        // Degradación, no rotura: si Atomics no está disponible, busy-wait.
        const until = Date.now() + ms;
        while (Date.now() < until) { /* espera */ }
    }
}

// ============================================================================
// #5420 — Gate de merge: unidad testeable con dependencias inyectadas.
// ============================================================================
//
// Evalúa, EN ORDEN y sobre un snapshot único por intento:
//
//   1. snapshot del PR válido            → si no, bloquea (no adivina)
//   2. gate de QA (labels del snapshot)  → si falta, deja el PR abierto
//   3. CODEOWNERS desde `origin/main`    → si no carga, bloquea (fail-closed)
//   4. owners humanos sobre los files    → si hay, needs-human
//   5. procedencia de la rama del head   → si no verifica, bloquea
//   6. PUT del merge con `sha` pinneado  → éxito SÓLO con merged:true
//
// Ningún paso puede saltearse degradando a vacío: cada lectura fallida bloquea
// y escala. Ante `head-changed` se reintenta UNA vez, y el reintento vuelve a
// empezar por el paso 1 — nunca reusa labels, paths, rama ni SHA del intento
// anterior (si el head se movió, los gates anteriores ya no valen nada).
//
// #6012 — Ese invariante se extiende AL 405: la espera por mergeabilidad y su
// reintento salen por el MISMO `continue`, así que también vuelven al paso 1 y
// reevalúan los 6 gates. Está prohibido envolver `mergePR(...)` en un bucle
// local: mergearía a `main` con un veredicto de QA y un CODEOWNERS leídos ~30 s
// antes, y en esa ventana alguien puede pushear a la rama o cambiar labels
// (hallazgo ALTO de security, OWASP A08).
//
// Dos presupuestos INDEPENDIENTES (CA-8):
//   `attempt` — gates/head-changed, tope `MAX_MERGE_ATTEMPTS` (2).
//   `waits`   — espera de mergeabilidad, tope `MAX_MERGEABILITY_WAITS` (6).
// La espera hace `attempt--` para no consumir presupuesto de gates. El bucle
// termina siempre: cada vuelta o retorna, o incrementa `waits` (monótono, nunca
// se decrementa, y ambos callsites están guardados por `waits < maxWaits`), o
// incrementa `attempt` neto. Techo duro de vueltas = attemptsMax + maxWaits.
//
// Devuelve `{ status, ... }` con status ∈
//   'merged' | 'no-qa-gate' | 'needs-human' | 'blocked' | 'conflict'
//   | 'transient' | 'error'
function attemptMergeWithGates({
    prNumber,
    getSnapshot,
    loadOwners,
    verifyOrigin,
    mergePR,
    logAppend,
    maxAttempts = MAX_MERGE_ATTEMPTS,
    // #6012 — El sleep es inyectable (default no-op en tests) para que la suite
    // no espere 31 s reales por cada caso de polling.
    sleepImpl = sleepSync,
    maxMergeabilityWaits = MAX_MERGEABILITY_WAITS,
    mergeChecksTimeoutMs = loadMergeChecksTimeoutMs(),
    // #6431 A-2 — Lector de los checks REQUERIDOS del ruleset. Default `null`
    // a proposito, y es una decision de diseno, no una omision:
    //   - con `null`, la rama BLOCKED cae al comportamiento de #6384, que es lo
    //     que mantiene `delivery-merge-6347.test.js` verde SIN tocarlo (T19);
    //   - un default REAL haria que toda suite que no inyecte nada saliera a la
    //     red contra `gh` (A-R4).
    // El wiring de produccion SIEMPRE lo inyecta y hay un test que lo verifica.
    // Cuando falta, se loguea: la desactivacion nunca es silenciosa (CA-20).
    requiredChecksReader = null,
    maxChecksWaits = MAX_CHECKS_WAITS,
    // Resultado del pre-check local `git merge-tree`. SÓLO se usa para loguear
    // la contradicción con el servidor — nunca para decidir (CA-7).
    mergeTreeClean = false,
} = {}) {
    const log = typeof logAppend === 'function' ? logAppend : () => {};
    const attemptsMax = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : MAX_MERGE_ATTEMPTS;
    const waitsMax = Number.isInteger(maxMergeabilityWaits) && maxMergeabilityWaits >= 0
        ? maxMergeabilityWaits
        : MAX_MERGEABILITY_WAITS;
    const sleep = typeof sleepImpl === 'function' ? sleepImpl : sleepSync;
    // `Infinity` es un valor VALIDO aca (CA-15): sirve para probar que el bucle
    // termina por `MAX_CHECKS_WAITS` y no por el reloj. `NaN` no lo es.
    const checksTimeoutMs = typeof mergeChecksTimeoutMs === 'number' && mergeChecksTimeoutMs >= 0
        ? mergeChecksTimeoutMs
        : DEFAULT_MERGE_CHECKS_TIMEOUT_MS;
    const checksWaitsMax = Number.isInteger(maxChecksWaits) && maxChecksWaits >= 0
        ? maxChecksWaits
        : MAX_CHECKS_WAITS;
    const leerRequeridos = typeof requiredChecksReader === 'function'
        ? (snapshot) => {
            // Toda excepcion o forma inesperada del lector es `unusable`, nunca
            // "no hay control": un lector roto no puede relajar el gate.
            let rc;
            try {
                rc = requiredChecksReader({ prNumber, headRefOid: snapshot.headRefOid });
            } catch (e) {
                rc = { verdict: 'unusable', cause: 'lector-excepcion', pending: [], failing: [], green: [] };
            }
            if (!rc || typeof rc !== 'object' || typeof rc.verdict !== 'string') {
                rc = { verdict: 'unusable', cause: 'lector-forma-inesperada', pending: [], failing: [], green: [] };
            }
            if (Array.isArray(rc.logLines)) rc.logLines.forEach((l) => log(String(l)));
            // #6599 - visibilidad de los checks SIN poder de veto (CA-3). No
            // deciden nada: solo se reportan. Un OWASP en rojo que desaparece
            // del resumen es un defecto que nadie ve.
            try {
                const info = classifyChecks(snapshot.statusCheckRollup, {
                    requiredContexts: rc.requiredContexts,
                    requiredContextsRead: rc.requiredContextsRead,
                });
                rc.informationalChecks = info.informational;
                const frase = describeInformationalChecks(info);
                if (frase) log(`[delivery] gate merge:${frase.replace(/\n/g, ' ')}`);
                if (info.requiredFilterApplied !== true) {
                    // CA-5 - la desactivacion del filtro NUNCA es muda.
                    log(`[delivery] gate merge: filtro de checks no requeridos DESACTIVADO (${info.requiredFilterCause}) \u2014 se espera por todos los checks del PR, como antes de #6599`);
                }
            } catch (e) {
                // El resumen es telemetria: si falla, no puede tumbar el merge.
                log(`[delivery] gate merge: no se pudo resumir los checks informativos (${((e && e.message) || '').slice(0, 120)})`);
            }
            return rc;
        }
        : null;
    if (!leerRequeridos) {
        // CA-20/CA-UX-5 — Sin lector, la rama BLOCKED no puede distinguir "el
        // check todavia no reporto" de "un control se esta ejerciendo", y todo
        // BLOCKED escala como antes de #6431. Queda dicho.
        log('[delivery] gate merge: sin lector de checks requeridos inyectado — la rama BLOCKED se clasifica con el rollup del snapshot (comportamiento #6384)');
    }

    let attempt = 0;
    let waits = 0;
    let checksWaits = 0;
    let checksWaitedMs = 0;

    while (attempt < attemptsMax) {
        attempt++;
        // (1) Snapshot único: labels + files + rama + SHA del head, atómico.
        const snapshot = getSnapshot(prNumber);
        if (!snapshot || snapshot.ok !== true) {
            const reason = (snapshot && snapshot.reason) || 'snapshot no disponible';
            log(`[delivery] gate merge: snapshot del PR no disponible (${reason}) — merge bloqueado`);
            return { status: 'blocked', gate: 'snapshot', reason, attempt };
        }

        // (1b) #6012 CA-3 — Un PR ya cerrado también reporta UNKNOWN en
        //      `mergeable`/`mergeStateStatus` (verificado sobre los PRs #6010 y
        //      #6011, ya MERGED, con ambos campos en UNKNOWN). Sin este corte, el
        //      polling se comería el backoff completo esperando un estado que ya
        //      nunca va a resolverse.
        if (snapshot.state === 'MERGED') {
            log('[delivery] gate merge: el PR ya figura MERGED — éxito idempotente, no se reintenta el PUT');
            return { status: 'merged', sha: null, idempotent: true, snapshot, attempt };
        }
        if (snapshot.state && snapshot.state !== 'OPEN') {
            const reason = `el PR está en estado ${snapshot.state}`;
            log(`[delivery] gate merge: ${reason} — merge bloqueado`);
            return { status: 'blocked', gate: 'pr-closed', reason, snapshot, attempt };
        }

        // (2) Gate de QA sobre los labels del MISMO snapshot que se va a mergear.
        if (!hasQaGate(snapshot.labels)) {
            return { status: 'no-qa-gate', snapshot, attempt };
        }

        // (3) CODEOWNERS desde origin/main. `ok:false` = no pude leer → bloqueo.
        //     Jamás se interpreta como "este PR no tiene owners".
        const owners = loadOwners();
        if (!owners || owners.ok !== true) {
            const reason = (owners && owners.reason) || 'CODEOWNERS no cargable';
            log(`[delivery] gate merge: CODEOWNERS no cargable (${reason}) — merge bloqueado`);
            return { status: 'blocked', gate: 'codeowners', reason, snapshot, attempt };
        }

        // (4) Owners humanos sobre los paths del snapshot.
        const humanOwners = codeowners.getHumanOwners(owners.rules, snapshot.files);
        if (humanOwners.length) {
            log(`[delivery] gate merge: CODEOWNERS humano ${humanOwners.join(' ')} — merge bloqueado`);
            return { status: 'needs-human', owners: humanOwners, snapshot, attempt };
        }

        // (5) Procedencia del head del PR: el primer commit sobre main tiene que
        //     venir de un committer conocido. Sin red o sin commits → bloqueo.
        const provenance = verifyOrigin(snapshot.headRefName);
        if (!provenance || provenance.ok !== true) {
            const reason = (provenance && provenance.reason) || 'procedencia no verificable';
            log(`[delivery] gate merge: procedencia de ${snapshot.headRefName} NO verificada (${reason}) — merge bloqueado`);
            return { status: 'blocked', gate: 'provenance', reason, snapshot, attempt };
        }

        // (5a) #6431 A-3 — Pre-check de checks requeridos, ANTES del PUT.
        //
        // Dispara SOLO con `statusCheckRollup === []` — leido y vacio, que es la
        // ventana ciega EXACTA del episodio (a t+4 s GitHub todavia no instancio
        // ningun check). Con el rollup poblado no dispara: el camino post-405 lo
        // cubre igual, a costa de un 405 extra. Dos razones para acotarlo asi:
        // ahorra dos lecturas de API en el caso comun, y preserva la secuencia
        // de sleeps que `delivery-merge-6347.test.js` assertea.
        //
        // NUNCA BLOQUEA (D3): cualquier veredicto que no sea `pending` cae al
        // PUT y decide GitHub. Este pre-check solo puede DEMORAR el merge, no
        // impedirlo — si se equivoca, el peor caso es una espera de mas.
        if (leerRequeridos
            && Array.isArray(snapshot.statusCheckRollup)
            && snapshot.statusCheckRollup.length === 0) {
            const rc = leerRequeridos(snapshot);
            if (rc.verdict === 'pending' && checksWaits < checksWaitsMax && checksWaitedMs < checksTimeoutMs) {
                const backoff = CHECKS_BACKOFF_MS[Math.min(checksWaits, CHECKS_BACKOFF_MS.length - 1)];
                const delay = Math.min(backoff, checksTimeoutMs - checksWaitedMs);
                checksWaits++;
                checksWaitedMs += delay;
                log(`[delivery] gate merge: requeridos pendientes [${(rc.pending || []).join(', ')}] — espera ${delay}ms (${checksWaits}/${checksWaitsMax}) y reevaluación completa de gates`);
                sleep(delay);
                attempt--;  // la espera NO consume presupuesto de gates (CA-8)
                continue;
            }
        }

        // (5b) #6012 CA-2 — Espera pre-merge. Si GitHub todavía está calculando
        //      la mergeabilidad, disparar el PUT ahora produce el 405 que este
        //      issue vino a arreglar. Mejor esperar y reevaluar TODO que pegarle
        //      a la API en la ventana ciega.
        if (snapshot.mergeStateStatus === 'UNKNOWN' && waits < waitsMax) {
            const delay = MERGEABILITY_BACKOFF_MS[waits] || 8000;
            waits++;
            log(`[delivery] gate merge: mergeStateStatus=UNKNOWN (GitHub calculando) — espera ${delay}ms (${waits}/${waitsMax}) y reevaluación completa de gates`);
            sleep(delay);
            attempt--;  // la espera NO consume presupuesto de gates (CA-8)
            continue;
        }

        // (6) Merge con el SHA observado al evaluar los gates. Si el head se
        //     movió, GitHub responde 409 y NO mergea nada.
        //     El `sha` sale del snapshot del intento VIGENTE — el `continue` de
        //     arriba garantiza que nunca se reuse el previo a una espera.
        const mergeRes = mergePR({ prNumber, sha: snapshot.headRefOid, headRefName: snapshot.headRefName });
        const confirmed = confirmMergeResponse(mergeRes);
        if (confirmed.ok) {
            return { status: 'merged', sha: confirmed.sha, snapshot, attempt };
        }
        if (confirmed.transportOk) {
            // HTTP OK pero semánticamente no mergeado: no reintentamos (no es un
            // problema de SHA) y no habilitamos el camino de éxito.
            log(`[delivery] gate merge: ${confirmed.reason} — merge NO confirmado`);
            return { status: 'blocked', gate: 'merge-unconfirmed', reason: confirmed.reason, snapshot, attempt };
        }

        let classification = classifyMergeFailure(mergeRes, {
            mergeStateStatus: snapshot.mergeStateStatus,
            state: snapshot.state,
            statusCheckRollup: snapshot.statusCheckRollup,
        });

        // #6431 3.d.2 — Reclasificacion post-405. La primera pasada corre SIN
        // `requiredChecks` (pura, con lo que ya estaba en el snapshot); si dio
        // BLOCKED y hay lector, recien ahi se paga la lectura de red y se
        // vuelve a clasificar con el veredicto autoritativo.
        //
        // El `headRefOid` va PINNEADO del snapshot VIGENTE (CA-11) — nunca
        // `main` ni un ref simbolico. Si el head se movio entre el snapshot y
        // esta lectura, la regla 4 del clasificador lo detecta (`oid !==
        // headRefOid`) y devuelve `unusable`: no se reabre la ventana TOCTOU
        // que cerro #5420.
        if (classification.blockedByRuleset === true && leerRequeridos) {
            const rc = leerRequeridos(snapshot);
            classification = classifyMergeFailure(mergeRes, {
                mergeStateStatus: snapshot.mergeStateStatus,
                state: snapshot.state,
                statusCheckRollup: snapshot.statusCheckRollup,
                reviewDecision: snapshot.reviewDecision,
                reviewDecisionRead: snapshot.reviewDecisionRead,
                requiredChecks: rc,
                // #6599 - la MISMA lista que ya leyo el reader (no hay segunda
                // llamada a la API): si `rc` viniera deforme, el camino legacy
                // tampoco cuenta los checks sin poder de veto.
                requiredContexts: rc.requiredContexts,
                requiredContextsRead: rc.requiredContextsRead,
            });
        }

        // #6012 CA-7 — El pre-check local corre contra el `origin/main` que
        // tenga el worktree, que puede estar viejo. Si contradice al servidor,
        // se DEJA CONSTANCIA pero manda la señal del servidor: usar la local
        // para reclasificar sería el mismo error de razonamiento que el falso
        // positivo de CODEOWNERS (#5898).
        if (mergeTreeClean === true && classification.kind !== 'ok') {
            log('[delivery] contradicción: merge-tree local dio integración limpia y la API respondió no-mergeable — manda la señal del servidor');
        }

        // #6012 CA-6 — El 405 transitorio sale por el MISMO `continue` que
        // `head-changed`: vuelve al paso 1 y reevalúa los 6 gates.
        if (classification.kind === 'mergeability-unknown') {
            if (waits < waitsMax) {
                const delay = MERGEABILITY_BACKOFF_MS[waits] || 8000;
                waits++;
                log(`[delivery] gate merge: HTTP 405 con mergeStateStatus=UNKNOWN — transitorio, espera ${delay}ms (${waits}/${waitsMax}) y reevaluación completa de gates`);
                sleep(delay);
                attempt--;  // no consume presupuesto de gates (CA-8)
                continue;
            }
            // CA-10 — Presupuesto agotado con el estado todavía sin resolver.
            // NO es conflicto y NO escala: es transitorio y reintentable.
            log(`[delivery] gate merge: mergeStateStatus siguió en UNKNOWN tras ${waits} esperas — resultado TRANSITORIO (no es conflicto, no escala)`);
            return { status: 'transient', classification, waits, mergeRes, snapshot, attempt };
        }

        if (classification.kind === 'checks-in-flight') {
            // ORDEN DELIBERADO (D-D). "Presupuesto agotado => transient" (CA-16)
            // y "el `checks-timeout` de #6384 sigue intacto" (T19) son
            // incompatibles si se implementan literal. Se resuelve por
            // PRECEDENCIA, no por compromiso:
            //
            //   1o el contador duro de esperas  -> transient
            //   2o el techo de wall-clock       -> checks-timeout (INTACTO)
            //   3o esperar y reevaluar
            //
            // Con los defaults (104 s de backoff vs 360 s de techo) el contador
            // corta SIEMPRE primero, asi que produccion sale por `transient` y
            // nunca mas escala por esta causa. `checks-timeout` queda alcanzable
            // solo con la config bajada — que es exactamente lo que hace
            // `delivery-merge-6347.test.js` (`mergeChecksTimeoutMs: 20`), y por
            // eso esa suite sigue verde sin tocarse.

            // (1) CA-16 — Presupuesto propio agotado. NO escala: el resultado es
            //     transitorio y reintentable. Cero mensajes al operador (C6):
            //     no se le notifica un evento sobre el que no puede hacer nada.
            if (checksWaits >= checksWaitsMax) {
                const pendientes = (classification.requiredChecks && classification.requiredChecks.pending)
                    || (classification.checks && classification.checks.pending)
                    || [];
                log(`[delivery] gate merge: requeridos siguen pendientes tras ${checksWaits} esperas — resultado TRANSITORIO (no escala)`);
                return {
                    status: 'transient', causa: 'checks-pending', pendientes,
                    classification, checksWaits, checksWaitedMs, mergeRes, snapshot, attempt,
                };
            }
            // (3) Esperar y reevaluar los 6 gates sobre snapshot fresco (CA-14).
            if (checksWaitedMs < checksTimeoutMs) {
                const backoff = CHECKS_BACKOFF_MS[Math.min(checksWaits, CHECKS_BACKOFF_MS.length - 1)];
                const delay = Math.min(backoff, checksTimeoutMs - checksWaitedMs);
                checksWaits++;
                checksWaitedMs += delay;
                log(`[delivery] gate merge: checks requeridos en curso — espera ${delay}ms (${checksWaits}/${checksWaitsMax}, ${checksWaitedMs}/${checksTimeoutMs}ms) y reevaluación completa de gates`);
                sleep(delay);
                attempt--;
                continue;
            }
            // (2) Techo de wall-clock. Camino de #6384, sin cambios.
            const minutes = Math.round((checksWaitedMs / 60000) * 10) / 10;
            const reason = `la CI no terminó en ${minutes} minutos; los checks requeridos siguen corriendo`;
            log(`[delivery] gate merge: ${reason} — escala como timeout de CI`);
            return {
                status: 'blocked', gate: 'checks-timeout', reason, classification,
                checksWaits, checksWaitedMs, mergeRes, snapshot, attempt,
            };
        }

        // #6012 CA-5 — Controles activos (branch protection / draft). Escalan
        // por el camino de gate-block y NUNCA se reintentan.
        if (classification.kind === 'gate-block') {
            log(`[delivery] gate merge: HTTP ${classification.httpStatus} con estado ${classification.gate} — control activo, escala sin reintentar`);
            return {
                status: 'blocked', gate: classification.gate,
                reason: classification.reason, classification, mergeRes, snapshot, attempt,
            };
        }

        if (classification.retryable && attempt < attemptsMax) {
            log(`[delivery] gate merge: head movido (${classification.reason}) — reintento ${attempt + 1}/${attemptsMax} reevaluando todos los gates`);
            continue;
        }
        if (classification.conflict) {
            return { status: 'conflict', classification, mergeRes, snapshot, attempt };
        }
        return { status: 'error', classification, mergeRes, snapshot, attempt };
    }

    // Inalcanzable con attemptsMax >= 1 (la última vuelta siempre retorna), pero
    // si algo cambia, el default es bloquear — nunca caer en éxito implícito.
    return { status: 'blocked', gate: 'retry-exhausted', reason: 'reintentos agotados sin merge confirmado', attempt: attemptsMax };
}

// shouldEscalateLocalMerge — decisión PURA sobre el pre-check `git.isMergeable`.
// Reproducción #4632: una rama cuyo merge server-side es limpio (merge-tree
// mergeable=true) NO escala y NO rebota — aunque un rebase la haría chocar.
// Sólo escala ante un conflicto REAL confirmado (supported && mergeable===false).
// Si merge-tree no está soportado (mergeable=null), NO afirmamos nada acá:
// dejamos la detección a la señal autoritativa server-side (Fase 5).
function shouldEscalateLocalMerge(mergeCheck = {}) {
    return mergeCheck.supported === true && mergeCheck.mergeable === false;
}

// classifyConflictFiles — sub-clasificador PURO de archivos en conflicto (#4765).
// Decide si un conjunto de paths en conflicto puede auto-resolverse sin humano
// (`mecanico`) o debe escalar (`decision`). Orden ESTRICTO (SR-3/CA-10):
//   1. canonicalizar cada path (SR-10 anti-evasión); no canonicalizable / que
//      escapa la raíz → `decision` (CA-15).
//   2. denylist PRIMERO: cualquier path que matchee la denylist de seguridad
//      (RCE/secrets/CI/IaC + self-reference) → `decision` (CA-10..CA-12),
//      aunque el diff parezca trivial y aunque también matchee la allowlist.
//   3. allowlist: si TODOS los paths caen en allow → `mecanico` (CA-2).
//   4. mixto o fuera de allowlist → `decision` (SR-1/CA-3).
// Reusa los helpers de canonicalización/matching de block-classifier.js (require
// perezoso para evitar ciclo de carga). `allowlist` = `{ allow, deny }`.
function classifyConflictFiles(paths, allowlist) {
    const bc = require('../lib/block-classifier');
    const { canonicalizePath, matchDenylist, matchAllowlist } = bc._internal;
    if (!Array.isArray(paths) || paths.length === 0) {
        return { category: 'decision', reason: 'sin paths de conflicto' };
    }
    const allow = allowlist && Array.isArray(allowlist.allow) ? allowlist.allow : [];
    const deny = allowlist && Array.isArray(allowlist.deny) ? allowlist.deny : [];
    const canon = paths.map((p) => canonicalizePath(p));
    if (canon.some((p) => p === null)) {
        return { category: 'decision', reason: 'path no canonicalizable o que escapa la raíz' };
    }
    if (matchDenylist(canon, deny)) {
        return { category: 'decision', reason: 'path en denylist de seguridad' };
    }
    if (matchAllowlist(canon, allow)) {
        return { category: 'mecanico', reason: 'todos los paths en allowlist (no-producto)' };
    }
    return { category: 'decision', reason: 'conflicto mixto o fuera de allowlist' };
}

// buildConflictMotivo — motivo del rechazo pensado para que el pulpo lo trate
// como BLOQUEO HUMANO (human-block.js → bloqueado-humano/ + needs-human) y NO
// como rebote técnico a dev. Debe matchear HUMAN_BLOCK_PATTERNS: incluye
// "requiere intervención humana" + "merge manual" a propósito.
//
// #6012 CA-UX-1 — `confirmed` distingue el conflicto verificado
// (`mergeStateStatus=DIRTY`) del default fail-closed (estado sin señal). Ambos
// frenan igual y ambos siguen matcheando HUMAN_BLOCK_PATTERNS — lo que cambia
// es que el texto ya no le AFIRMA al operador un conflicto que nadie verificó.
// Decirle "resolvé el conflicto a mano" cuando en realidad falta una aprobación
// lo manda a buscar un conflicto inexistente: el mismo defecto que este issue
// corrige, pero en el canal donde más cuesta.
function buildConflictMotivo({ prNumber, branch, httpStatus, confirmed = false } = {}) {
    const pr = prNumber ? `PR #${prNumber}` : 'el PR';
    const rama = branch ? ` (rama ${sanitizeReason(branch).sanitized})` : '';
    const http = httpStatus ? ` [HTTP ${httpStatus}]` : '';
    const que = confirmed
        ? `Conflicto de merge REAL contra main en ${pr}${rama}${http}`
        : `Merge bloqueado en ${pr}${rama}${http}: GitHub no pudo mergear y el estado del PR no confirma la causa`;
    return (
        `${que} — requiere intervención humana. `
        + `Delivery frenado y escalado al operador: merge manual pendiente (fail-closed, sin auto-merge por silencio). `
        + `Opciones: resolver (arreglarlo a mano) / abortar (descartar este delivery) / reintentar (reintentar el merge).`
    );
}

// #6012 CA-UX-4 — Motivo del resultado TRANSITORIO (CA-10). No escala: viaja
// como error técnico y rebota acotado por el circuit breaker de 3.
//
// ⚠️ Este texto está redactado para NO matchear `HUMAN_BLOCK_PATTERNS`
// (lib/human-block.js): nada de "conflicto de merge", "merge bloqueado/manual",
// "requiere intervención humana" ni "PR #N pendiente … merge". Cualquiera de
// esas cadenas lo enrutaría como bloqueo humano en vez de rebote técnico — o
// sea, reintroduciría exactamente el `needs-human` que este issue elimina.
// Hay un test que lo verifica contra `isHumanBlockReason`.
//
// #6431 — Parametrizado por `causa`. Con la causa ausente el texto es BYTE A
// BYTE el de #6012 (`delivery-merge-6012.test.js` lo assertea), asi que la
// variante nueva es puramente aditiva.
function buildTransientMergeMotivo({ prNumber, waits, causa = 'mergeability-unknown', pendientes = [] } = {}) {
    const pr = prNumber ? `PR #${prNumber}` : 'el PR';
    if (causa === 'checks-pending') {
        // Copy C1 de `.pipeline/assets/docs/6423/ux-copy-6423.md`, PEGADO TAL
        // CUAL y verificado contra `isHumanBlockReason` (CA-UX-1).
        //
        // Antes de tocar una coma, corre el test: UX verifico empiricamente que
        // CINCO redacciones naturales del mismo hecho matchean
        // HUMAN_BLOCK_PATTERNS y reintroducen el `needs-human` que este issue
        // viene a eliminar. Prohibido: "merge bloqueado", "requiere intervencion
        // humana", "review manual", "ruleset de main ... exige/bloquea/impide",
        // "PR #N pendiente ... merge".
        //
        // El cierre ("No hay defecto de dev ... sin cambios de codigo") es
        // IDENTICO al de `mergeability-unknown` a proposito: es la frase que le
        // dice al dev que no busque un bug suyo, y las dos causas transitorias
        // tienen que sonar a la misma familia.
        const esperasChecks = Number.isInteger(waits) && waits > 0 ? waits : MAX_CHECKS_WAITS;
        const lista = Array.isArray(pendientes) && pendientes.length
            ? pendientes.map((c) => sanitizeGateText(String(c), 80)).join(', ')
            : 'sin reportar';
        return (
            `Checks requeridos todavía sin reportar en ${pr}: GitHub respondió 405 con estado `
            + `BLOCKED porque el control automático [${lista}] seguía corriendo `
            + `tras ${esperasChecks} esperas escalonadas (~104 s). No hay defecto de dev ni evidencia `
            + `de integración sucia: la entrega se reintenta tal cual, sin cambios de código.`
        );
    }
    const esperas = Number.isInteger(waits) && waits > 0 ? waits : MAX_MERGEABILITY_WAITS;
    return (
        `Estado de merge transitorio de GitHub en ${pr}: mergeStateStatus siguió en UNKNOWN `
        + `tras ${esperas} esperas escalonadas (~31 s), o sea que el servidor todavía no terminó `
        + `de calcular la mergeabilidad. No hay defecto de dev ni evidencia de integración sucia: `
        + `la entrega se reintenta tal cual, sin cambios de código.`
    );
}

// buildMergeConflictEscalation — mensaje Telegram para el operador. Sigue las
// guidelines UX de #4658: (1) qué pasó en términos del operador — conflicto
// REAL, no el ficticio de rebase; (2) qué hace cada opción; (3) cómo responder;
// (4) main intacto (tono fail-closed de #4632); (5) contexto saneado del
// conflicto (R5/R6: sanitizeReason redacta secrets + escapa CRLF).
//
// #6012 CA-UX-1 — Con `confirmed:false` el mensaje describe lo que realmente se
// observó (GitHub rechazó el merge, el estado no dice por qué) en vez de afirmar
// un conflicto. Se mantiene el mismo formato de #4632/#4658: qué pasó → qué hace
// cada opción → cómo responder → `main` intacto.
function buildMergeConflictEscalation({ issue, prNumber, branch, httpStatus, conflictExcerpt, confirmed = false } = {}) {
    const safe = (v) => sanitizeReason(v == null ? '' : String(v)).sanitized.replace(/[\r\n]+/g, ' ').slice(0, 300);
    const excerpt = conflictExcerpt ? safe(conflictExcerpt).slice(0, 240) : '';
    const lines = [
        confirmed
            ? '🛑 GATE · Delivery frenado por CONFLICTO DE MERGE REAL — necesito que decidas'
            : '🛑 GATE · Delivery frenado: GitHub rechazó el merge y no pude confirmar la causa — necesito que decidas',
        `Issue/PR: #${safe(issue)} / ${prNumber ? `PR #${safe(prNumber)}` : '(sin PR)'}  ·  Rama: ${safe(branch)}`,
        httpStatus ? `Señal server-side: HTTP ${safe(httpStatus)} (GitHub no puede mergear limpio).` : 'GitHub no puede mergear limpio.',
        '',
        confirmed
            ? 'Esto NO es el conflicto ficticio de rebase que #4658 eliminó: es un conflicto de merge GENUINO contra `main`.'
            : 'El estado del PR NO confirma un conflicto: puede estar perfecto. Lo que no pude es acreditar por qué GitHub lo rechazó, y mergear sin esa acreditación sería saltear el gate.',
        '`main` quedó INTACTO. Nada se mergeó. Esta espera es intencional (fail-closed), no un fallo silencioso.',
        '',
        'Opciones:',
        confirmed
            ? '• *resolver* — lo arreglás a mano (resolvés el conflicto y mergeás el PR vos).'
            : '• *resolver* — lo revisás y, si está sano, mergeás el PR vos.',
        '• *abortar* — se descarta este delivery.',
        '• *reintentar* — se reintenta el merge tal cual.',
        '',
        `Cómo responder: comentá en el issue "resolver #${safe(issue)}", "abortar #${safe(issue)}" o "reintentar #${safe(issue)}".`,
        'El pipeline NO va a reintentar solo ni a auto-mergear por silencio (gate no delegable).',
    ];
    if (excerpt) {
        lines.push('', `Contexto del conflicto: ${excerpt}`);
    }
    return lines.join('\n');
}

// enqueueOperatorTelegram — escribe un drop en la cola CENTRAL de Telegram que
// lee el pulpo (REPO_ROOT/.pipeline/servicios/telegram/pendiente), NO en el
// worktree del agente (donde delivery corre pero el pulpo no escanea).
// Best-effort: NUNCA lanza (regla #1, el pipeline no puede morir).
function enqueueOperatorTelegram(text) {
    try {
        const dir = path.join(REPO_ROOT, '.pipeline', 'servicios', 'telegram', 'pendiente');
        fs.mkdirSync(dir, { recursive: true });
        const rnd = Math.random().toString(36).slice(2, 8);
        const id = `delivery-merge-conflict-${Date.now()}-${process.pid}-${rnd}`;
        fs.writeFileSync(
            path.join(dir, `${id}.json`),
            JSON.stringify({ text, parse_mode: 'Markdown', _correlationId: id }),
        );
        return { ok: true, id };
    } catch (e) {
        return { ok: false, error: (e && e.message) ? String(e.message).slice(0, 200) : 'unknown' };
    }
}

// authorizeOperatorResponse — CA-4/R1. Autoriza la respuesta del operador
// (resolver/abortar/reintentar) contra la allowlist CERRADA de chat_ids. Un
// chat_id desconocido NUNCA habilita re-merge (fail-closed). Delega en
// operator-absence-policy.authorizeOperator (no rueda auth propia por
// string-match). La allowlist default sale de operator-gate.resolveOperatorAllowlist.
function authorizeOperatorResponse(chatId, allowlist) {
    const source = allowlist !== undefined
        ? allowlist
        : operatorGate.resolveOperatorAllowlist(process.env);
    // resolveOperatorAllowlist devuelve un Set; validateConfirmer espera Array.
    const list = source instanceof Set ? Array.from(source) : source;
    return absencePolicy.authorizeOperator(chatId, list);
}

// escalateMergeConflict — orquesta el escalado fail-closed (side-effects):
//   1) Audit tamper-evident (CA-5/R3): appendDecision decision=fail-closed
//      (hash-chain SHA-256; verificable con verifyChain). Se apunta al audit
//      CENTRAL vía PIPELINE_DIR_OVERRIDE para que el operador lo revise en un
//      único lugar. safe*: NUNCA lanza.
//   2) Telegram fail-closed reusando buildFailClosedMessage de #4632 (CA-3) +
//      mensaje con opciones (UX), ambos a la cola CENTRAL.
// Devuelve { motivo } (human-block) para que el caller lo escriba en el marker.
// auditFailClosedDecision — registro tamper-evident de una decisión fail-closed
// del gate de merge. Extraído para que el conflicto real (#4658) y el bloqueo de
// gate (#5420) compartan exactamente el mismo camino de auditoría.
function auditFailClosedDecision({ issue, motivo, extra, timestamp, log } = {}) {
    const savedOverride = process.env.PIPELINE_DIR_OVERRIDE;
    try {
        process.env.PIPELINE_DIR_OVERRIDE = path.join(REPO_ROOT, '.pipeline');
        const auditRes = absenceAudit.safeAppendDecision({
            issue,
            gate: 'delivery-merge',
            clase: 'merge-a-main',
            actor: 'kernel:absence-policy',
            decision: 'fail-closed',
            reason: motivo,
            timestamp: timestamp || new Date().toISOString(),
            extra: extra || {},
        });
        if (typeof log === 'function') {
            log(`[delivery] audit fail-closed ${auditRes.ok ? 'OK' : `falló: ${auditRes.error}`}`);
        }
        return auditRes;
    } finally {
        if (savedOverride === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = savedOverride;
    }
}

function escalateMergeConflict({ issue, prNumber, branch, httpStatus, conflictExcerpt, confirmed = false, timestamp, logAppend } = {}) {
    const log = typeof logAppend === 'function' ? logAppend : () => {};
    const motivo = buildConflictMotivo({ prNumber, branch, httpStatus, confirmed });

    // (1) Audit central, tamper-evident. Override best-effort del pipelineDir.
    auditFailClosedDecision({
        issue,
        motivo,
        timestamp,
        log,
        extra: {
            pr: prNumber || null,
            branch: branch || null,
            http_status: httpStatus || null,
            conflict_confirmado: confirmed === true,
            conflict_excerpt: conflictExcerpt ? String(conflictExcerpt).slice(0, 500) : null,
        },
    });

    // (2a) Notificación fail-closed canónica (reusa infra #4632, CA-3). Sólo
    //      construimos el TEXTO (puro, sin dependencia de path) y lo encolamos
    //      en la cola central nosotros — así no depende del __dirname del worktree.
    try {
        const failClosedText = absencePolicy.buildFailClosedMessage({
            issue,
            gate: 'delivery-merge',
            clase: 'merge-a-main',
            reason: absencePolicy.REASONS.GATE_NO_DELEGABLE,
        });
        enqueueOperatorTelegram(failClosedText);
    } catch (e) {
        log(`[delivery] aviso: no se pudo encolar fail-closed: ${(e && e.message || '').slice(0, 120)}`);
    }

    // (2b) Mensaje con opciones explícitas (UX #4658).
    const optionsMsg = buildMergeConflictEscalation({ issue, prNumber, branch, httpStatus, conflictExcerpt, confirmed });
    const enq = enqueueOperatorTelegram(optionsMsg);
    log(`[delivery] escalado operador ${enq.ok ? 'encolado' : `falló: ${enq.error}`}`);

    return { motivo };
}

// ============================================================================
// #5420 — Escalado de un gate de merge que no pudo confirmarse.
// ============================================================================
//
// Distinto del conflicto de merge real (#4658): acá `main` y el PR están sanos,
// lo que falló es la CAPACIDAD DE VERIFICAR (no se pudo leer CODEOWNERS desde
// origin/main, no se pudo acreditar la procedencia de la rama, el snapshot vino
// degradado, o el PUT respondió sin `merged:true`). La política es la misma:
// fail-closed y al operador — nunca mergear sobre una verificación que no se
// pudo hacer.

const GATE_BLOCK_LABELS = {
    snapshot: 'no se pudo leer el estado del PR (labels/archivos/head)',
    codeowners: 'no se pudo cargar CODEOWNERS desde origin/main',
    provenance: 'no se pudo acreditar la procedencia de la rama del PR',
    'merge-unconfirmed': 'GitHub respondió sin confirmar el merge',
    'retry-exhausted': 'se agotaron los reintentos sin merge confirmado',
    // #5629 — Gates que ANTES terminaban con exitCode 0 (marker `aprobado`)
    // aunque el merge nunca ocurriera. Ahora escalan fail-closed como el resto.
    'qa-gate': 'el PR no tiene el gate de QA (falta label qa:passed o qa:skipped)',
    'codeowners-human': 'el PR toca paths con CODEOWNERS humano y exige review manual',
    // #6012 CA-UX-2 — Estados que el 405 mezclaba con "conflicto de merge". Salen
    // por este camino (no por el de conflicto) porque el vocabulario correcto ya
    // está acá: "No es un conflicto de merge: el PR puede estar perfecto…".
    // La acción que se le pide al operador es la de SU estado — aprobar/esperar
    // checks o sacar el draft, no resolver un conflicto que no existe.
    'branch-protection': 'la protección de rama bloquea el merge (control no identificado)',
    // #6431 C2/CA-UX-2 — Desdoble por control OBSERVADO. Se elimina el "o"
    // disyuntivo ("faltan reviews *o* checks"): post-fix el codigo ya sabe cual
    // de los dos es, y seguir diciendo "o" es esconder informacion que el
    // sistema tiene. Cada texto nombra UNA causa.
    //
    // La key generica `branch-protection` SOBREVIVE como fallback: el camino
    // legacy (sin lector inyectado) la sigue emitiendo, y
    // `GATE_BLOCK_LABELS[gate] || ...` no puede quedar sin destino si manana
    // aparece un veredicto nuevo.
    'branch-protection-checks-red': 'un check requerido terminó en rojo y la protección de rama frena el merge',
    'branch-protection-review': 'falta la review requerida por la protección de rama',
    'branch-protection-other': 'los checks requeridos están en verde pero la protección de rama sigue frenando el merge (hilo de review sin resolver, revisión de Copilot o commit sin atribuir)',
    'branch-protection-unreadable': 'no se pudo leer la lista de checks requeridos de la protección de rama',
    'checks-failing': 'hay checks requeridos en rojo',
    'checks-timeout': 'la CI no terminó dentro del techo de espera (los checks requeridos siguen corriendo)',
    'pr-draft': 'el PR está en borrador (draft) y GitHub no permite mergearlo',
    'pr-closed': 'el PR ya no está abierto',
};

// Motivo pensado para que el pulpo lo clasifique como BLOQUEO HUMANO
// (human-block.js → HUMAN_BLOCK_PATTERNS) y NO como rebote técnico a dev:
// incluye "Merge bloqueado" y "requiere intervención humana" a propósito.
// Doble saneo del texto libre que viaja al marker y a Telegram:
//   1. `sanitizeRefReason` (#5420) — redacta tokens gh_/JWT/`token=` y colapsa
//      saltos de línea. `sanitizeReason` NO cubre los tokens de GitHub.
//   2. `sanitizeReason` (audit canónico) — redacta claves AWS y escapa CRLF.
// Van encadenados a propósito: cada capa tapa lo que la otra no ve.
function sanitizeGateText(value, max = 240) {
    return sanitizeReason(codeowners.sanitizeRefReason(value, max)).sanitized;
}

function buildGateBlockMotivo({ prNumber, branch, gate, reason } = {}) {
    const pr = prNumber ? `PR #${prNumber}` : 'el PR';
    const rama = branch ? ` (rama ${sanitizeGateText(branch, 120)})` : '';
    const que = GATE_BLOCK_LABELS[gate] || `gate ${sanitizeGateText(gate || 'desconocido', 60)}`;
    const detalle = reason ? ` Detalle: ${sanitizeGateText(reason, 240)}.` : '';
    const cierre = gate === 'checks-timeout'
        ? 'Delivery esperó la CI sin omitir los gates ya verificados. main quedó intacto.'
        : 'Delivery frenado fail-closed: el pipeline NO mergea sin poder verificar owners, procedencia y SHA. main quedó intacto.';
    return (
        `Merge bloqueado en ${pr}${rama} — requiere intervención humana: ${que}.${detalle} `
        + cierre
    );
}

function buildGateBlockEscalation({ issue, prNumber, branch, gate, reason } = {}) {
    const safe = (v) => sanitizeGateText(v, 300).replace(/[\r\n]+/g, ' ');
    const que = GATE_BLOCK_LABELS[gate] || `gate ${safe(gate)}`;
    const contexto = gate === 'checks-timeout'
        ? [
            'Los gates de seguridad ya se verificaron, pero los checks requeridos siguieron en curso hasta agotar el techo.',
            '`main` quedó INTACTO. Nada se mergeó.',
        ]
        : [
            'No es un conflicto de merge: el PR puede estar perfecto. Lo que no pude hacer es *comprobar* que',
            'se cumplen los gates de seguridad, y mergear sin esa comprobación sería saltearlos.',
            '`main` quedó INTACTO. Nada se mergeó. Esta espera es intencional (fail-closed).',
        ];
    const lines = [
        '🛑 GATE · Delivery frenado: no pude VERIFICAR el merge — necesito que decidas',
        `Issue/PR: #${safe(issue)} / ${prNumber ? `PR #${safe(prNumber)}` : '(sin PR)'}  ·  Rama: ${safe(branch)}`,
        `Qué falló: ${que}.`,
        reason ? `Detalle: ${safe(reason).slice(0, 240)}` : '',
        '',
        ...contexto,
        '',
        'Opciones:',
        '• *resolver* — revisás y mergeás el PR vos.',
        '• *abortar* — se descarta este delivery.',
        '• *reintentar* — se reintenta el delivery completo (sirve si fue un corte de red).',
        '',
        `Cómo responder: comentá en el issue "resolver #${safe(issue)}", "abortar #${safe(issue)}" o "reintentar #${safe(issue)}".`,
        'El pipeline NO va a auto-mergear por silencio (gate no delegable).',
    ].filter((l) => l !== '');
    return lines.join('\n');
}

// Devuelve { motivo } (human-block) para que el caller lo escriba en el marker.
function escalateMergeGateBlock({ issue, prNumber, branch, gate, reason, timestamp, logAppend } = {}) {
    const log = typeof logAppend === 'function' ? logAppend : () => {};
    const motivo = buildGateBlockMotivo({ prNumber, branch, gate, reason });

    auditFailClosedDecision({
        issue,
        motivo,
        timestamp,
        log,
        extra: {
            pr: prNumber || null,
            branch: branch || null,
            gate_bloqueado: gate || null,
            block_reason: reason ? String(reason).slice(0, 500) : null,
        },
    });

    try {
        const failClosedText = absencePolicy.buildFailClosedMessage({
            issue,
            gate: 'delivery-merge',
            clase: 'merge-a-main',
            reason: absencePolicy.REASONS.GATE_NO_DELEGABLE,
        });
        enqueueOperatorTelegram(failClosedText);
    } catch (e) {
        log(`[delivery] aviso: no se pudo encolar fail-closed: ${((e && e.message) || '').slice(0, 120)}`);
    }

    const enq = enqueueOperatorTelegram(buildGateBlockEscalation({ issue, prNumber, branch, gate, reason }));
    log(`[delivery] escalado operador (gate ${gate}) ${enq.ok ? 'encolado' : `falló: ${enq.error}`}`);

    return { motivo };
}

async function main() {
    const args = parseArgs(process.argv);
    const issue = args.issue;

    if (!issue) {
        process.stderr.write('[delivery] Falta issue (CLI o env PIPELINE_ISSUE).\n');
        process.exit(2);
    }

    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
    const agentLog = path.join(LOG_DIR, `${issue}-delivery.log`);
    const logAppend = (msg) => {
        try { fs.appendFileSync(agentLog, msg + '\n'); } catch {}
    };
    logAppend(`--- delivery:#${issue} (deterministic) ${new Date().toISOString()} ---`);

    const hb = startHeartbeat(issue);
    const handle = trace.emitSessionStart({
        skill: 'delivery', issue, phase: process.env.PIPELINE_FASE || 'entrega',
        model: 'deterministic',
        // (#3078) Provider explícito para el dispatch del classifier por allowlist.
        provider: 'deterministic',
    });

    const startedAt = Date.now();
    const phases = {};
    let exitCode = 0;
    let motivo = null;
    let prNumber = null;
    let prUrl = null;
    let mergeSha = null;
    let labelsApplied = [];
    // #5629 — Flag ESTRUCTURADO de "merge frenado por un gate". Existe para que
    // el reporte distinga un rebote técnico de una escalada fail-closed sin
    // tener que adivinarlo parseando `motivo` (misma regla que aplica el
    // dashboard: el estado se lee de campos, nunca de prosa).
    let gateBlocked = false;

    const phaseStart = () => Date.now();
    const phaseEnd = (key, t0) => { phases[key] = Date.now() - t0; };

    try {
        // ── Verificación previa ────────────────────────────────────────
        const branch = git.getCurrentBranch(WORK_DIR);
        if (!branch || branch === 'main' || branch === 'develop' || branch === 'HEAD') {
            throw new Error(`Rama inválida para delivery: "${branch}"`);
        }

        // #2519 (rev-1): salvaguarda contra ejecución desde el worktree equivocado.
        // Si delivery corre en ROOT (porque pulpo no resolvió el worktree del issue)
        // la rama detectada será la del repo principal, NO `agent/<issue>-*`.
        // En ese caso committeamos/rebaseamos/pusheamos a la rama de OTRO agente.
        // Mejor abortar fast-fail con mensaje claro que rebotar después de hacer
        // commits a la rama equivocada y recién fallar en el rebase.
        //
        // #2591 — DEFENSE-IN-DEPTH INTENCIONAL: Esta salvaguarda se MANTIENE
        // aunque pulpo.js ahora aborta antes de spawnear delivery cuando no
        // encuentra worktree (ver lib/worktree-resolver.js). Es la última línea
        // de defensa contra cualquier futura regresión que reintroduzca el
        // fallback a ROOT. NO eliminar sin redundancia probada — un eventual
        // commit cruzado a main es data-integrity failure (OWASP A08).
        //
        // #2523 (rev-2): error message reporta WORK_DIR (no REPO_ROOT) porque
        // ese es el cwd real desde donde corrió git. REPO_ROOT siempre apunta
        // al checkout principal, lo cual confundía el diagnóstico.
        const expectedBranchPrefix = `agent/${issue}-`;
        if (!branch.startsWith(expectedBranchPrefix)) {
            throw new Error(
                `Worktree incorrecto: cwd=${WORK_DIR} está en rama "${branch}" pero ` +
                `delivery del #${issue} esperaba una rama que empiece con "${expectedBranchPrefix}". ` +
                `Probable causa: pulpo no resolvió el worktree del issue y delivery corrió en ROOT. ` +
                `Verificar pulpo.js useExistingWorktree incluye 'entrega'.`
            );
        }
        logAppend(`[delivery] cwd=${WORK_DIR} branch=${branch}`);

        const marker = readMarker(args.trabajando);
        const issueMeta = fetchIssueTitle(issue);
        const issueTitle = issueMeta.title || `entrega #${issue}`;
        logAppend(`[delivery] issue title="${issueTitle}" labels=${issueMeta.labels.join(',')}`);

        // ── Fase 1: stage + commit (si hay cambios sin commitear) ──────
        let t = phaseStart();
        const changed = git.getChangedFiles(WORK_DIR);
        const hasChanges = changed.length > 0;
        logAppend(`[delivery] cambios detectados: ${changed.length}`);

        if (hasChanges) {
            // Stagear todo lo modificado/untracked, EXCEPTO archivos sensibles del pipeline
            // que se mueven solos (heartbeats, registros internos, métricas, stackdumps).
            // #2519 (rev-1): ampliado a metrics-history.jsonl, *.heartbeat sueltos en root,
            // bash.exe.stackdump y otros artefactos no commiteables que aparecen en cualquier
            // worktree con pipeline en marcha.
            // #2551: ampliado además a outputs intermedios que generan las fases post-dev
            // cuando corren con cwd=worktree (PR #2537): logs del linter, locks transitorios,
            // qa evidence, lint reports. Sin esto, después del commit el árbol queda con
            // tracked-modified o untracked y el rebase/push tropieza con archivos espurios.
            // #3723 (rev-2): ampliado a carpetas .gitignore-adas del propio
            // pipeline (`.pipeline/audit/`, `.pipeline/audio/`,
            // `.pipeline/quota-snapshots/`, `.pipeline/archivado/`). Estas
            // están en .gitignore desde #3707 (ghost artifacts cleanup) pero
            // algunos archivos quedaron tracked de épocas previas. Cuando se
            // modifican, `getChangedFiles` los reporta y `git add -- <path>`
            // explota con "paths ignored by .gitignore" + exit 1 aunque el
            // archivo esté tracked. Defense-in-depth: filtrarlos en SAFE_IGNORE
            // ANTES de pasarlos a `git add`. La untrack-ación real se hace
            // con `git rm --cached` en el commit que introduce esta línea.
            const SAFE_IGNORE = new RegExp(
                '^(?:' + [
                    '\\.claude\\/hooks\\/agent-\\d+\\.heartbeat',
                    '\\.claude\\/hooks\\/agent-registry\\.json',
                    '\\.claude\\/hooks\\/activity-log',
                    '\\.pipeline\\/metrics-history\\.jsonl',
                    '\\.pipeline\\/.*\\.heartbeat',
                    '\\.pipeline\\/logs\\/.*',
                    '\\.pipeline\\/locks\\/.*',
                    // #3922: los `.ready` son estado de runtime (pid/puerto/timestamps)
                    // que el pipeline reescribe en cada arranque de servicio. Si se
                    // commitean, el rebase de delivery choca contra la versión de main
                    // y rebota al agente por un conflicto puramente cosmético.
                    '\\.pipeline\\/ready\\/.*',
                    // #4588: los caches de health de providers (codex-reprobe.json,
                    // provider-health.json) son estado de runtime volátil que el
                    // pipeline reescribe constantemente. Si delivery los stagea y
                    // commitea, el rebase contra main choca contra la versión de
                    // main (timestamps distintos) y rebota al agente por un conflicto
                    // puramente cosmético. Mismo patrón que .pipeline/ready/.
                    '\\.pipeline\\/cache\\/.*',
                    '\\.pipeline\\/audit\\/.*',
                    '\\.pipeline\\/audio\\/.*',
                    '\\.pipeline\\/archivado\\/.*',
                    '\\.pipeline\\/quota-snapshots\\/.*',
                    'qa\\/evidence\\/.*',
                    'lint-\\d+-report\\.(md|json)',
                    '.*\\.stackdump',
                ].join('|') + ')'
            );
            const stagePaths = changed
                .map((c) => c.path)
                .filter((p) => !SAFE_IGNORE.test(p));

            if (stagePaths.length) {
                // #5426 (rev-1): NO volver a `git add -- <paths>` con un path por
                // argumento. `runCmd` usa `shell: true` en Windows, así que el
                // comando pasa por cmd.exe y su límite de 8191 caracteres: con 406
                // archivos cambiados (~16,9 KB de paths) la entrega rebotó con «La
                // línea de comandos es demasiado larga». `addPaths` manda la lista
                // por stdin, con argv de tamaño constante.
                const addRes = git.addPaths(stagePaths, { cwd: WORK_DIR });
                if (addRes.exit_code !== 0) {
                    throw new Error(
                        `git add falló (${stagePaths.length} paths): ${addRes.stderr || addRes.stdout}`
                    );
                }
            }

            // Verificamos si quedó algo staged (puede ser que todo lo cambiado fuera ignored)
            const stagedCheck = git.runGit(['diff', '--cached', '--name-only'], { cwd: WORK_DIR });
            if (stagedCheck.stdout.trim()) {
                const commitMsg = git.buildCommitMessage({
                    issue, title: issueTitle,
                    body: `Entrega automatizada por pipeline V3 (delivery determinístico).`,
                    branch,
                    files: changed,
                });
                const msgFile = tmpFile('commit-msg', commitMsg);
                const commitRes = git.runGit(['commit', '-F', msgFile], { cwd: WORK_DIR });
                try { fs.unlinkSync(msgFile); } catch {}
                if (commitRes.exit_code !== 0) {
                    throw new Error(`git commit falló: ${commitRes.stderr || commitRes.stdout}`);
                }
                logAppend(`[delivery] commit creado`);
            } else {
                logAppend(`[delivery] no hay cambios staged tras filtrar archivos sensibles`);
            }
        }
        phaseEnd('stage_commit', t);

        // ── Fase 2: integración contra origin/main (SIN rebase, #4658) ──
        // #4658: se eliminó el rebase local gratuito. Rebasear reescribía commits
        // y generaba conflictos FICTICIOS aunque el merge real fuese limpio
        // (defecto de #4632 → loop de rebote a dev). El merge real es server-side
        // (squash, Fase 5), que detecta los conflictos GENUINOS por sí mismo. Acá
        // sólo hacemos fetch + un pre-check de mergeabilidad best-effort
        // (`git merge-tree`, sin mutar el árbol) para escalar temprano un
        // conflicto real. Ya no hace falta stash/pop de untracked (#2519/#2551):
        // el pre-check no toca el working tree y el push de la rama propia del
        // agente no requiere árbol limpio.
        t = phaseStart();
        const fetchRes = git.fetchOrigin(WORK_DIR);
        if (fetchRes.exit_code !== 0) {
            logAppend(`[delivery] git fetch warning: ${fetchRes.stderr.slice(0, 200)}`);
        }

        // ── (#3819) Entrega previa: rama sin commits, trabajo ya en main ──
        // Si la rama no tiene commits propios sobre origin/main pero main YA
        // contiene commits que referencian el issue (entregable arrastrado por
        // el PR de otro issue — caso real: #3819 entró a main vía el PR de
        // #3821), un PR acá sería vacío y `gh pr create` fallaría con
        // "No commits between main and <branch>". En vez de fallar: cerrar el
        // issue citando la entrega previa y terminar OK.
        // Importante: este check corre DESPUÉS de Fase 1 (stage+commit) — si
        // había trabajo real sin commitear, Fase 1 ya lo commiteó y acá
        // rev-list da > 0, así que el early-exit no se dispara.
        const aheadRes = git.runGit(['rev-list', '--count', 'origin/main..HEAD'], { cwd: WORK_DIR });
        const aheadCount = aheadRes.exit_code === 0 ? parseInt((aheadRes.stdout || '').trim(), 10) : NaN;
        if (aheadCount === 0) {
            const priorRefs = git.getPriorDeliveryRefs(WORK_DIR, issue, 'origin/main');
            if (!priorRefs.length) {
                throw new Error(
                    `Rama ${branch} sin commits sobre origin/main y sin entrega previa de #${issue} en main — nada que entregar (corregir en dev).`,
                );
            }
            logAppend(`[delivery] entrega previa detectada en main: ${priorRefs.join(' · ')}`);
            const commentBody = [
                '🔁 **Entrega sin PR — entregable ya mergeado en `main`**',
                '',
                `El pipeline detectó que la rama \`${branch}\` no tiene commits propios y que el entregable de este issue ya está en \`main\`:`,
                '',
                ...priorRefs.map((r) => `- \`${r}\``),
                '',
                'Se cierra el issue sin crear PR (un PR vacío fallaría). Delivery determinístico V3.',
            ].join('\n');
            const commentFile = tmpFile('prior-delivery-comment', commentBody);
            const commentRes = git.runGh(
                ['issue', 'comment', String(issue), '--body-file', commentFile],
                { cwd: WORK_DIR, timeoutMs: 60 * 1000 },
            );
            try { fs.unlinkSync(commentFile); } catch {}
            if (commentRes.exit_code !== 0) {
                logAppend(`[delivery] aviso: comentario de entrega previa falló: ${(commentRes.stderr || '').slice(0, 200)}`);
            }
            const closeRes = git.runGh(
                ['issue', 'close', String(issue)],
                { cwd: WORK_DIR, timeoutMs: 60 * 1000 },
            );
            if (closeRes.exit_code !== 0) {
                throw new Error(`gh issue close falló: ${(closeRes.stderr || closeRes.stdout || '').slice(0, 300)}`);
            }
            phaseEnd('prior_delivery', t);
            motivo = `Entregable de #${issue} ya mergeado en main (${priorRefs[0]}) — issue cerrado sin PR (entrega previa).`;
            logAppend(`[delivery] ${motivo}`);
            return; // finally: marker aprobado + trace + heartbeat stop + exit 0
        }

        // (a) Cleanup defensivo: drop de stashes huérfanos de runs anteriores
        //     que crashearon entre stash y pop (PIDs muertos con prefijo
        //     `delivery-<issue>-`). No bloquea si nadie quedó huérfano.
        const orphans = git.cleanupOrphanStashes(WORK_DIR, { issue });
        if (orphans.length) {
            logAppend(`[delivery] cleanup stash huérfanos: ${orphans.map((o) => `${o.ref}(pid=${o.pid})`).join(', ')}`);
        }

        // (b) Logging del estado git para forense. Local sin redacción;
        //     categorías agregadas (sin paths) al log público.
        const dirtyState = git.getDirtyState(WORK_DIR);
        const dirtyCounts = `tracked_modified=${dirtyState.tracked_modified.length} untracked=${dirtyState.untracked.length} ignored=${dirtyState.ignored.length}`;
        logAppend(`[delivery] dirty state pre-integración: ${dirtyCounts}`);

        // (c) #4658 — SIN rebase local. El rebase reescribía commits y explotaba
        //     con conflictos FICTICIOS aunque el merge real (squash server-side,
        //     Fase 5) fuese limpio — exactamente el defecto de #4632. El squash
        //     server-side ejecuta la misma operación 3-way que un merge y detecta
        //     por sí mismo los conflictos REALES (405/409), así que el rebase
        //     local sólo agregaba falsos positivos y un loop de rebote a dev.
        //
        //     Pre-check best-effort: `git merge-tree` predice localmente si la
        //     integración contra origin/main es limpia, SIN mutar el árbol. Si
        //     detecta un conflicto GENUINO, escalamos ANTES de crear un PR
        //     condenado (fail-closed, sin rebote). Si merge-tree no está
        //     soportado (git viejo / ref ausente), no afirmamos nada y dejamos
        //     que la señal autoritativa server-side (Fase 5) decida.
        const mergeCheck = git.isMergeable(WORK_DIR, 'origin/main');
        if (shouldEscalateLocalMerge(mergeCheck)) {
            const conflictExcerpt = git.redactInline((mergeCheck.conflicts || []).join(' | ').slice(0, 300));
            logAppend(`[delivery] conflicto de merge REAL detectado (merge-tree) — escalando al operador sin rebote`);
            const esc = escalateMergeConflict({
                issue, prNumber: null, branch, httpStatus: null,
                // #6012 — Este SÍ es un conflicto confirmado: merge-tree corrió,
                // está soportado y devolvió la lista concreta de archivos que
                // chocan. El `confirmed:false` es para el 405 sin señal, no para
                // esta detección (que no cambia — sigue siendo la de #4632/#4658).
                confirmed: true,
                conflictExcerpt, logAppend,
            });
            motivo = esc.motivo;
            exitCode = 1;
            phaseEnd('integracion', t);
            return; // finally: marker con motivo human-block → pulpo NO rebota, escala a needs-human
        }
        if (!mergeCheck.supported) {
            logAppend(`[delivery] merge-tree no disponible (exit=${mergeCheck.raw && mergeCheck.raw.exit_code}) — se delega la detección al squash server-side`);
        } else {
            logAppend(`[delivery] pre-check merge-tree: integración limpia contra origin/main`);
        }
        phaseEnd('integracion', t);

        // ── Fase 3: push ──────────────────────────────────────────────
        // #2523 (rev-3): pushAndVerify trata el caso "spawnSync devuelve error
        // pero el remote ya tiene el SHA" como éxito. Sin esto, pushes lentos
        // (~90-120s) en redes pesadas hacían rebotar al agente al circuit
        // breaker aunque el push hubiese completado en el remote.
        t = phaseStart();
        const pushRes = git.pushAndVerify(WORK_DIR, branch);
        if (pushRes.exit_code !== 0) {
            // Fallo real: remote no tiene nuestro SHA. Diagnóstico rico para
            // que el rebote sea accionable (signal, error, wall_ms, stderr).
            const diag = [
                `signal=${pushRes.signal || 'none'}`,
                `error=${pushRes.error || 'none'}`,
                `wall_ms=${pushRes.wall_ms}`,
                `local_sha=${(pushRes.local_sha || '').slice(0, 7) || 'n/a'}`,
                `remote_sha=${(pushRes.remote_sha || '').slice(0, 7) || 'n/a'}`,
            ].join(' ');
            const stderrMsg = (pushRes.stderr || '').slice(0, 200);
            throw new Error(`git push falló: ${stderrMsg || '(stderr vacío)'} [${diag}]`);
        }
        if (pushRes.recovered) {
            logAppend(`[delivery] push recovered: ${pushRes.recovered_reason}`);
        } else {
            logAppend(`[delivery] push OK`);
        }
        phaseEnd('push', t);

        // ── Fase 4: PR (crear o reutilizar) ───────────────────────────
        t = phaseStart();
        let pr = findExistingPR(branch, { log: logAppend });
        const stats = git.getDiffStats(WORK_DIR, 'origin/main');

        if (!pr) {
            // Determinar label QA: si el issue ya viene de un pipeline con QA, hereda;
            // si no, default qa:skipped (pipeline interno V3, sin impacto producto).
            const qaLabel = issueMeta.labels.includes('qa:passed') ? 'qa:passed'
                : issueMeta.labels.includes('qa:skipped') ? 'qa:skipped'
                : 'qa:skipped';

            const bodyTxt = git.buildPRBody({
                issue, title: issueTitle,
                summaryBullets: [
                    `Entrega automatizada por pipeline V3 (delivery determinístico)`,
                    `Cambios: ${stats.files_changed} archivos · +${stats.additions} -${stats.deletions}`,
                ],
                testPlan: [
                    `Pipeline V3 ejecutó builder + tester (gates verdes)`,
                    `QA: \`${qaLabel}\` aplicado por delivery`,
                ],
                qaLabel,
            });
            const bodyFile = tmpFile('pr-body', bodyTxt);
            const createArgs = [
                'pr', 'create',
                '--title', issueTitle,
                '--body-file', bodyFile,
                '--base', MERGE_BASE_BRANCH,
                '--head', branch,
                '--assignee', 'leitolarreta',
                '--label', qaLabel,
            ];
            const createRes = git.runGh(createArgs, { cwd: WORK_DIR, timeoutMs: 90 * 1000 });
            try { fs.unlinkSync(bodyFile); } catch {}
            if (createRes.exit_code !== 0) {
                throw new Error(`gh pr create falló: ${createRes.stderr.slice(0, 300) || createRes.stdout.slice(0, 300)}`);
            }
            // gh imprime la URL del PR como última línea
            prUrl = (createRes.stdout || '').trim().split(/\r?\n/).pop().trim();
            const m = prUrl.match(/\/pull\/(\d+)/);
            prNumber = m ? parseInt(m[1], 10) : null;
            labelsApplied = [qaLabel];
            logAppend(`[delivery] PR #${prNumber} creado: ${prUrl}`);
        } else {
            prNumber = pr.number;
            prUrl = pr.url;
            labelsApplied = pr.labels;
            logAppend(`[delivery] PR existente #${prNumber}: ${prUrl}`);
        }

        // #5864 — CA-1: el label de gate QA viaja del issue al PR sin
        // intervención humana, ANTES de que la Fase 5 lea el snapshot del PR.
        // Crítico en la rama de PR reusado: ese PR pudo nacer antes de que el
        // ciclo de QA corriera, así que jamás heredó el label del `pr create`.
        // Idempotente sobre el PR recién creado (ya trae el label).
        if (prNumber) {
            labelsApplied = Array.from(new Set([...labelsApplied, ...propagateGateLabelToPr({
                issue, prNumber, branch, issueLabels: issueMeta.labels, log: logAppend,
            })]));
        }
        phaseEnd('pr_create', t);

        // ── Fase 5: auto-merge si gate QA presente ────────────────────
        t = phaseStart();

        if (!args.autoMerge) {
            const finalLabels = getPRLabels(prNumber);
            labelsApplied = Array.from(new Set([...labelsApplied, ...finalLabels]));
            logAppend(`[delivery] auto-merge desactivado por flag — PR queda abierto`);
            motivo = `PR #${prNumber} creado/actualizado. Auto-merge desactivado.`;
        } else {
            // #5420 — Camino de merge endurecido. Los gates (QA, CODEOWNERS,
            // owners humanos, procedencia) se evalúan sobre un snapshot ÚNICO
            // del PR y el PUT viaja con el SHA de ese mismo snapshot. Ninguna
            // lectura fallida se degrada a "vacío": todo borde es fail-closed.
            const outcome = attemptMergeWithGates({
                prNumber,
                logAppend,
                // #6431 A-2 — El wiring de produccion SIEMPRE inyecta el lector.
                // El default `null` de la funcion existe solo para que las
                // suites viejas no salgan a la red; que produccion lo inyecte es
                // lo que hace que el fix exista, y hay un test que lo verifica.
                requiredChecksReader: buildRequiredChecksReader(),
                // #6012 CA-7 — El pre-check ya calculado se reusa SÓLO para
                // loguear la contradicción con el servidor. No reclasifica nada.
                mergeTreeClean: mergeCheck.supported === true && mergeCheck.mergeable === true,
                getSnapshot: (n) => getPRSnapshot(n, { logAppend }),
                // #2652 + #5420 — CODEOWNERS desde origin/main, NO del worktree
                // local (que puede estar podado) ni del head del PR (que podría
                // estar modificando el propio CODEOWNERS para saltearse el gate).
                loadOwners: () => codeowners.loadCodeownersFromRef(WORK_DIR, OWNERS_REF),
                verifyOrigin: (branchName) => {
                    try {
                        return verifyRemoteBranchOrigin(WORK_DIR, branchName);
                    } catch (e) {
                        // Nunca dejamos que una excepción de red/git se lea como
                        // "verificada": excepción = no verificada = bloqueo.
                        return { ok: false, reason: `excepcion: ${((e && e.message) || '').slice(0, 120)}` };
                    }
                },
                // #2801 — merge vía API REST de GitHub (server-side) en lugar de
                // `gh pr merge` (que ejecuta git ops locales). Razón: cuando otro
                // worktree del mismo repo tiene `main` checked-out, `gh pr merge`
                // intenta hacer `git checkout main` localmente y falla con
                // "fatal: 'main' is already used by worktree at <otro path>".
                // La API REST hace todo del lado del servidor — el estado local
                // del repo no importa.
                mergePR: ({ prNumber: n, sha }) => git.runGh([
                    'api', '-X', 'PUT', `repos/{owner}/{repo}/pulls/${n}/merge`,
                    '-f', 'merge_method=squash',
                    '-f', `commit_title=${issueTitle} (#${n})`,
                    // El SHA observado al evaluar los gates: si el head se movió,
                    // GitHub responde 409 y no mergea un árbol no verificado.
                    '-f', `sha=${sha}`,
                ], { cwd: WORK_DIR, timeoutMs: 3 * 60 * 1000 }),
            });

            if (outcome.snapshot && Array.isArray(outcome.snapshot.labels)) {
                labelsApplied = Array.from(new Set([...labelsApplied, ...outcome.snapshot.labels]));
            }

            if (outcome.status === 'no-qa-gate') {
                // #5629 — Sin gate QA no mergeamos ciegamente. ANTES esta rama
                // sólo seteaba `motivo` y caía al final con `exitCode === 0`, así
                // que el marker quedaba `resultado: aprobado` con el motivo
                // confesando "merge bloqueado" (#5220 → PR #5277 nunca mergeado,
                // issue ABIERTO, pintado 100% en la columna Entregado).
                // "Entrega no completada" NO puede escribirse como aprobado.
                //
                // Escalamos por la misma vía que `blocked` en vez de rebotar con
                // un `rechazado` plano: un rebote común manda el issue a una fase
                // anterior e incrementa `rev`, y como el gate QA no se destraba
                // solo, eso sería un loop de re-entrega que nunca cierra. El
                // motivo human-block hace que el pulpo escale al operador sin
                // rev++ (fail-closed, ver docs/pipeline/gates-firma-operador.md).
                const esc = escalateMergeGateBlock({
                    issue, prNumber, branch,
                    gate: 'qa-gate',
                    reason: 'el PR no tiene label qa:passed ni qa:skipped',
                    logAppend,
                });
                motivo = esc.motivo;
                gateBlocked = true;
                exitCode = 1;
                phaseEnd('pr_merge', t);
                return; // finally: marker con motivo human-block → NO rebota, escala
            } else if (outcome.status === 'needs-human') {
                // #5629 — Mismo tratamiento que `no-qa-gate` (antes: exitCode 0
                // → marker `aprobado`; caso #5244 / PR #5280). El label
                // `needs-human` se aplica IGUAL y antes de escalar: el board lo
                // renderiza con la chapa `f-human` 👤, así que el issue no queda
                // sin señal visible al dejar de pintarse como Entregado.
                applyNeedsHumanLabel(issue, prNumber, outcome.owners, WORK_DIR);
                labelsApplied = Array.from(new Set([...labelsApplied, 'needs-human']));
                const esc = escalateMergeGateBlock({
                    issue, prNumber, branch,
                    gate: 'codeowners-human',
                    reason: `review requerido de ${outcome.owners.join(' ')}`,
                    logAppend,
                });
                motivo = esc.motivo;
                gateBlocked = true;
                exitCode = 1;
                phaseEnd('pr_merge', t);
                return; // finally: marker con motivo human-block → NO rebota, escala
            } else if (outcome.status === 'blocked') {
                // #5420 — No pudimos VERIFICAR el merge (owners/procedencia/SHA/
                // confirmación). Fail-closed al operador, sin rebote a dev: el
                // motivo human-block hace que el pulpo escale sin rev++.
                const esc = escalateMergeGateBlock({
                    issue, prNumber, branch,
                    gate: outcome.gate, reason: outcome.reason, logAppend,
                });
                motivo = esc.motivo;
                gateBlocked = true;
                exitCode = 1;
                phaseEnd('pr_merge', t);
                return; // finally: marker con motivo human-block → NO rebota, escala a needs-human
            } else if (outcome.status === 'conflict') {
                // #4658 — Conflicto de merge REAL (405 not-mergeable / 409 sin
                // señal de head movido, o head movido que sobrevivió al retry).
                // El squash server-side es idempotente y NO muta `main` si no
                // puede mergear limpio (R7): escalamos al operador en vez de
                // throw genérico → rebote a dev en loop.
                const cls = outcome.classification;
                const mergeRes = outcome.mergeRes || {};
                const conflictExcerpt = git.redactInline(
                    (mergeRes.stderr || mergeRes.stdout || '').slice(0, 300),
                );
                // #6012 CA-9 — El log dejó de contradecirse. "conflicto REAL"
                // sólo se escribe cuando `mergeStateStatus=DIRTY` lo confirma;
                // el default fail-closed dice lo que de verdad pasó.
                logAppend(cls.confirmed
                    ? `[delivery] gh api merge → conflicto REAL confirmado (mergeStateStatus=DIRTY, ${cls.reason}) — escalando al operador sin rebote`
                    : `[delivery] gh api merge → no mergeable SIN confirmación de estado (${cls.reason}) — fail-closed, escalando al operador sin rebote`);
                const esc = escalateMergeConflict({
                    issue, prNumber, branch, httpStatus: cls.httpStatus,
                    conflictExcerpt, confirmed: cls.confirmed === true, logAppend,
                });
                motivo = esc.motivo;
                gateBlocked = true;
                exitCode = 1;
                phaseEnd('pr_merge', t);
                return; // finally: marker con motivo human-block → NO rebota, escala a needs-human
            } else if (outcome.status === 'transient') {
                // #6012 CA-10 — GitHub nunca terminó de calcular la
                // mergeabilidad. NO es conflicto y NO se escala: se rebota como
                // error técnico, acotado por el circuit breaker de 3 rebotes
                // (que es el tope explícito que pide CA-10 — no se re-encola sin
                // rev++, eso esquivaría el breaker y ciclaría quemando cuota).
                // #6431 CA-18/SEC-12 — El `throw` (y con el, el rebote tecnico
                // acotado por el circuit breaker de 3) SE QUEDA. Mientras #6432
                // no exista, ese rebote es la unica red que mantiene visible un
                // BLOCKED real: sacarlo seria perdida neta de observabilidad
                // frente al estado actual, no el fix.
                const causaTransient = outcome.causa === 'checks-pending' ? 'checks-pending' : 'mergeability-unknown';
                logAppend(causaTransient === 'checks-pending'
                    ? `[delivery] gh api merge → estado transitorio (${outcome.checksWaits} esperas, checks requeridos sin reportar) — rebote técnico, sin escalar al operador`
                    : `[delivery] gh api merge → estado transitorio (${outcome.waits} esperas, mergeStateStatus=UNKNOWN) — rebote técnico, sin escalar al operador`);
                throw new Error(buildTransientMergeMotivo({
                    prNumber,
                    waits: causaTransient === 'checks-pending' ? outcome.checksWaits : outcome.waits,
                    causa: causaTransient,
                    pendientes: outcome.pendientes || [],
                }));
            } else if (outcome.status !== 'merged') {
                // Fallo genérico (infra: red, auth, 5xx): rebote técnico legítimo.
                const mergeRes = outcome.mergeRes || {};
                throw new Error(`gh api merge falló: ${(mergeRes.stderr || '').slice(0, 300) || (mergeRes.stdout || '').slice(0, 300)}`);
            } else {
                // MERGE CONFIRMADO (`merged: true`). Recién acá — y sólo acá — se
                // registra el SHA, se borra la rama y se omite la escalada.
                mergeSha = outcome.sha || null;
                // Borrar rama del PR (igual que --delete-branch en gh pr merge)
                const deleteRes = git.runGh([
                    'api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${branch}`,
                ], { cwd: WORK_DIR, timeoutMs: 30 * 1000 });
                if (deleteRes.exit_code !== 0) {
                    logAppend(`[delivery] aviso: no se pudo borrar la rama ${branch}: ${(deleteRes.stderr || '').slice(0, 200)}`);
                }
                // Best-effort fetch del nuevo main para sincronizar local (no crítico).
                if (!mergeSha) {
                    const fetchAfter = git.runGit(['fetch', 'origin', 'main'], { cwd: WORK_DIR });
                    if (fetchAfter.exit_code === 0) {
                        const sha = git.runGit(['rev-parse', 'origin/main'], { cwd: WORK_DIR });
                        if (sha.exit_code === 0) mergeSha = sha.stdout.trim();
                    }
                }
                logAppend(`[delivery] PR #${prNumber} mergeado vía API REST (squash, sha pinneado, intento ${outcome.attempt}) sha=${mergeSha || 'unknown'}`);
            }
        }
        phaseEnd('pr_merge', t);

    } catch (e) {
        exitCode = 1;
        motivo = e.message.slice(0, 500);
        logAppend(`[delivery] ERROR: ${e.stack || e.message}`);
    } finally {
        const totalMs = Date.now() - startedAt;

        const reportLines = [
            `## Delivery: ${exitCode === 0 ? 'APROBADO ✅' : 'RECHAZADO ❌'}`,
            '',
            `- Issue: #${issue}  ·  PR: ${prNumber ? `#${prNumber}` : 'no creado'}  ·  Duración: ${(totalMs / 1000).toFixed(1)}s`,
            `- Modo: determinístico  ·  Auto-merge: ${args.autoMerge ? 'sí' : 'no'}`,
            `- Labels aplicados: ${labelsApplied.join(', ') || '(ninguno)'}`,
            `- Merge SHA: ${mergeSha || '(sin merge)'}`,
            '',
            '### Fases',
            ...Object.entries(phases).map(([k, ms]) => `- ${k}: ${(ms / 1000).toFixed(1)}s`),
            '',
        ];
        if (motivo) {
            reportLines.push('### Motivo / detalle');
            reportLines.push(`- ${motivo}`);
            reportLines.push('');
        }
        reportLines.push('### Veredicto');
        // #5629 — El veredicto textual se deriva de campos estructurados
        // (`mergeSha`, `gateBlocked`, `prNumber`), no de interpretar `motivo`.
        // "Entrega completada" queda reservado al caso con SHA de merge real:
        // antes un PR frenado por gate QA se reportaba como si sólo estuviera
        // esperando, y el marker salía `aprobado`.
        reportLines.push(exitCode === 0
            ? (mergeSha
                ? 'Entrega completada y mergeada a main.'
                : (prNumber
                    ? 'PR creado; merge no intentado (auto-merge desactivado). Entrega NO completada.'
                    : 'Entrega cerrada sin PR — entregable ya estaba en main (ver motivo).'))
            : (gateBlocked
                ? 'Entrega NO completada — merge frenado fail-closed y escalado al operador. main quedó intacto.'
                : 'Delivery rechazado — ver motivo y rebote.'));
        const report = reportLines.join('\n');
        logAppend('[delivery] --- REPORTE ---');
        logAppend(report);
        try {
            fs.writeFileSync(path.join(LOG_DIR, `delivery-${issue}-report.md`), report);
        } catch {}

        updateMarker(args.trabajando, {
            resultado: exitCode === 0 ? 'aprobado' : 'rechazado',
            motivo: motivo || (exitCode === 0 ? 'Entrega completada' : 'Delivery fallido'),
            delivery_pr_number: prNumber,
            delivery_pr_url: prUrl,
            delivery_merge_sha: mergeSha,
            delivery_labels: labelsApplied.join(','),
            delivery_duration_ms: totalMs,
            delivery_phases: JSON.stringify(phases),
            delivery_mode: 'deterministic',
        });

        trace.emitSessionEnd(handle, {
            tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0,
            tool_calls: 1,
            exit_code: exitCode,
            duration_ms: totalMs,
        });

        hb.stop();

        // (#3819) El exit vive en el finally para soportar el early-return de
        // "entrega previa" (un `return` dentro del try ejecuta este finally y
        // sale acá con exitCode=0). Para los flujos normales el comportamiento
        // es idéntico al process.exit que antes vivía después del try/finally.
        process.exit(exitCode);
    }
}

if (require.main === module) {
    if (process.argv.includes('--self-check')) {
        const { runSelfCheck } = require('./lib/self-check');
        runSelfCheck('delivery', [
            { name: 'parseArgs sin argumentos', fn: () => {
                const a = parseArgs(['node', 'delivery.js']);
                if (typeof a !== 'object' || a === null) throw new Error('parseArgs no devuelve objeto');
                if (a.autoMerge !== true) throw new Error('autoMerge default debió ser true');
            }},
            { name: 'parseArgs con --no-auto-merge', fn: () => {
                const a = parseArgs(['node', 'delivery.js', '1234', '--no-auto-merge']);
                if (a.issue !== 1234) throw new Error(`issue esperado 1234 got ${a.issue}`);
                if (a.autoMerge !== false) throw new Error('autoMerge debió ser false');
            }},
            { name: 'hasQaGate detecta qa:passed', fn: () => {
                if (!hasQaGate(['foo', 'qa:passed'])) throw new Error('debió aceptar qa:passed');
                if (!hasQaGate(['qa:skipped'])) throw new Error('debió aceptar qa:skipped');
                if (hasQaGate(['qa:pending'])) throw new Error('NO debió aceptar qa:pending');
                if (hasQaGate([])) throw new Error('NO debió aceptar lista vacía');
            }},
            { name: 'codeowners lib carga y matchea path', fn: () => {
                const co = require('./lib/codeowners');
                const rules = co.parseCodeowners('/.github/   @leitolarreta\n');
                if (!rules.length) throw new Error('parseCodeowners no devuelve reglas');
                const owners = co.resolveOwners(rules, ['.github/workflows/build.yml']);
                if (!owners.includes('@leitolarreta')) throw new Error('debió resolver @leitolarreta para .github/');
            }},
            { name: 'codeowners NO matchea .pipeline/ con CODEOWNERS post-acción 3', fn: () => {
                // Acción 3: solo .github/ requiere humano. .pipeline/ liberado.
                const co = require('./lib/codeowners');
                const rules = co.loadCodeowners(REPO_ROOT);
                const humans = co.getHumanOwners(rules, ['.pipeline/skills-deterministicos/tester.js']);
                if (humans.length) throw new Error(`.pipeline/ NO debería requerir humano: ${humans.join(',')}`);
            }},
        ]);
        return;
    }
    main().catch((e) => {
        process.stderr.write(`[delivery] fatal: ${e.stack || e.message}\n`);
        process.exit(2);
    });
}

module.exports = {
    parseArgs,
    startHeartbeat,
    readMarker,
    updateMarker,
    fetchIssueTitle,
    findExistingPR,
    getPRLabels,
    getPRChangedPaths,
    applyNeedsHumanLabel,
    hasQaGate,
    // #5864 — propagación del label de gate QA issue → PR.
    QA_GATE_LABELS,
    buildPrGatePropagation,
    propagateGateLabelToPr,
    // #5864 SEC-2 — procedencia del PR destino (defensa contra PRs de fork).
    fetchPrForGateWrite,
    EXPECTED_PR_REPO,
    // #5420 — camino de merge endurecido: snapshot único, gates en orden,
    // procedencia, SHA pinneado y confirmación estricta.
    getPRSnapshot,
    confirmMergeResponse,
    attemptMergeWithGates,
    buildGateBlockMotivo,
    buildGateBlockEscalation,
    escalateMergeGateBlock,
    // #5629 — expuesto para que los tests verifiquen que los gates que frenan
    // el merge (incluidos `qa-gate` y `codeowners-human`) escalan fail-closed
    // en vez de degradar el marker a `resultado: aprobado`.
    GATE_BLOCK_LABELS,
    MAX_MERGE_ATTEMPTS,
    OWNERS_REF,
    // #6012 — clasificación transitoria vs conflicto confirmado del HTTP 405.
    normalizeMergeState,
    MAX_MERGEABILITY_WAITS,
    MERGEABILITY_BACKOFF_MS,
    DEFAULT_MERGE_CHECKS_TIMEOUT_MS,
    CHECKS_BACKOFF_MS,
    loadMergeChecksTimeoutMs,
    buildTransientMergeMotivo,
    // #6431 — clasificacion de checks REQUERIDOS del ruleset (no del rollup).
    MAX_CHECKS_WAITS,
    SNAPSHOT_FIELDS,
    SNAPSHOT_FIELDS_6012,
    SNAPSHOT_FIELDS_LEGACY,
    REVIEW_DECISION_VALUES,
    MERGE_BASE_BRANCH,
    buildRequiredChecksReader,
    // #4658 — detección de conflicto real + escalado fail-closed.
    classifyMergeFailure,
    shouldEscalateLocalMerge,
    // #4765 — sub-clasificador de archivos en conflicto (denylist antes de allowlist).
    classifyConflictFiles,
    buildConflictMotivo,
    buildMergeConflictEscalation,
    enqueueOperatorTelegram,
    authorizeOperatorResponse,
    escalateMergeConflict,
    QA_LABELS_OK,
    REPO_ROOT,
    WORK_DIR,
};
