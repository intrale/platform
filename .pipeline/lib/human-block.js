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

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');
const PIPELINES = ['desarrollo', 'definicion'];
const BLOCK_SUBDIR = 'bloqueado-humano';
const ACTIVE_STATES = ['pendiente', 'trabajando', 'listo'];

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
                    if (f.startsWith(prefix) && f !== '.gitkeep') {
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
                if (f.startsWith(prefix) && f !== '.gitkeep') {
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
                if (f === '.gitkeep' || f.endsWith('.reason.json')) continue;
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
    HUMAN_BLOCK_PATTERNS,
    PIPELINE_DIR,
    PIPELINES,
    BLOCK_SUBDIR,
};
