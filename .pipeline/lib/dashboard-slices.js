// V3 Slices — funciones puras que extraen rebanadas específicas del pipeline state.
// Cada slice retorna SOLO la información que su endpoint necesita, para minimizar
// payload en el polling independiente del dashboard kiosk.
//
// Las funciones reciben `state` (lo que retorna getPipelineState()) + `ctx` con
// utilidades que el módulo necesita (PIPELINE dir, GH_BIN, etc.).

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function safeReadJson(filepath, fallback) {
    try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
    catch { return fallback; }
}

function activeAgents(state) {
    const out = [];
    for (const [issueId, data] of Object.entries(state.issueMatrix || {})) {
        if (data.estadoActual !== 'trabajando') continue;
        const entries = data.fases[data.faseActual] || [];
        for (const e of entries) {
            if (e.estado !== 'trabajando') continue;
            out.push({
                issue: issueId,
                title: data.title || '',
                skill: e.skill,
                pipeline: e.pipeline,
                fase: e.fase,
                durationMs: e.durationMs || 0,
                ageMin: e.ageMin || 0,
                hasLog: !!e.hasLog,
                logFile: e.logFile,
                etaMs: (state.etaAverages && state.etaAverages[`${e.fase}/${e.skill}`]?.avgMs) ||
                       (state.etaAverages && state.etaAverages[e.fase]?.avgMs) || null,
            });
        }
    }
    out.sort((a, b) => b.durationMs - a.durationMs);
    return out;
}

function recentlyFinished(state, limit = 3) {
    const out = [];
    for (const [issueId, data] of Object.entries(state.issueMatrix || {})) {
        for (const [faseKey, entries] of Object.entries(data.fases || {})) {
            for (const e of entries) {
                if (e.estado !== 'listo' && e.estado !== 'procesado') continue;
                if (!e.updatedAt) continue;
                out.push({
                    issue: issueId,
                    title: data.title || '',
                    skill: e.skill,
                    pipeline: e.pipeline,
                    fase: e.fase,
                    resultado: e.resultado || null,
                    durationMs: e.durationMs || 0,
                    finishedAt: e.updatedAt,
                    hasLog: !!e.hasLog,
                    logFile: e.logFile,
                });
            }
        }
    }
    out.sort((a, b) => b.finishedAt - a.finishedAt);
    return out.slice(0, limit);
}

function nextInQueue(state, ctx, limit = 3) {
    const PIPELINE = ctx.PIPELINE;
    const out = [];
    const concurrencia = state.config.concurrencia || {};
    const skillLoad = {};
    for (const skill of Object.keys(concurrencia)) {
        skillLoad[skill] = { running: 0, max: concurrencia[skill] };
    }
    for (const [, data] of Object.entries(state.issueMatrix || {})) {
        for (const entries of Object.values(data.fases || {})) {
            for (const e of entries) {
                if (e.estado === 'trabajando' && skillLoad[e.skill]) {
                    skillLoad[e.skill].running++;
                }
            }
        }
    }

    const seen = new Set();
    for (const { pipeline: pName, fase } of state.allFases || []) {
        const dir = path.join(PIPELINE, pName, fase, 'pendiente');
        let files = [];
        try { files = fs.readdirSync(dir).filter(f => !f.startsWith('.')); } catch { continue; }
        for (const f of files) {
            const issue = f.split('.')[0];
            const skill = f.split('.').slice(1).join('.');
            const key = `${issue}.${skill}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const data = state.issueMatrix?.[issue];
            const load = skillLoad[skill] || { running: 0, max: 0 };
            const slotFree = load.running < load.max;
            out.push({
                issue,
                title: data?.title || '',
                skill,
                pipeline: pName,
                fase,
                slotFree,
                slotInfo: `${load.running}/${load.max}`,
                bounces: data?.bounces || 0,
                etaMs: (state.etaAverages && state.etaAverages[`${fase}/${skill}`]?.avgMs) ||
                       (state.etaAverages && state.etaAverages[fase]?.avgMs) || null,
            });
            if (out.length >= limit * 4) break;
        }
        if (out.length >= limit * 4) break;
    }
    out.sort((a, b) => {
        if (a.slotFree !== b.slotFree) return a.slotFree ? -1 : 1;
        return (b.bounces || 0) - (a.bounces || 0);
    });
    return out.slice(0, limit);
}

function headerSlice(state, ctx) {
    const PIPELINE = ctx.PIPELINE;
    const partialFile = path.join(PIPELINE, '.partial-pause.json');
    const pauseFile = path.join(PIPELINE, '.paused');
    let mode = 'running';
    let allowedIssues = [];
    if (fs.existsSync(pauseFile)) {
        mode = 'paused';
    } else if (fs.existsSync(partialFile)) {
        const data = safeReadJson(partialFile, {});
        const arr = Array.isArray(data.allowed_issues) ? data.allowed_issues : [];
        if (arr.length > 0) {
            mode = 'partial_pause';
            allowedIssues = arr;
        }
    }
    const procesos = state.procesos || {};
    const pulpoAlive = !!(procesos.pulpo && procesos.pulpo.alive);
    return {
        mode,
        allowedIssues,
        pulpoAlive,
        pulpoUptimeMs: procesos.pulpo?.uptime || 0,
        timestamp: Date.now(),
    };
}

function kpisSlice(state, ctx) {
    const PIPELINE = ctx.PIPELINE;
    const ROOT = ctx.ROOT;
    const GH_BIN = ctx.GH_BIN;

    let prsLast7d = null;
    try {
        const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
        const result = execSync(
            `"${GH_BIN}" pr list --state merged --search "merged:>=${since}" --json number --limit 200`,
            { cwd: ROOT, encoding: 'utf8', timeout: 8000, windowsHide: true }
        );
        prsLast7d = JSON.parse(result || '[]').length;
    } catch { /* gh offline */ }

    let tokens24h = null;
    let snapshot = null;
    try {
        const snapPath = path.join(PIPELINE, 'metrics', 'snapshot.json');
        snapshot = safeReadJson(snapPath, null);
        if (snapshot && snapshot.totals) {
            tokens24h = snapshot.totals.tokensInput + snapshot.totals.tokensOutput || null;
        }
    } catch { /* ignore */ }

    let cycleTimeMs = null;
    try {
        const allDurations = [];
        for (const data of Object.values(state.issueMatrix || {})) {
            for (const entries of Object.values(data.fases || {})) {
                for (const e of entries) {
                    if ((e.estado === 'procesado' || e.estado === 'listo') && e.durationMs && e.durationMs > 0 && e.durationMs < 6 * 3600000) {
                        allDurations.push(e.durationMs);
                    }
                }
            }
        }
        if (allDurations.length > 0) {
            allDurations.sort((a, b) => a - b);
            cycleTimeMs = allDurations[Math.floor(allDurations.length / 2)];
        }
    } catch { /* ignore */ }

    let bouncePct = null;
    try {
        let total = 0;
        let rejected = 0;
        for (const data of Object.values(state.issueMatrix || {})) {
            for (const entries of Object.values(data.fases || {})) {
                for (const e of entries) {
                    if (e.estado !== 'procesado' && e.estado !== 'listo') continue;
                    if (!e.resultado) continue;
                    total++;
                    if (e.resultado === 'rechazado') rejected++;
                }
            }
        }
        if (total > 0) bouncePct = Math.round((rejected / total) * 1000) / 10;
    } catch { /* ignore */ }

    return {
        prsLast7d,
        tokens24h,
        cycleTimeMs,
        bouncePct,
        timestamp: Date.now(),
    };
}

function equipoSlice(state) {
    const skillLoad = state.skillLoad || {};
    const skills = Object.entries(skillLoad).map(([skill, load]) => ({
        skill,
        running: load.running,
        max: load.max,
        utilization: load.max > 0 ? load.running / load.max : 0,
    }));
    return { skills };
}

function pipelineSlice(state) {
    const matrix = {};
    for (const [issueId, data] of Object.entries(state.issueMatrix || {})) {
        matrix[issueId] = {
            title: data.title,
            labels: data.labels,
            faseActual: data.faseActual,
            estadoActual: data.estadoActual,
            bounces: data.bounces,
            staleMin: data.staleMin,
        };
    }
    return { matrix, fases: state.allFases };
}

function bloqueadosSlice(state) {
    return { bloqueados: state.bloqueados || [] };
}

function opsSlice(state) {
    return {
        procesos: state.procesos || {},
        servicios: state.servicios || {},
        infraHealth: state.infraHealth || {},
        qaEnv: state.qaEnv || {},
        qaRemote: state.qaRemote || {},
        resources: state.resources || {},
    };
}

function historialSlice(state) {
    return { actividad: (state.actividad || []).slice(-30) };
}

module.exports = {
    activeAgents,
    recentlyFinished,
    nextInQueue,
    headerSlice,
    kpisSlice,
    equipoSlice,
    pipelineSlice,
    bloqueadosSlice,
    opsSlice,
    historialSlice,
};
