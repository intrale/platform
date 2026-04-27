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

    // Conteos por área para los badges de la botonera del home (#2801).
    // Se calculan acá porque header poll cada 5s ya alcanza para refrescarlos.
    let equipoActive = 0;
    for (const data of Object.values(state.issueMatrix || {})) {
        for (const entries of Object.values(data.fases || {})) {
            for (const e of entries) if (e.estado === 'trabajando') equipoActive++;
        }
    }
    const pipelineActive = Object.keys(state.issueMatrix || {}).length;
    const bloqueadosCount = (state.bloqueados || []).length;
    const historialCount = (state.actividad || []).length;

    return {
        mode,
        allowedIssues,
        pulpoAlive,
        pulpoUptimeMs: procesos.pulpo?.uptime || 0,
        counts: {
            equipo: equipoActive,
            pipeline: pipelineActive,
            bloqueados: bloqueadosCount,
            issues: pipelineActive,
            matriz: pipelineActive,
            historial: historialCount,
        },
        timestamp: Date.now(),
    };
}

// `gh pr list` tarda ~3-4s y los PRs mergeados de 7 días no cambian rápido.
// Cache de 5 min para no bloquear el endpoint /api/dash/kpis cada poll.
let _prsCache = { value: null, at: 0 };
const PRS_CACHE_TTL_MS = 5 * 60 * 1000;

// Snapshot del aggregator V3 — TTL más agresivo (10 min) porque generar el
// snapshot es lento (escanea activity-log.jsonl entero) y los tokens no
// cambian en milisegundos. Refresh en background sin bloquear la response.
let _snapshotRefreshing = false;
let _snapshotLastRefresh = 0;
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

function maybeRefreshSnapshot(ROOT, snapshotPath) {
    if (_snapshotRefreshing) return;
    let mtimeMs = 0;
    try { mtimeMs = require('fs').statSync(snapshotPath).mtimeMs; } catch {}
    const ageMs = Date.now() - mtimeMs;
    if (ageMs < SNAPSHOT_TTL_MS && Date.now() - _snapshotLastRefresh < SNAPSHOT_TTL_MS) return;
    _snapshotRefreshing = true;
    _snapshotLastRefresh = Date.now();
    // Lanza aggregator --once en background (fire-and-forget). Cuando termine,
    // el siguiente poll de /api/dash/kpis va a leer el snapshot fresh.
    try {
        const { spawn } = require('child_process');
        const aggregatorPath = path.join(__dirname, '..', 'metrics', 'aggregator.js');
        const child = spawn(process.execPath, [aggregatorPath, '--once'], {
            cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.unref();
        child.on('exit', () => { _snapshotRefreshing = false; });
        child.on('error', () => { _snapshotRefreshing = false; });
    } catch { _snapshotRefreshing = false; }
}

function kpisSlice(state, ctx) {
    const PIPELINE = ctx.PIPELINE;
    const ROOT = ctx.ROOT;
    const GH_BIN = ctx.GH_BIN;

    let prsLast7d = _prsCache.value;
    if (Date.now() - _prsCache.at > PRS_CACHE_TTL_MS) {
        try {
            const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
            const result = execSync(
                `"${GH_BIN}" pr list --state merged --search "merged:>=${since}" --json number --limit 200`,
                { cwd: ROOT, encoding: 'utf8', timeout: 8000, windowsHide: true }
            );
            prsLast7d = JSON.parse(result || '[]').length;
            _prsCache = { value: prsLast7d, at: Date.now() };
        } catch { /* gh offline — mantener valor previo del cache si existe */ }
    }

    let tokens24h = null;
    let snapshot = null;
    try {
        const snapPath = path.join(PIPELINE, 'metrics', 'snapshot.json');
        // Lanzar refresh background si el snapshot es viejo (>10 min). No
        // bloquea la response actual; el siguiente poll va a leer fresh.
        maybeRefreshSnapshot(ROOT, snapPath);
        snapshot = safeReadJson(snapPath, null);
        if (snapshot && snapshot.totals) {
            // El snapshot del aggregator usa snake_case (tokens_in, tokens_out).
            // Suma puede ser 0 si el log no tiene eventos con tokens contables;
            // en ese caso retornamos null para que la UI muestre "—".
            const sum = (snapshot.totals.tokens_in || 0) + (snapshot.totals.tokens_out || 0);
            tokens24h = sum > 0 ? sum : null;
        }
    } catch { /* ignore */ }

    let cycleTimeMs = null;
    try {
        const allDurations = [];
        for (const data of Object.values(state.issueMatrix || {})) {
            for (const entries of Object.values(data.fases || {})) {
                for (const e of entries) {
                    // Filtros: estado terminal + duración entre 1 segundo y 24 horas.
                    // < 1s descarta ruido del FS (timestamps casi iguales).
                    // > 24h descarta archivos huérfanos antiguos que distorsionan la mediana.
                    if ((e.estado === 'procesado' || e.estado === 'listo')
                        && e.durationMs >= 1000
                        && e.durationMs < 24 * 3600000) {
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

function pipelineSlice(state, ctx) {
    const matrix = {};
    // matrixCounts[faseKey][skill] = N — cuántos issues activos hay en cada
    // combinación skill × fase. Se cuenta solo estados activos
    // (pendiente/trabajando/listo); procesado/archivado no cuentan porque
    // ya salieron del flujo.
    const matrixCounts = {};
    const ACTIVE_STATES = new Set(['pendiente', 'trabajando', 'listo']);
    for (const [issueId, data] of Object.entries(state.issueMatrix || {})) {
        matrix[issueId] = {
            title: data.title,
            labels: data.labels,
            faseActual: data.faseActual,
            estadoActual: data.estadoActual,
            bounces: data.bounces,
            staleMin: data.staleMin,
            rebote: !!data.rebote,
            rebote_tipo: data.rebote_tipo || null,
            motivo_rechazo: data.motivo_rechazo || null,
            rechazado_en_fase: data.rechazado_en_fase || null,
            rechazado_skill_previo: data.rechazado_skill_previo || null,
        };
        for (const [faseKey, entries] of Object.entries(data.fases || {})) {
            for (const e of entries) {
                if (!ACTIVE_STATES.has(e.estado)) continue;
                if (!matrixCounts[faseKey]) matrixCounts[faseKey] = {};
                matrixCounts[faseKey][e.skill] = (matrixCounts[faseKey][e.skill] || 0) + 1;
            }
        }
    }
    // Orden manual de prioridad (#2801) — el cliente lo usa para ordenar
    // las columnas del kanban. Sin esto cada cliente ordena distinto.
    let priorityOrder = [];
    try {
        const issueOrder = require('./issue-order');
        const data = issueOrder.load();
        priorityOrder = (data && Array.isArray(data.order)) ? data.order.map(String) : [];
    } catch { /* lib no disponible */ }
    return { matrix, fases: state.allFases, priorityOrder, matrixCounts };
}

function bloqueadosSlice(state) {
    let priorityOrder = [];
    try {
        const issueOrder = require('./issue-order');
        const data = issueOrder.load();
        priorityOrder = (data && Array.isArray(data.order)) ? data.order.map(String) : [];
    } catch { /* lib no disponible */ }
    const orderMap = new Map(priorityOrder.map((id, idx) => [id, idx]));
    const sorted = [...(state.bloqueados || [])].sort((a, b) => {
        const oa = orderMap.get(String(a.issue));
        const ob = orderMap.get(String(b.issue));
        if (oa != null && ob != null) return oa - ob;
        if (oa != null) return -1;
        if (ob != null) return 1;
        return Number(a.issue) - Number(b.issue);
    });
    const enriched = sorted.map(b => ({
        ...b,
        priorityIndex: orderMap.has(String(b.issue)) ? orderMap.get(String(b.issue)) + 1 : null,
    }));
    return { bloqueados: enriched };
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

// #2801 — Cuota semanal del Plan Max de Anthropic. Sin API pública,
// aproximamos sumando duration_ms de session:end del activity-log.
// Auto-ajuste pasivo: si el observado supera el effective_limit sin
// bloqueos detectados, sube el límite. Ver lib/weekly-quota.js.
function quotaSlice(state, ctx) {
    const PIPELINE = ctx.PIPELINE;
    const ROOT = ctx.ROOT;
    try {
        const quotaLib = require('./weekly-quota');
        const metricsDir = path.join(PIPELINE, 'metrics');
        const activityLog = path.join(ROOT, '.claude', 'activity-log.jsonl');
        const configLimitHours = Number(process.env.ANTHROPIC_MAX_WEEKLY_HOURS) || undefined;
        return quotaLib.computeQuota(metricsDir, activityLog, { configLimitHours });
    } catch (e) {
        return { error: e.message, hoursUsed7d: 0, pct: 0, status: 'unknown' };
    }
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
    quotaSlice,
};
