// V3 Human-block helpers — estado transversal "bloqueado-humano" (issue #2478, #2549).
//
// Cualquier skill puede invocar reportHumanBlock() cuando detecte ambigüedad real
// que una intervención corta del humano resolvería. El issue queda pausado:
// no rebota, no consume tokens, hasta que se invoque unblockIssue().
//
// Marker en disco: <pipeline>/<phase>/bloqueado-humano/<issue>.<skill>
// Label GitHub: needs-human (color #B60205, ya gestionado por servicio-github)
// Eventos activity-log: human:blocked / human:unblocked
//
// #2549 — el pulpo también clasifica motivos de rechazo y, si detecta "bloqueo
// humano" (PR mergeable bloqueado por CODEOWNERS, merge manual pendiente, etc),
// llama a reportHumanBlock automáticamente en vez de relanzar el skill al infinito.
// La heurística vive en isHumanBlockReason() — extender ahí los patrones nuevos.
//
// Directiva PO (Leo, 2026-04-22): preferir acumulación de issues bloqueados antes
// que rebotes automáticos sin sentido. La eficiencia de tokens es prioritaria.

'use strict';

const fs = require('fs');
const path = require('path');
const trace = require('./traceability');
const { redactAll } = require('./sherlock-audit-jsonl');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');
const PIPELINES = ['desarrollo', 'definicion'];
const BLOCK_SUBDIR = 'bloqueado-humano';
const ACTIVE_STATES = ['pendiente', 'trabajando', 'listo'];
const GH_QUEUE_DIR = path.join(PIPELINE_DIR, 'servicios', 'github', 'pendiente');
const NEEDS_HUMAN_LABEL = 'needs-human';

// #2880 — encolar comando de label en la cola del servicio-github. Centralizar
// acá la aplicación del label evita que cada caller (pause-all, scripts manuales,
// pulpo en barrido) tenga que duplicar la lógica y olvide aplicarlo.
function enqueueNeedsHumanLabel(issue) {
    try {
        fs.mkdirSync(GH_QUEUE_DIR, { recursive: true });
        const filename = `${issue}-${NEEDS_HUMAN_LABEL}-block-${Date.now()}.json`;
        fs.writeFileSync(
            path.join(GH_QUEUE_DIR, filename),
            JSON.stringify({ action: 'label', issue: Number(issue), label: NEEDS_HUMAN_LABEL }),
        );
        return true;
    } catch {
        return false;
    }
}

function emitBlocked(opts) {
    trace.appendEvent({
        event: 'human:blocked',
        skill: opts.skill || null,
        issue: Number(opts.issue) || null,
        phase: opts.phase || null,
        pipeline: opts.pipeline || null,
        reason: opts.reason || '',
        question: opts.question || '',
        ts: new Date().toISOString(),
        pid: process.pid,
    });
}

function emitUnblocked(opts) {
    trace.appendEvent({
        event: 'human:unblocked',
        skill: opts.skill || null,
        issue: Number(opts.issue) || null,
        phase: opts.phase || null,
        pipeline: opts.pipeline || null,
        target_phase: opts.target_phase || opts.phase || null,
        guidance: opts.guidance || '',
        unlocker: opts.unlocker || 'commander',
        ts: new Date().toISOString(),
        pid: process.pid,
    });
}

function emitDismissed(opts) {
    trace.appendEvent({
        event: 'human:dismissed',
        skill: opts.skill || null,
        issue: Number(opts.issue) || null,
        phase: opts.phase || null,
        pipeline: opts.pipeline || null,
        reason: opts.reason || '',
        unlocker: opts.unlocker || 'commander',
        ts: new Date().toISOString(),
        pid: process.pid,
    });
}

// Artifacts auxiliares (.reason.json metadata, .guidance.txt de destrabe humano,
// .comment.md de criterios PO, etc.) no son markers de skill. Detección
// centralizada en `lib/marker-artifact.js` (#3638 CA-F-1) — re-export para
// preservar la API histórica (`require('./human-block').isMarkerArtifact`).
const { isMarkerArtifact } = require('./marker-artifact');

function findActiveMarker(issue) {
    const prefix = String(issue) + '.';
    for (const pipeline of PIPELINES) {
        const pipeRoot = path.join(PIPELINE_DIR, pipeline);
        let phases = [];
        try { phases = fs.readdirSync(pipeRoot).filter(f => fs.statSync(path.join(pipeRoot, f)).isDirectory()); }
        catch { continue; }
        for (const phase of phases) {
            for (const state of ACTIVE_STATES) {
                const dir = path.join(pipeRoot, phase, state);
                let entries = [];
                try { entries = fs.readdirSync(dir); } catch { continue; }
                for (const f of entries) {
                    if (f.startsWith(prefix) && f !== '.gitkeep' && !isMarkerArtifact(f)) {
                        return {
                            pipeline, phase, state,
                            skill: f.slice(prefix.length),
                            file: path.join(dir, f),
                        };
                    }
                }
            }
        }
    }
    return null;
}

function findBlockedMarker(issue) {
    const prefix = String(issue) + '.';
    for (const pipeline of PIPELINES) {
        const pipeRoot = path.join(PIPELINE_DIR, pipeline);
        let phases = [];
        try { phases = fs.readdirSync(pipeRoot).filter(f => fs.statSync(path.join(pipeRoot, f)).isDirectory()); }
        catch { continue; }
        for (const phase of phases) {
            const dir = path.join(pipeRoot, phase, BLOCK_SUBDIR);
            let entries = [];
            try { entries = fs.readdirSync(dir); } catch { continue; }
            for (const f of entries) {
                if (f.startsWith(prefix) && f !== '.gitkeep' && !isMarkerArtifact(f)) {
                    return {
                        pipeline, phase,
                        skill: f.slice(prefix.length),
                        file: path.join(dir, f),
                    };
                }
            }
        }
    }
    return null;
}

function reasonFilePath(blockedFile) {
    return blockedFile + '.reason.json';
}

function guidanceFilePath(targetDir, marker) {
    return path.join(targetDir, marker + '.guidance.txt');
}

function reportHumanBlock(opts) {
    const issue = Number(opts.issue);
    const skill = String(opts.skill || '').trim();
    const phase = String(opts.phase || '').trim();
    const reason = String(opts.reason || '').trim();
    const question = String(opts.question || '').trim();
    if (!issue || !skill || !phase) {
        throw new Error('reportHumanBlock requiere issue, skill, phase');
    }
    if (!reason || !question) {
        throw new Error('reportHumanBlock requiere reason y question (justificación obligatoria)');
    }

    let pipeline = opts.pipeline;
    let srcFile = null;
    if (!pipeline || opts.moveFromActive !== false) {
        const active = findActiveMarker(issue);
        if (active) {
            pipeline = pipeline || active.pipeline;
            srcFile = active.file;
        }
    }
    pipeline = pipeline || 'desarrollo';

    const targetDir = path.join(PIPELINE_DIR, pipeline, phase, BLOCK_SUBDIR);
    fs.mkdirSync(targetDir, { recursive: true });
    const marker = `${issue}.${skill}`;
    const targetFile = path.join(targetDir, marker);

    if (srcFile && fs.existsSync(srcFile)) {
        try { fs.renameSync(srcFile, targetFile); }
        catch { fs.writeFileSync(targetFile, ''); }
    } else if (!fs.existsSync(targetFile)) {
        fs.writeFileSync(targetFile, '');
    }

    fs.writeFileSync(reasonFilePath(targetFile), JSON.stringify({
        issue, skill, phase, pipeline, reason, question,
        blocked_at: new Date().toISOString(),
    }, null, 2));

    emitBlocked({ issue, skill, phase, pipeline, reason, question });

    // #2880 — aplicar label `needs-human` en GitHub. Sin esto el intake del
    // pulpo no excluye al issue y vuelve a inyectarlo en pendiente/, dejando
    // el bloqueo inconsistente entre filesystem y GitHub.
    if (opts.skipGithubLabel !== true) {
        enqueueNeedsHumanLabel(issue);
    }

    return { issue, skill, phase, pipeline, marker_path: targetFile };
}

function listBlockedIssues() {
    const result = [];
    for (const pipeline of PIPELINES) {
        const pipeRoot = path.join(PIPELINE_DIR, pipeline);
        let phases = [];
        try { phases = fs.readdirSync(pipeRoot).filter(f => fs.statSync(path.join(pipeRoot, f)).isDirectory()); }
        catch { continue; }
        for (const phase of phases) {
            const dir = path.join(pipeRoot, phase, BLOCK_SUBDIR);
            let entries = [];
            try { entries = fs.readdirSync(dir); } catch { continue; }
            for (const f of entries) {
                if (f === '.gitkeep' || isMarkerArtifact(f)) continue;
                const dot = f.indexOf('.');
                if (dot <= 0) continue;
                const issue = Number(f.slice(0, dot));
                const skill = f.slice(dot + 1);
                if (!Number.isFinite(issue)) continue;
                const file = path.join(dir, f);
                let reason = '', question = '', blockedAt = null;
                try {
                    const meta = JSON.parse(fs.readFileSync(reasonFilePath(file), 'utf8'));
                    reason = meta.reason || '';
                    question = meta.question || '';
                    blockedAt = meta.blocked_at || null;
                } catch {}
                let mtime;
                try { mtime = fs.statSync(file).mtimeMs; } catch { mtime = Date.now(); }
                const ageHours = (Date.now() - mtime) / 3600000;
                result.push({
                    issue, skill, phase, pipeline,
                    reason, question,
                    blocked_at: blockedAt || new Date(mtime).toISOString(),
                    age_hours: Math.round(ageHours * 10) / 10,
                    marker_path: file,
                });
            }
        }
    }
    return result.sort((a, b) => b.age_hours - a.age_hours);
}

function unblockIssue(opts) {
    const issue = Number(opts.issue);
    if (!issue) throw new Error('unblockIssue requiere issue');
    const guidance = String(opts.guidance || '').trim();
    const unlocker = opts.unlocker || 'commander';

    const blocked = findBlockedMarker(issue);
    if (!blocked) {
        return { ok: false, error: `Issue ${issue} no está en bloqueado-humano/` };
    }

    const targetPhase = opts.target_phase || blocked.phase;
    const targetDir = path.join(PIPELINE_DIR, blocked.pipeline, targetPhase, 'pendiente');
    fs.mkdirSync(targetDir, { recursive: true });
    const marker = `${issue}.${blocked.skill}`;
    const targetFile = path.join(targetDir, marker);

    try { fs.renameSync(blocked.file, targetFile); }
    catch { fs.writeFileSync(targetFile, ''); try { fs.unlinkSync(blocked.file); } catch {} }

    if (guidance) {
        try { fs.writeFileSync(guidanceFilePath(targetDir, marker), guidance); } catch {}
    }
    try { fs.unlinkSync(reasonFilePath(blocked.file)); } catch {}

    emitUnblocked({
        issue, skill: blocked.skill, phase: blocked.phase, pipeline: blocked.pipeline,
        target_phase: targetPhase, guidance, unlocker,
    });

    return {
        ok: true, issue, skill: blocked.skill, pipeline: blocked.pipeline,
        from_phase: blocked.phase, to_phase: targetPhase, marker_path: targetFile,
    };
}

function dismissBlockedIssue(opts) {
    const issue = Number(opts.issue);
    if (!issue) throw new Error('dismissBlockedIssue requiere issue');
    const reason = String(opts.reason || '').trim();
    const unlocker = opts.unlocker || 'commander';

    const blocked = findBlockedMarker(issue);
    if (!blocked) {
        return { ok: false, error: `Issue ${issue} no está en bloqueado-humano/` };
    }

    try { fs.unlinkSync(blocked.file); } catch {}
    try { fs.unlinkSync(reasonFilePath(blocked.file)); } catch {}

    emitDismissed({
        issue, skill: blocked.skill, phase: blocked.phase, pipeline: blocked.pipeline,
        reason, unlocker,
    });

    return {
        ok: true, issue, skill: blocked.skill, pipeline: blocked.pipeline,
        phase: blocked.phase, reason,
    };
}

// #2549 — Heurística para detectar motivos de rechazo que en realidad son
// bloqueos humanos (PR esperando merge manual, CODEOWNERS, etc).
//
// El pulpo usa esto antes de procesar un rechazo como "rebote técnico". Si
// match → reportHumanBlock() en vez de incrementar rev y devolver a pendiente.
//
// Patrones literales (case-insensitive, sin regex backtracking):
const HUMAN_BLOCK_PATTERNS = [
    /\bbloqueo\s+humano\b/i,
    /\bbloqueo[-_\s]humano\b/i,
    /\bbloqueado(?:\s+por)?\s+humano\b/i,
    /\bnecesita(?:\s+intervenci[oó]n)?\s+humana?\b/i,
    /\brequiere(?:\s+intervenci[oó]n)?\s+humana?\b/i,
    /\bneeds[-_:\s]?human\b/i,
    /\bhuman[-_\s]review\s+required\b/i,
    /\bmerge\s+(?:manual|humano|bloqueado)\b/i,
    /\bmerge\s+pendiente\s+humano\b/i,
    /\bcodeowners?\b.*\b(?:bloque|merge|aprobaci|review)/i,
    /\bPR\s+#?\d+\s+(?:mergeable|esperando|pendiente)\b.*\b(?:merge|humano|review)/i,
    /\bpending\s+human\s+(?:review|merge|approval)\b/i,
    /\baprobaci[oó]n\s+humana\s+pendiente\b/i,
];

/**
 * Devuelve true si el motivo (string) indica un bloqueo humano.
 * Usado por pulpo.js antes de tratar el rechazo como rebote técnico.
 */
function isHumanBlockReason(motivo) {
    if (!motivo || typeof motivo !== 'string') return false;
    const txt = motivo.trim();
    if (!txt) return false;
    for (const re of HUMAN_BLOCK_PATTERNS) {
        if (re.test(txt)) return true;
    }
    return false;
}

/**
 * Genera una pregunta razonable a partir del motivo cuando el agente no la dejó
 * explícita (reportHumanBlock requiere question no vacía).
 */
function inferHumanBlockQuestion(motivo, opts = {}) {
    const m = String(motivo || '').slice(0, 280).trim();
    const skill = opts.skill ? `[${opts.skill}] ` : '';
    if (/\bPR\s+#?\d+/i.test(m)) {
        return `${skill}¿Podés mergear el PR mencionado o quitar el bloqueo de CODEOWNERS para que el pipeline siga? Detalle: ${m}`;
    }
    if (/codeowners/i.test(m)) {
        return `${skill}¿Podés revisar/aprobar este cambio? CODEOWNERS está pidiendo intervención humana. Detalle: ${m}`;
    }
    return `${skill}¿Podés revisar este bloqueo y darnos orientación? Detalle: ${m}`;
}

/**
 * Construye un texto Markdown listando TODOS los bloqueados (Telegram-friendly).
 * Usado al notificar un nuevo bloqueo: además del incidente nuevo, mostramos
 * el panorama completo de qué requiere intervención humana.
 *
 * @param {object} opts
 * @param {object} [opts.highlight] — Issue recién bloqueado a destacar al inicio.
 * @param {Array}  [opts.blocked]   — Lista (default: listBlockedIssues()).
 */
function buildBlockedSummaryMarkdown(opts = {}) {
    const blocked = Array.isArray(opts.blocked) ? opts.blocked : listBlockedIssues();
    const highlight = opts.highlight || null;
    const lines = [];

    if (highlight) {
        const tag = highlight.skill ? ` (${highlight.skill})` : '';
        lines.push(`🚧 *Issue #${highlight.issue}${tag} marcado como needs-human*`);
        if (highlight.reason) {
            lines.push(`📝 ${String(highlight.reason).slice(0, 280)}`);
        }
        if (highlight.question) {
            lines.push(`❓ ${String(highlight.question).slice(0, 280)}`);
        }
        lines.push('');
    }

    if (!blocked.length) {
        lines.push('_(sin otros incidentes bloqueados actualmente)_');
        return lines.join('\n');
    }

    lines.push(`📋 *Incidentes bloqueados esperando humano* (${blocked.length})`);
    for (const b of blocked) {
        const ageStr = b.age_hours < 1
            ? `${Math.max(1, Math.round(b.age_hours * 60))}min`
            : `${Math.round(b.age_hours)}h`;
        lines.push(`• *#${b.issue}* — ${b.skill} en ${b.phase} _(${ageStr})_`);
        const detail = (b.question || b.reason || '').toString().trim();
        if (detail) lines.push(`   ↳ ${detail.slice(0, 160)}`);
    }
    lines.push('');
    lines.push('_Usá_ `/unblock <issue> <orientación>` _para desbloquear._');
    return lines.join('\n');
}

// =============================================================================
// #4068 — Botones de acción rápida en la alerta de needs-human (Opción A).
//
// Metadata de las 4 acciones que SÍ cierran el ciclo del bloqueo. `pausar` queda
// FUERA por decisión de producto (PO #4068): no resuelve el bloqueo, solo lo
// congela, y la pausa global ya tiene su propio mecanismo.
//
// Orden del teclado 2×2 (guideline UX #4068): acción positiva/segura arriba-
// izquierda; la de mayor impacto (devolver a definición, descarta trabajo) abajo.
// =============================================================================
const ACTION_META = Object.freeze({
    'unblock':             { emoji: '✅', label: 'Aprobar (unblock)',     highImpact: false,
        consequence: 'Vas a desbloquear el issue y devolverlo a la cola del pipeline.' },
    'mas-contexto':        { emoji: '💬', label: 'Pedir contexto',        highImpact: false,
        consequence: 'Vas a pedir más contexto; el issue queda bloqueado hasta que respondas.' },
    'devolver-definicion': { emoji: '↩️', label: 'Devolver a definición', highImpact: true,
        consequence: 'Vas a devolver el issue a definición. Se descarta el trabajo de desarrollo en curso y vuelve a re-analizarse.' },
    'priorizar':           { emoji: '⬆️', label: 'Priorizar',            highImpact: false,
        consequence: 'Vas a subir la prioridad de este issue y desbloquearlo.' },
});
// Filas del teclado (2×2). Single source para markup y validación de cobertura.
const ACTION_KEYBOARD_ROWS = Object.freeze([
    ['unblock', 'mas-contexto'],
    ['devolver-definicion', 'priorizar'],
]);
const HUMAN_BLOCK_ACTIONS = Object.freeze(ACTION_KEYBOARD_ROWS.flat());

function isQuickAction(action) {
    return HUMAN_BLOCK_ACTIONS.includes(action);
}

// Encolar una orden genérica en la cola del servicio-github (label / remove-label
// / comment). Generaliza enqueueNeedsHumanLabel. Fire-and-forget vía filesystem:
// nunca bloquea ni invoca `gh` en proceso (regla "el pipeline no puede morir").
function enqueueGithub(action, payload = {}) {
    try {
        fs.mkdirSync(GH_QUEUE_DIR, { recursive: true });
        const issue = Number(payload.issue);
        const rnd = Math.random().toString(36).slice(2, 8);
        const filename = `${issue}-${action}-hb-${Date.now()}-${rnd}.json`;
        fs.writeFileSync(
            path.join(GH_QUEUE_DIR, filename),
            JSON.stringify({ ...payload, action, issue }),
        );
        return true;
    } catch {
        return false;
    }
}

/**
 * #4068 / CA-1 — Construye el `reply_markup` (inline_keyboard 2×2) con los 4
 * botones URL no-mutantes hacia el dashboard. Cada URL lleva un token HMAC
 * firmado (un solo uso + exp) que autoriza la acción sobre ESE issue.
 *
 * NO cambia la firma de buildBlockedSummaryMarkdown (CA-Q1) — es un helper
 * aparte. Si el secreto del token no está disponible, devuelve `undefined`:
 * el caller manda igual el resumen de texto, solo sin botones (degradación
 * con gracia, nunca rompe la notificación).
 *
 * @param {number} issue
 * @param {object} [opts]
 * @param {object} [opts.actionToken]   - módulo de token (inyectable en tests).
 * @param {string} [opts.dashboardUrl]  - base URL del dashboard.
 * @returns {object|undefined} `{ inline_keyboard: [...] }` o undefined.
 */
function buildBlockedActionMarkup(issue, opts = {}) {
    const i = Number(issue);
    if (!Number.isInteger(i) || i <= 0 || i > 999999) return undefined;
    let actionToken;
    try { actionToken = opts.actionToken || require('./action-token'); }
    catch { return undefined; }
    const dashUrl = (opts.dashboardUrl || process.env.DASHBOARD_URL || 'http://localhost:3200').replace(/\/+$/, '');
    const makeBtn = (action) => {
        const meta = ACTION_META[action];
        if (!meta) return null;
        let token;
        try { token = actionToken.sign({ issue: i, action }); }
        catch { return null; }
        if (!token) return null;
        return {
            text: `${meta.emoji} ${meta.label}`,
            url: `${dashUrl}/?action=${action}&issue=${i}&token=${encodeURIComponent(token)}`,
        };
    };
    const rows = ACTION_KEYBOARD_ROWS
        .map((row) => row.map(makeBtn).filter(Boolean))
        .filter((row) => row.length > 0);
    if (!rows.length) return undefined;
    return { inline_keyboard: rows };
}

// Reactiva TODOS los markers bloqueados de un issue (un issue puede tener varios
// skills pausados en paralelo). Idempotente: si no hay ninguno, no-op.
function reactivateAllBlocked(issue, opts = {}) {
    const unblock = opts.unblockIssue || unblockIssue;
    const reactivated = [];
    for (let k = 0; k < 20; k++) {
        let r;
        try { r = unblock({ issue, guidance: opts.guidance || '', unlocker: opts.unlocker || 'human-block-action' }); }
        catch { break; }
        if (!r || !r.ok) break;
        reactivated.push(r);
    }
    return reactivated;
}

/**
 * #4068 / CA-2 — Ejecuta la acción rápida sobre el issue. Mutaciones vía la cola
 * del servicio-github (no `gh` en proceso). Idempotente / state-checked: si el
 * issue ya no está bloqueado, las acciones que dependen del bloqueo son no-op
 * (link viejo / doble-click = no-op, SEC-5).
 *
 * NO autoriza: el caller (handler dashboard con token válido, o commander con
 * allowlist de operadores) decide autorización ANTES de invocar.
 *
 * @param {object} args
 * @param {number} args.issue
 * @param {string} args.action  - una de HUMAN_BLOCK_ACTIONS.
 * @param {object} [args.deps]  - overrides para tests.
 * @returns {{ok:boolean, action?:string, issue?:number, msg?:string, error?:string}}
 */
function executeQuickAction({ issue, action, deps = {} } = {}) {
    const i = Number(issue);
    if (!Number.isInteger(i) || i <= 0 || i > 999999) return { ok: false, error: 'issue inválido' };
    if (!isQuickAction(action)) return { ok: false, error: 'action inválida' };

    const enqueue = deps.enqueueGithub || enqueueGithub;
    const findBlocked = deps.findBlockedMarker || findBlockedMarker;
    const dismiss = deps.dismissBlockedIssue || dismissBlockedIssue;
    const reactivate = (extra) => reactivateAllBlocked(i, { ...deps, ...extra });

    switch (action) {
        case 'unblock': {
            const reactivated = reactivate({ unlocker: 'human-block-action:unblock' });
            enqueue('remove-label', { issue: i, label: NEEDS_HUMAN_LABEL });
            if (reactivated.length === 0) {
                return { ok: true, action, issue: i, noop: true, msg: `#${i} ya no estaba bloqueado (acción ya resuelta).` };
            }
            enqueue('comment', { issue: i, body: `## ✅ Desbloqueado desde la alerta de Telegram\n\nSkills reactivados: ${reactivated.map((r) => `\`${r.skill}\``).join(', ')}. Vuelve a la cola del pipeline.` });
            return { ok: true, action, issue: i, reactivated: reactivated.length, msg: `#${i} desbloqueado (${reactivated.length} skill${reactivated.length === 1 ? '' : 's'}).` };
        }
        case 'mas-contexto': {
            // Mantiene el bloqueo; registra el pedido de contexto.
            enqueue('comment', { issue: i, body: `## 💬 Se pidió más contexto\n\nUn humano pidió más contexto desde la alerta de Telegram. El issue queda en \`needs-human\` hasta que se responda.` });
            return { ok: true, action, issue: i, msg: `Se pidió más contexto en #${i}; queda bloqueado.` };
        }
        case 'devolver-definicion': {
            const blocked = findBlocked(i);
            let dismissed = false;
            if (blocked) {
                try { const r = dismiss({ issue: i, reason: 'Devuelto a definición desde la alerta de Telegram', unlocker: 'human-block-action:devolver' }); dismissed = !!(r && r.ok); }
                catch { /* best-effort */ }
            }
            enqueue('remove-label', { issue: i, label: NEEDS_HUMAN_LABEL });
            enqueue('label', { issue: i, label: 'needs-definition' });
            enqueue('comment', { issue: i, body: `## ↩️ Devuelto a definición\n\nUn humano devolvió #${i} a definición desde la alerta de Telegram. Se descarta el trabajo de desarrollo en curso y el issue vuelve a re-analizarse.` });
            return { ok: true, action, issue: i, dismissed, msg: `#${i} devuelto a definición.` };
        }
        case 'priorizar': {
            // Sube prioridad Y desbloquea (PO #4068: "sube prioridad y sigue").
            const reactivated = reactivate({ unlocker: 'human-block-action:priorizar' });
            enqueue('label', { issue: i, label: 'priority:high' });
            enqueue('remove-label', { issue: i, label: NEEDS_HUMAN_LABEL });
            enqueue('comment', { issue: i, body: `## ⬆️ Prioridad elevada\n\nUn humano subió la prioridad de #${i} a \`priority:high\` desde la alerta de Telegram${reactivated.length ? ' y lo desbloqueó' : ''}.` });
            return { ok: true, action, issue: i, reactivated: reactivated.length, msg: `Prioridad de #${i} elevada a priority:high.` };
        }
        default:
            return { ok: false, error: 'action inválida' };
    }
}

/**
 * #4068 / CA-SEC-2 — Asienta la acción rápida (autorizada o rechazada) en un
 * audit-log dedicado `audit/human-block-actions-YYYY-MM-DD.jsonl`. Nunca lanza:
 * el audit no debe romper la operación.
 */
function auditQuickAction(entry = {}) {
    try {
        const deps = entry.deps || {};
        const dir = deps.auditDir || path.join(PIPELINE_DIR, 'audit');
        const createAuditLog = deps.createAuditLog || require('./commander/audit-log').createAuditLog;
        let redact = deps.redact;
        if (typeof redact !== 'function') {
            try { redact = require('./redact').redactSensitive; } catch { redact = (s) => s; }
        }
        const audit = createAuditLog({
            dir,
            filenamePrefix: 'human-block-actions',
            redact,
            extraFields: ['issue', 'action', 'remote_address', 'message_id'],
        });
        return audit.record({
            from: entry.from || null,
            chat_id: entry.chat_id,
            raw_command: entry.action ? `/${entry.action} ${entry.issue || ''}`.trim() : '',
            intent_class: 'human-block-action',
            handler: entry.action || null,
            result_status: entry.result_status || 'ok',
            duration_ms: entry.duration_ms,
            issue: Number.isFinite(Number(entry.issue)) ? Number(entry.issue) : null,
            action: entry.action || null,
            remote_address: entry.remote_address || null,
            message_id: entry.message_id || null,
        });
    } catch (e) {
        try { process.stderr.write(`[human-block] auditQuickAction falló: ${e.message}\n`); } catch (_) {}
        return null;
    }
}

/**
 * Construye el guion narrable corto (español) para el audio TTS de la alerta
 * `needs-human` (issue #4067, split de #4050). Único lugar donde vive la
 * redacción explícita del texto fuente y el armado del guion.
 *
 * SEC-3: `reason` y `question` crudos pasan por `redactAll` ANTES de armar el
 * texto y ANTES de cualquier síntesis de voz aguas abajo. Un secreto sintetizado
 * en audio no se puede redactar después; `sanitizeForTts` del adapter es defensa
 * en profundidad, NO sustituto de esta llamada.
 *
 * G-2 (UX): el guion arranca SIEMPRE con el encabezado fijo de alerta, que
 * funciona como "earcon verbal" reconocible. No se parametriza por issue.
 * G-3 (UX): orden narrativo fijo (alerta → motivo → decisión) y cap de longitud
 * para que el audio se escuche de corrido sin fatiga. Degrada a alerta mínima si
 * el input viene vacío/parcial (mejor un alerta genérico que un audio roto).
 *
 * @param {object} opts
 * @param {string} [opts.reason]   — Motivo crudo del bloqueo.
 * @param {string} [opts.question] — Decisión/pregunta cruda que requiere humano.
 * @returns {string} Guion narrable, redactado y acotado (≤ 600 chars).
 */
function buildNeedHumanAudioText({ reason, question } = {}) {
    const motivo = redactAll(String(reason || '').trim());
    const decision = redactAll(String(question || '').trim());
    const partes = [];
    if (motivo) partes.push(`El motivo del bloqueo es: ${motivo}.`);
    if (decision) partes.push(`La decisión que necesitamos es: ${decision}.`);
    const cuerpo = partes.length ? ` ${partes.join(' ')}` : '';
    return `Atención: un issue requiere intervención humana.${cuerpo}`.slice(0, 600);
}

/**
 * Orquesta el envío best-effort del audio TTS de la alerta needs-human (#4067).
 * Dependencias inyectadas (multimedia/credenciales) para mantener este módulo
 * libre de la cadena pesada de `multimedia.js` y para que el flujo sea testeable.
 *
 * SEC-4: NUNCA lanza. Cualquier error (TTS/timeout/red) queda contenido y se
 * devuelve en el resultado. El call-site ya envió el texto antes de llamar acá,
 * así que una falla de audio jamás rompe la notificación de texto ni el barrido.
 * SEC-3: la redacción del texto fuente ocurre dentro de `buildNeedHumanAudioText`.
 *
 * NOTA SEC-5: este helper NO conoce el estado de bloqueo; la idempotencia la
 * garantiza el call-site invocándolo SOLO dentro del gate `if (!yaBloqueado)`.
 *
 * @param {object} deps
 * @param {string} [deps.reason]
 * @param {string} [deps.question]
 * @param {string} [deps.profile='need-human']
 * @param {string} [deps.botToken]
 * @param {string} [deps.chatId]
 * @param {function} [deps.textToSpeechWithMeta] — (text, {profile}) => Promise<{buffer}>
 * @param {function} [deps.sendVoiceTelegram]    — (buffer, token, chatId) => Promise<boolean>
 * @returns {Promise<{sent: boolean, skipped?: string, error?: string}>}
 */
async function sendNeedHumanAudio(deps = {}) {
    const {
        reason, question, profile = 'need-human',
        botToken, chatId, textToSpeechWithMeta, sendVoiceTelegram,
    } = deps;
    try {
        if (!botToken || !chatId) return { sent: false, skipped: 'no-credentials' };
        if (typeof textToSpeechWithMeta !== 'function' || typeof sendVoiceTelegram !== 'function') {
            return { sent: false, skipped: 'no-tts' };
        }
        const audioText = buildNeedHumanAudioText({ reason, question });
        const meta = await textToSpeechWithMeta(audioText, { profile });
        if (!meta || !meta.buffer) return { sent: false, skipped: 'no-buffer' };
        const ok = await sendVoiceTelegram(meta.buffer, botToken, chatId);
        return { sent: !!ok };
    } catch (e) {
        return { sent: false, error: e && e.message ? e.message : String(e) };
    }
}

module.exports = {
    reportHumanBlock,
    unblockIssue,
    dismissBlockedIssue,
    listBlockedIssues,
    findActiveMarker,
    findBlockedMarker,
    isHumanBlockReason,
    inferHumanBlockQuestion,
    buildBlockedSummaryMarkdown,
    buildNeedHumanAudioText,
    sendNeedHumanAudio,
    enqueueNeedsHumanLabel,
    HUMAN_BLOCK_PATTERNS,
    PIPELINE_DIR,
    PIPELINES,
    BLOCK_SUBDIR,
    NEEDS_HUMAN_LABEL,
    isMarkerArtifact,
    // #4068 — acciones rápidas de needs-human
    ACTION_META,
    ACTION_KEYBOARD_ROWS,
    HUMAN_BLOCK_ACTIONS,
    isQuickAction,
    enqueueGithub,
    buildBlockedActionMarkup,
    executeQuickAction,
    auditQuickAction,
};
