// V3 Human-block helpers — estado transversal "bloqueado-humano" (issue #2478).
//
// Cualquier skill puede invocar reportHumanBlock() cuando detecte ambigüedad real
// que una intervención corta del humano resolvería. El issue queda pausado:
// no rebota, no consume tokens, hasta que se invoque unblockIssue().
//
// Marker en disco: <pipeline>/<phase>/bloqueado-humano/<issue>.<skill>
// Label GitHub: needs:human
// Eventos activity-log: human:blocked / human:unblocked
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

module.exports = {
    reportHumanBlock,
    unblockIssue,
    listBlockedIssues,
    findActiveMarker,
    findBlockedMarker,
    PIPELINE_DIR,
    PIPELINES,
    BLOCK_SUBDIR,
};
