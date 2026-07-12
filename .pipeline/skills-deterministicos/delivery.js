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

function findExistingPR(branch) {
    const r = git.runGh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url,labels'], { cwd: WORK_DIR });
    if (r.exit_code !== 0) return null;
    try {
        const arr = JSON.parse(r.stdout);
        if (!arr.length) return null;
        return {
            number: arr[0].number,
            url: arr[0].url,
            labels: (arr[0].labels || []).map((l) => l.name),
        };
    } catch { return null; }
}

function getPRLabels(prNumber) {
    const r = git.runGh(['pr', 'view', String(prNumber), '--json', 'labels'], { cwd: WORK_DIR });
    if (r.exit_code !== 0) return [];
    try {
        return (JSON.parse(r.stdout).labels || []).map((l) => l.name);
    } catch { return []; }
}

function hasQaGate(labels) {
    return labels.some((l) => QA_LABELS_OK.has(l));
}

function getPRChangedPaths(prNumber) {
    const r = git.runGh(['pr', 'view', String(prNumber), '--json', 'files'], { cwd: WORK_DIR });
    if (r.exit_code !== 0) return [];
    try {
        return (JSON.parse(r.stdout).files || []).map((f) => f.path);
    } catch { return []; }
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
function classifyMergeFailure(res = {}) {
    if (!res || res.exit_code === 0) return { conflict: false, httpStatus: null, reason: 'ok' };
    const text = `${res.stderr || ''}\n${res.stdout || ''}`;
    const httpMatch = text.match(/\bHTTP\s+(\d{3})\b/i);
    const httpStatus = httpMatch ? parseInt(httpMatch[1], 10) : null;
    // 405/409 son las señales autoritativas de "no mergeable" del merge squash.
    if (httpStatus === 405 || httpStatus === 409) {
        return { conflict: true, httpStatus, reason: `http_${httpStatus}` };
    }
    // Defensa textual: gh puede envolver el status en el cuerpo del error.
    if (/\bnot\s+mergeable\b/i.test(text)
        || /\bmerge\s+conflict\b/i.test(text)
        || /\bhead\s+branch\s+was\s+modified\b/i.test(text)
        || /\bbase\s+branch\s+was\s+modified\b/i.test(text)) {
        return { conflict: true, httpStatus, reason: 'not_mergeable_text' };
    }
    return { conflict: false, httpStatus, reason: 'generic_error' };
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

// buildConflictMotivo — motivo del rechazo pensado para que el pulpo lo trate
// como BLOQUEO HUMANO (human-block.js → bloqueado-humano/ + needs-human) y NO
// como rebote técnico a dev. Debe matchear HUMAN_BLOCK_PATTERNS: incluye
// "requiere intervención humana" + "merge manual" a propósito.
function buildConflictMotivo({ prNumber, branch, httpStatus } = {}) {
    const pr = prNumber ? `PR #${prNumber}` : 'el PR';
    const rama = branch ? ` (rama ${sanitizeReason(branch).sanitized})` : '';
    const http = httpStatus ? ` [HTTP ${httpStatus}]` : '';
    return (
        `Conflicto de merge REAL contra main en ${pr}${rama}${http} — requiere intervención humana. `
        + `Delivery frenado y escalado al operador: merge manual pendiente (fail-closed, sin auto-merge por silencio). `
        + `Opciones: resolver (arreglarlo a mano) / abortar (descartar este delivery) / reintentar (reintentar el merge).`
    );
}

// buildMergeConflictEscalation — mensaje Telegram para el operador. Sigue las
// guidelines UX de #4658: (1) qué pasó en términos del operador — conflicto
// REAL, no el ficticio de rebase; (2) qué hace cada opción; (3) cómo responder;
// (4) main intacto (tono fail-closed de #4632); (5) contexto saneado del
// conflicto (R5/R6: sanitizeReason redacta secrets + escapa CRLF).
function buildMergeConflictEscalation({ issue, prNumber, branch, httpStatus, conflictExcerpt } = {}) {
    const safe = (v) => sanitizeReason(v == null ? '' : String(v)).sanitized.replace(/[\r\n]+/g, ' ').slice(0, 300);
    const excerpt = conflictExcerpt ? safe(conflictExcerpt).slice(0, 240) : '';
    const lines = [
        '🛑 GATE · Delivery frenado por CONFLICTO DE MERGE REAL — necesito que decidas',
        `Issue/PR: #${safe(issue)} / ${prNumber ? `PR #${safe(prNumber)}` : '(sin PR)'}  ·  Rama: ${safe(branch)}`,
        httpStatus ? `Señal server-side: HTTP ${safe(httpStatus)} (GitHub no puede mergear limpio).` : 'GitHub no puede mergear limpio.',
        '',
        'Esto NO es el conflicto ficticio de rebase que #4658 eliminó: es un conflicto de merge GENUINO contra `main`.',
        '`main` quedó INTACTO. Nada se mergeó. Esta espera es intencional (fail-closed), no un fallo silencioso.',
        '',
        'Opciones:',
        '• *resolver* — lo arreglás a mano (resolvés el conflicto y mergeás el PR vos).',
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
function escalateMergeConflict({ issue, prNumber, branch, httpStatus, conflictExcerpt, timestamp, logAppend } = {}) {
    const log = typeof logAppend === 'function' ? logAppend : () => {};
    const motivo = buildConflictMotivo({ prNumber, branch, httpStatus });

    // (1) Audit central, tamper-evident. Override best-effort del pipelineDir.
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
            extra: {
                pr: prNumber || null,
                branch: branch || null,
                http_status: httpStatus || null,
                conflict_excerpt: conflictExcerpt ? String(conflictExcerpt).slice(0, 500) : null,
            },
        });
        log(`[delivery] audit fail-closed ${auditRes.ok ? 'OK' : `falló: ${auditRes.error}`}`);
    } finally {
        if (savedOverride === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = savedOverride;
    }

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
    const optionsMsg = buildMergeConflictEscalation({ issue, prNumber, branch, httpStatus, conflictExcerpt });
    const enq = enqueueOperatorTelegram(optionsMsg);
    log(`[delivery] escalado operador ${enq.ok ? 'encolado' : `falló: ${enq.error}`}`);

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
                const addRes = git.runGit(['add', '--', ...stagePaths], { cwd: WORK_DIR });
                if (addRes.exit_code !== 0) {
                    throw new Error(`git add falló: ${addRes.stderr || addRes.stdout}`);
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
        let pr = findExistingPR(branch);
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
                '--base', 'main',
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
        phaseEnd('pr_create', t);

        // ── Fase 5: auto-merge si gate QA presente ────────────────────
        t = phaseStart();
        const finalLabels = getPRLabels(prNumber);
        labelsApplied = Array.from(new Set([...labelsApplied, ...finalLabels]));

        // #2652 — Detección de CODEOWNERS humano: si el PR toca paths protegidos
        // por un owner humano (ej. @leitolarreta), NO mergear automáticamente.
        // En su lugar: aplicar label `needs-human` al issue + comentar el PR
        // explicitando los owners requeridos. Esto evita merges silenciosos
        // sobre `.pipeline/` o `.github/` que requieren review manual.
        const ownerRules = codeowners.loadCodeowners(WORK_DIR);
        const changedForOwners = getPRChangedPaths(prNumber);
        const humanOwners = ownerRules.length && changedForOwners.length
            ? codeowners.getHumanOwners(ownerRules, changedForOwners)
            : [];
        if (humanOwners.length) {
            logAppend(`[delivery] CODEOWNERS humano detectado: ${humanOwners.join(' ')} — bloqueando auto-merge`);
        }

        if (!args.autoMerge) {
            logAppend(`[delivery] auto-merge desactivado por flag — PR queda abierto`);
            motivo = `PR #${prNumber} creado/actualizado. Auto-merge desactivado.`;
        } else if (!hasQaGate(finalLabels)) {
            // Sin gate QA → no mergeamos ciegamente; el delivery termina OK pero deja el PR abierto.
            motivo = `PR #${prNumber} creado pero sin label qa:passed/qa:skipped — merge bloqueado.`;
            logAppend(`[delivery] ${motivo}`);
        } else if (humanOwners.length) {
            applyNeedsHumanLabel(issue, prNumber, humanOwners, WORK_DIR);
            labelsApplied = Array.from(new Set([...labelsApplied, 'needs-human']));
            motivo = `PR #${prNumber} requiere review humano de ${humanOwners.join(' ')} — merge bloqueado, label needs-human aplicado.`;
            logAppend(`[delivery] ${motivo}`);
        } else {
            // #2801 — merge vía API REST de GitHub (server-side) en lugar de
            // `gh pr merge` (que ejecuta git ops locales). Razón: cuando otro
            // worktree del mismo repo tiene `main` checked-out, `gh pr merge`
            // intenta hacer `git checkout main` localmente y falla con
            // "fatal: 'main' is already used by worktree at <otro path>".
            // La API REST hace todo del lado del servidor — el estado local
            // del repo no importa.
            const mergeRes = git.runGh([
                'api', '-X', 'PUT', `repos/{owner}/{repo}/pulls/${prNumber}/merge`,
                '-f', 'merge_method=squash',
                '-f', `commit_title=${issueTitle} (#${prNumber})`,
            ], { cwd: WORK_DIR, timeoutMs: 3 * 60 * 1000 });
            if (mergeRes.exit_code !== 0) {
                // #4658 — Discriminar el CONFLICTO DE MERGE REAL (405 not-mergeable
                // / 409 head-changed) de un fallo genérico de infra (red, auth,
                // 5xx). El squash server-side es idempotente y NO muta `main` si no
                // puede mergear limpio (R7): ante conflicto real ESCALAMOS al
                // operador (fail-closed, sin auto-merge) en vez de throw genérico
                // → rebote a dev en loop. El 405/409 NO incrementa el circuit
                // breaker: el motivo human-block hace que el pulpo lo derive a
                // needs-human sin rev++.
                const cls = classifyMergeFailure(mergeRes);
                if (cls.conflict) {
                    const conflictExcerpt = git.redactInline(
                        (mergeRes.stderr || mergeRes.stdout || '').slice(0, 300),
                    );
                    logAppend(`[delivery] gh api merge → conflicto REAL (${cls.reason}) — escalando al operador sin rebote`);
                    const esc = escalateMergeConflict({
                        issue, prNumber, branch, httpStatus: cls.httpStatus,
                        conflictExcerpt, logAppend,
                    });
                    motivo = esc.motivo;
                    exitCode = 1;
                    phaseEnd('pr_merge', t);
                    return; // finally: marker con motivo human-block → NO rebota, escala a needs-human
                }
                // Fallo genérico (infra): rebote técnico legítimo como siempre.
                throw new Error(`gh api merge falló: ${mergeRes.stderr.slice(0, 300) || mergeRes.stdout.slice(0, 300)}`);
            }
            // Response shape: {"sha":"<merge-commit-sha>","merged":true,"message":"..."}
            try {
                const parsed = JSON.parse(mergeRes.stdout);
                if (parsed && parsed.sha) mergeSha = parsed.sha;
            } catch { /* response no-JSON: best-effort fallback abajo */ }
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
            logAppend(`[delivery] PR #${prNumber} mergeado vía API REST (squash) sha=${mergeSha || 'unknown'}`);
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
        reportLines.push(exitCode === 0
            ? (mergeSha
                ? 'Entrega completada y mergeada a main.'
                : (prNumber
                    ? 'PR creado, esperando gate QA antes del merge.'
                    : 'Entrega cerrada sin PR — entregable ya estaba en main (ver motivo).'))
            : 'Delivery rechazado — ver motivo y rebote.');
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
    // #4658 — detección de conflicto real + escalado fail-closed.
    classifyMergeFailure,
    shouldEscalateLocalMerge,
    buildConflictMotivo,
    buildMergeConflictEscalation,
    enqueueOperatorTelegram,
    authorizeOperatorResponse,
    escalateMergeConflict,
    QA_LABELS_OK,
    REPO_ROOT,
    WORK_DIR,
};
