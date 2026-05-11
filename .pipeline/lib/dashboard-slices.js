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

// #2890 PR-A — Modo descanso (ventana horaria).
let restModeWindow = null;
try { restModeWindow = require('./rest-mode-window'); } catch { /* opcional */ }

// #2976 — Estado del flag de cuota Anthropic agotada (lectura defensiva).
// Tolerante a la ausencia del módulo: si #2974 todavía no aterrizó, el slice
// degrada a `{ active: false }` y nada del dashboard se rompe.
let quotaExhaustedState = null;
try { quotaExhaustedState = require('./quota-exhausted-state'); } catch { /* opcional */ }

// #2976 — Skills determinísticos: corren en Node puro sin tokens LLM y por
// eso siguen ejecutándose aún con `quota-exhausted.json` activo. Mantener
// sincronizado con `DETERMINISTIC_SKILLS` del detector (#2974,
// `lib/quota-exhausted.js`). Si divergen, el dashboard puede mostrar un
// conteo distinto al gate real del pulpo.
const DETERMINISTIC_SKILLS = new Set(['builder', 'tester', 'delivery', 'linter']);

// #3023 — Filtro de la cola "Próximos 10" por allowlist de pausa parcial.
// Importación defensiva: si el módulo no está disponible (edge: checkout
// pre-#2490), `nextInQueue` degrada a comportamiento running (sin filtro).
let partialPause = null;
try { partialPause = require('./partial-pause'); } catch { /* opcional */ }

// Detector de artifacts auxiliares (.guidance.txt, .reason.json, .comment.md,
// y cualquier filename con > 2 segmentos). Compartido con human-block para
// que ambos listadores excluyan los mismos fantasmas. Fallback defensivo si
// el módulo no carga.
let isMarkerArtifact;
try { ({ isMarkerArtifact } = require('./human-block')); } catch { /* opcional */ }
if (typeof isMarkerArtifact !== 'function') {
    isMarkerArtifact = (name) => name.split('.').length > 2
        || name.endsWith('.reason.json')
        || name.endsWith('.guidance.txt')
        || name.endsWith('.comment.md');
}

function isDeterministicSkill(skill) {
    return DETERMINISTIC_SKILLS.has(String(skill || '').trim().toLowerCase());
}

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

// #3035 — Flag opcional `onlyRejected`: si está en true, retorna solo
// entries con `resultado === 'rechazado'`. Filtrado en server (CA-7,
// defense-in-depth) — el cliente NO recibe la lista completa para
// filtrar localmente.
function recentlyFinished(state, limit = 3, opts = {}) {
    const onlyRejected = !!(opts && opts.onlyRejected);
    const out = [];
    for (const [issueId, data] of Object.entries(state.issueMatrix || {})) {
        for (const [faseKey, entries] of Object.entries(data.fases || {})) {
            for (const e of entries) {
                if (e.estado !== 'listo' && e.estado !== 'procesado') continue;
                if (!e.updatedAt) continue;
                if (onlyRejected && e.resultado !== 'rechazado') continue;
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

function nextInQueue(state, ctx, limit = 3, opts = {}) {
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

    // Resolver pipelineMode UNA vez antes del loop. Necesario para filtrar
    // inline contra la allowlist (ver más abajo) y evitar que el early-break
    // de `out.length >= limit * 4` se consuma con items que después van a
    // descartarse por pausa parcial.
    //
    // `opts.pipelineMode` permite a callers (route handler, tests) inyectar
    // el modo ya leído. Si no se pasa, se lee del filesystem vía el módulo
    // `partial-pause` (lectura barata, dos `existsSync` + un `readFileSync`).
    let ppState = opts.pipelineMode || null;
    if (!ppState && partialPause && typeof partialPause.getPipelineMode === 'function') {
        try { ppState = partialPause.getPipelineMode(); } catch { ppState = null; }
    }
    const ppActive = !!(ppState && ppState.mode === 'partial_pause'
        && partialPause && typeof partialPause.isIssueAllowedInState === 'function');

    const seen = new Set();
    for (const { pipeline: pName, fase } of state.allFases || []) {
        const dir = path.join(PIPELINE, pName, fase, 'pendiente');
        let files = [];
        // Filtrar artifacts (.guidance.txt, .reason.json, .comment.md, etc.)
        // para que no se traten como markers fantasma (ej: `3076.po.comment.md`
        // aparecía como agente "po.comment.md" en la cola).
        try { files = fs.readdirSync(dir).filter(f => !f.startsWith('.') && !isMarkerArtifact(f)); } catch { continue; }
        for (const f of files) {
            const issue = f.split('.')[0];
            const skill = f.split('.').slice(1).join('.');
            const key = `${issue}.${skill}`;
            if (seen.has(key)) continue;
            seen.add(key);

            // Si hay pausa parcial, filtrar inline ANTES del push. Si no
            // filtramos acá, una fase con muchos items fuera de allowlist
            // (típico: `validacion/pendiente/` con backlog histórico de
            // ~40 issues legacy) consume el early-break y oculta items
            // reales de fases posteriores (dev, aprobación, etc.).
            if (ppActive && !partialPause.isIssueAllowedInState(issue, ppState)) continue;

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

    // Priority windows (QA/Build) — bloquean dev/build cuando la cola QA
    // o Build se acumula. El operador necesita verlas en el header del home
    // para saber por qué no se lanzan agentes y poder desactivarlas con un click.
    const pw = state.priorityWindows || {};
    const priorityWindows = {
        qa: {
            active: !!pw.qa?.active,
            activatedAt: pw.qa?.activatedAt || null,
            cooldownUntil: pw.qa?.cooldownUntil || null,
            manual: !!pw.qa?.manual,
        },
        build: {
            active: !!pw.build?.active,
            activatedAt: pw.build?.activatedAt || null,
            manual: !!pw.build?.manual,
        },
    };

    // Salud del sistema (CPU/RAM) — antes vivía en una sección /ops, pero el
    // operador la quiere a la vista en el home (sin tener que ir a otra tab).
    const r = state.resources || {};
    const resources = {
        cpuPercent: r.cpuPercent ?? null,
        memPercent: r.memPercent ?? null,
        memUsedGB: r.memUsedGB ?? null,
        memTotalGB: r.memTotalGB ?? null,
        cpuCores: r.cpuCores ?? null,
        maxCpu: r.maxCpu ?? 70,
        maxMem: r.maxMem ?? 70,
    };

    // #2890 PR-A — Modo descanso: pill indigo en header (CA-3.1) cuando la
    // ventana está activa. Devolvemos `restMode` aun cuando esté inactivo
    // para que el cliente pueda morphear sin re-fetchear otra cosa.
    let restMode = { active: false };
    if (restModeWindow) {
        try {
            const w = restModeWindow.getWindow({ pipelineDir: PIPELINE });
            const within = restModeWindow.isWithinWindow(w, Date.now());
            restMode = {
                active: !!w.active,
                start: w.start || null,
                end: w.end || null,
                timezone: w.timezone || null,
                days: Array.isArray(w.days) ? w.days : [],
                manual: !!w.manual,
                isWithinWindow: within,
                updatedAt: w.updatedAt || null,
            };
        } catch (e) {
            restMode = { active: false, error: e.message };
        }
    }

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
        priorityWindows,
        resources,
        restMode,
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

// #2894 — Resolución del skill efectivo para fase `dev` cuando todavía no
// hay marker en el filesystem. Replica el algoritmo del intake: respeta
// `dev_routing_priority`, cae a `dev_skill_mapping.default` si no hay match.
function resolveDevSkillFromLabels(config, labels) {
    if (!config) return null;
    const priority = Array.isArray(config.dev_routing_priority) ? config.dev_routing_priority : [];
    const mapping = config.dev_skill_mapping || {};
    const labelSet = new Set(labels || []);
    for (const lab of priority) {
        if (labelSet.has(lab) && mapping[lab]) return mapping[lab];
    }
    // Fallback: cualquier label en mapping (sin orden de prioridad).
    for (const lab of labelSet) {
        if (mapping[lab]) return mapping[lab];
    }
    return mapping.default || null;
}

// #2894 — Para cada issue, computar el listado de agentes esperados en la
// fase activa con su estado UI (☑ listo / ► trabajando / ☐ pendiente /
// ⚠ bloqueado / ✗ fallido). Solo expone la fase activa para mantener
// el payload acotado (el dashboard solo renderea la card de esa fase).
function buildAgentsForActiveFase(issueId, data, state) {
    if (!data.faseActual) return { agents: [], expectedSkills: [] };
    const [pName, fName] = data.faseActual.split('/');
    const skillsByFase = state.config?.pipelines?.[pName]?.skills_por_fase || {};
    const allExpected = Array.isArray(skillsByFase[fName]) ? skillsByFase[fName] : [];
    const entries = data.fases[data.faseActual] || [];

    // Para cada skill, consolidar el entry más reciente (los moves entre
    // pendiente/trabajando/listo dejan un único entry por skill, pero ante
    // posibles duplicados nos quedamos con el de updatedAt mayor).
    const bySkill = new Map();
    for (const e of entries) {
        const prev = bySkill.get(e.skill);
        if (!prev || (e.updatedAt || 0) >= (prev.updatedAt || 0)) {
            bySkill.set(e.skill, e);
        }
    }

    let expectedSkills;
    if (fName === 'dev') {
        // Dev = un solo skill por historia. Si hay marker, ese es el skill.
        // Si todavía no hay marker (raro pero posible), resolver desde labels.
        if (bySkill.size > 0) {
            expectedSkills = [...bySkill.keys()];
        } else {
            const resolved = resolveDevSkillFromLabels(state.config, data.labels || []);
            expectedSkills = resolved ? [resolved] : [];
        }
    } else {
        // Otras fases: criterio del issue → "no aplica = no mostrar".
        // Mostramos solo skills configurados que tienen marker en esta fase.
        // Excepción: si la fase está activa pero todavía no hay markers
        // (caso edge: issue recién encolado), mostrar todos los esperados
        // como pendientes para que el operador vea qué falta.
        const present = allExpected.filter(s => bySkill.has(s));
        if (present.length > 0) {
            expectedSkills = present;
        } else {
            expectedSkills = allExpected;
        }
    }

    // Mapa de bloqueos humanos por (issue, fase, skill) → indicador.
    // El listado vive en state.bloqueados (lo construye dashboard.js a
    // partir de human-block.listBlockedIssues()).
    const bloqueadosKey = new Set();
    for (const b of (state.bloqueados || [])) {
        if (String(b.issue) === String(issueId)) {
            bloqueadosKey.add(`${b.pipeline}|${b.phase}|${b.skill}`);
        }
    }

    const labels = data.labels || [];
    const issueNeedsHuman = labels.includes('needs-human');

    const agents = expectedSkills.map(skill => {
        const entry = bySkill.get(skill);
        let estado = 'pendiente';
        let ageMin = null;
        let hasLog = false;
        let logFile = null;
        let resultado = null;
        let motivo = null;
        if (entry) {
            estado = entry.estado || 'pendiente';
            ageMin = entry.ageMin || 0;
            hasLog = !!entry.hasLog;
            logFile = entry.logFile || null;
            resultado = entry.resultado || null;
            motivo = entry.motivo || null;
            // Un YAML en `listo/procesado` con `resultado: rechazado`
            // viene del agente reciclado pero el rebote ya quedó.
            // Para UX = ✗ fallido.
            if (resultado === 'rechazado') estado = 'fallido';
        }
        // Override por bloqueado-humano específico (tiene precedencia
        // sobre el estado del marker normal porque el marker queda
        // "congelado" en pendiente/ mientras human-block está activo).
        const blKey = `${pName}|${fName}|${skill}`;
        if (bloqueadosKey.has(blKey)) {
            estado = 'bloqueado';
        } else if (!entry && issueNeedsHuman) {
            // Sin entrada específica + label needs-human global = bloqueado.
            estado = 'bloqueado';
        }
        return { skill, estado, ageMin, hasLog, logFile, resultado, motivo };
    });

    return { agents, expectedSkills };
}

function pipelineSlice(state, ctx) {
    const matrix = {};
    // matrixCounts[faseKey][skill] = N — cuántos issues activos hay en cada
    // combinación skill × fase. Se cuenta solo estados activos
    // (pendiente/trabajando/listo); procesado/archivado no cuentan porque
    // ya salieron del flujo.
    const matrixCounts = {};
    const ACTIVE_STATES = new Set(['pendiente', 'trabajando', 'listo']);
    // #2894 — Umbral para marcar un issue como "estancado" en su fase
    // actual. Configurable vía env para que el operador pueda calibrar
    // sin redeploy. Default 30 min según el issue.
    const STALE_THRESHOLD_MIN = Number(process.env.PIPELINE_STALE_MIN_THRESHOLD) || 30;
    for (const [issueId, data] of Object.entries(state.issueMatrix || {})) {
        // #2894 — Lista de agentes en la fase activa con su estado UI.
        const { agents, expectedSkills } = buildAgentsForActiveFase(issueId, data, state);

        // #2894 — Detección de issue estancado: el agente más viejo de la
        // fase activa que NO está listo/fallido. Si su ageMin supera el
        // umbral, el issue es stale y ese agente es el "blocker" visual.
        let blockerSkill = null;
        let blockerAgeMin = 0;
        for (const a of agents) {
            if (a.estado === 'listo' || a.estado === 'fallido') continue;
            const age = a.ageMin || 0;
            if (age > blockerAgeMin) {
                blockerAgeMin = age;
                blockerSkill = a.skill;
            }
        }
        const stale = blockerAgeMin >= STALE_THRESHOLD_MIN;

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
            // #2894 — agents = listado de agentes esperados en la fase
            // activa con su estado UI. expectedSkills facilita el debug
            // sin tener que reconstruir desde agents en el cliente.
            agents,
            expectedSkills,
            stale,
            blockerSkill: stale ? blockerSkill : null,
            blockerAgeMin: stale ? blockerAgeMin : 0,
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
    return {
        matrix,
        fases: state.allFases,
        priorityOrder,
        matrixCounts,
        staleThresholdMin: STALE_THRESHOLD_MIN,
    };
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
        telegramHealth: state.telegramHealth || null,
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

// =============================================================================
// #2976 — quotaExhaustedSlice: banner amarillo de cuota Anthropic agotada.
//
// Lee el flag `.pipeline/quota-exhausted.json` vía `quota-exhausted-state.js`
// (lectura defensiva, ver hija #2974) y enriquece el payload con dos
// counters que el banner muestra en paneles comparativos (CA-5):
//
//   - `deterministicRunning`: agentes determinísticos (builder/tester/
//     delivery/linter) en estado `trabajando`. Estos NO están bloqueados
//     por el flag — son el "panel verde" del banner.
//   - `queuedSkills`: skills LLM (todo lo que NO es determinístico) con
//     archivos en `pendiente/` esperando un slot. Son los que el gate de
//     #2974 está bloqueando hasta que la cuota vuelva.
//
// Si `quota-exhausted-state` no está disponible (caso muy borde donde el
// require falla), o si el flag no está activo, retornamos shape vacío con
// `active: false` para que el cliente esconda el banner sin tirar errores.
//
// Performance: una sola lectura del flag (con cap 10KB) + un walk del
// `state.issueMatrix` ya cacheado por el dashboard. Cero IO extra contra
// el filesystem además del flag.
// =============================================================================
function quotaExhaustedSlice(state) {
    if (!quotaExhaustedState) {
        return { active: false, deterministicRunning: 0, queuedSkills: [] };
    }
    let flag;
    try {
        flag = quotaExhaustedState.getQuotaState();
    } catch {
        // Defensa extra: aún si el módulo tiene un bug, el banner no debe
        // tumbar el dashboard.
        return { active: false, deterministicRunning: 0, queuedSkills: [] };
    }
    if (!flag || !flag.active) {
        return { active: false, deterministicRunning: 0, queuedSkills: [] };
    }

    // Conteo: agentes determinísticos `trabajando` (panel "Determinísticos
    // · N corriendo") y skills LLM en `pendiente` (panel "LLM encolados ·
    // M esperando"). Recorremos issueMatrix una sola vez.
    //
    // Defensas anti-corruption: cada nivel del walk valida que la entry
    // sea un object antes de tocarla. Un null/undefined en cualquier nivel
    // (issueMatrix entry, .fases, entries) NO debe tirar el dashboard.
    let deterministicRunning = 0;
    const queuedMap = new Map();
    for (const data of Object.values(state.issueMatrix || {})) {
        if (!data || typeof data !== 'object') continue;
        const fases = data.fases;
        if (!fases || typeof fases !== 'object') continue;
        for (const entries of Object.values(fases)) {
            if (!Array.isArray(entries)) continue;
            for (const e of entries) {
                if (!e || typeof e !== 'object') continue;
                if (e.estado === 'trabajando' && isDeterministicSkill(e.skill)) {
                    deterministicRunning++;
                } else if (e.estado === 'pendiente' && !isDeterministicSkill(e.skill)) {
                    // Acumular por skill para mostrar el conteo agregado
                    // en el panel (ej: "guru ×3, po ×2"). Usamos un Map
                    // para preservar orden de aparición (≈ orden FIFO del
                    // walk, suficientemente determinístico para el banner).
                    const k = String(e.skill || 'unknown');
                    queuedMap.set(k, (queuedMap.get(k) || 0) + 1);
                }
            }
        }
    }

    const queuedSkills = [...queuedMap.entries()]
        .map(([skill, count]) => ({ skill, count }))
        .sort((a, b) => b.count - a.count); // más esperando arriba

    return {
        active: true,
        // Campos del flag, ya normalizados por quota-exhausted-state.js.
        error_type: flag.error_type,
        detected_at: flag.detected_at,
        resets_at: flag.resets_at,
        resets_at_ms: flag.resets_at_ms,
        // Paneles comparativos (CA-5).
        deterministicRunning,
        queuedSkills,
        // Conveniencia para el banner: total de LLM esperando.
        queuedCount: queuedSkills.reduce((s, x) => s + x.count, 0),
    };
}

// =============================================================================
// #2994 — reconcilerStaleOrdersSlice: contador de órdenes descartadas por stale.
//
// El servicio-github.js + servicio-reconciler.js escriben una línea JSONL en
// `.pipeline/logs/stale-orders.log` cada vez que se descarta una orden por
// alguno de estos motivos:
//
//   - stale-marker-missing   (worker: marker_path ya no existe)
//   - stale-mtime            (worker: marker_mtime cambió desde snapshot)
//   - human-unblock-detected (reconciler: detectó destrabe humano y movió marker)
//
// Este slice lee el log, filtra eventos de las últimas 24h y devuelve total +
// breakdown. El dashboard lo muestra en el tab Ops bajo "Reconciler health".
//
// Performance: lectura streaming-friendly de un archivo append-only. Cap a
// las últimas N líneas para no leer un log que crece sin bound. En operación
// normal el descarte es esporádico (≈ 1-5 por día), así que 5000 líneas
// cubren ~3 años de log sin problema.
// =============================================================================
const STALE_ORDERS_LOG_NAME = 'stale-orders.log';
const STALE_ORDERS_MAX_LINES = 5000;

function reconcilerStaleOrdersSlice(state, ctx) {
    const PIPELINE = (ctx && ctx.PIPELINE) || process.env.PIPELINE_STATE_DIR;
    if (!PIPELINE) {
        return { total_24h: 0, by_reason: {}, updated_at: new Date().toISOString() };
    }
    const logPath = path.join(PIPELINE, 'logs', STALE_ORDERS_LOG_NAME);
    let raw;
    try { raw = fs.readFileSync(logPath, 'utf8'); }
    catch { return { total_24h: 0, by_reason: {}, updated_at: new Date().toISOString() }; }

    const lines = raw.split(/\r?\n/).filter(Boolean);
    // Tomar solo las últimas N líneas — el archivo es append-only y nunca
    // queremos parsear más de eso por request del dashboard.
    const tail = lines.slice(-STALE_ORDERS_MAX_LINES);
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const byReason = {};
    let total = 0;
    for (const line of tail) {
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        const ts = ev.ts ? Date.parse(ev.ts) : NaN;
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        const reason = String(ev.reason || 'unknown');
        byReason[reason] = (byReason[reason] || 0) + 1;
        total++;
    }
    return {
        total_24h: total,
        by_reason: byReason,
        updated_at: new Date().toISOString(),
    };
}

// =============================================================================
// #2993 — Slice del widget de handoff cross-agente.
//
// Lee `.claude/activity-log.jsonl` (donde `lib/traceability.js` escribe los
// eventos `session:end`) y agrega:
//   - hit_rate_7d:  % de invocaciones que recibieron handoff válido (>0
//                   secciones inyectadas) sobre el total de session:end con
//                   feature activo en los últimos 7 días.
//   - tokens_in_24h: tokens estimados ahorrados por handoff inyectado en 24h.
//   - bytes_out_7d:  bytes totales escritos al handoff en 7 días (proxy del
//                    "trabajo capturado" por agentes).
//   - usd_saved_estimate: tokens_in_24h × precio Sonnet (proxy conservador).
//   - sparkline_7d: array de % hit-rate por día (longitud 7).
//   - kill_switch:  estado del flag (`config.handoff.kill_switch || !enabled`).
//
// CA-C1: nunca incluir contenido del handoff ni excerpts.
// CA-C2: refresh cada 30s lo manejará el cliente (este endpoint es stateless).
//
// Costo de I/O: el archivo es append-only; cap a STALE_ORDERS_MAX_LINES (5000)
// porque el slice anterior ya validó esta heurística para el mismo tipo de
// archivo. Activity-log puede crecer más, pero las últimas 5000 líneas cubren
// >24h de operación normal del pipeline.
// =============================================================================
const HANDOFF_ACTIVITY_LOG = path.join('.claude', 'activity-log.jsonl');
const HANDOFF_MAX_LINES = 10000;

function readActivityLog(repoRoot) {
    const file = path.join(repoRoot, HANDOFF_ACTIVITY_LOG);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { return []; }
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-HANDOFF_MAX_LINES);
    const events = [];
    for (const line of tail) {
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt && evt.event === 'session:end') events.push(evt);
    }
    return events;
}

function handoffMetricsSlice(state, ctx) {
    const repoRoot = (ctx && ctx.REPO_ROOT)
        || process.env.PIPELINE_REPO_ROOT
        || process.env.CLAUDE_PROJECT_DIR
        || path.resolve(__dirname, '..', '..');

    // Config: enabled / kill_switch a partir del config.yaml ya cargado por ctx
    // (si está disponible). Fallback a defaults.
    let cfg = { enabled: false, kill_switch: false };
    try {
        const handoff = require('./handoff');
        const raw = (ctx && ctx.config && ctx.config.handoff) || {};
        cfg = handoff.resolveConfig(raw);
    } catch { /* módulo opcional para tests aislados */ }

    const events = readActivityLog(repoRoot);
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    const cutoff7d = now - 7 * day;
    const cutoff24h = now - 1 * day;

    let total7d = 0, withHandoff7d = 0;
    let tokensIn24h = 0;
    let bytesOut7d = 0;
    const perDay = new Map(); // day-bucket → { total, withHandoff }
    const fallbackPhases = new Set();
    // #2993 rev-2: agregados por issue para el panel "Top issues por ahorro"
    // del widget. Solo metadata (issue#, skills, contadores) — NUNCA contenido
    // del handoff (CA-C1 verificada via whitelist en test).
    const perIssue = new Map(); // issue → { tokens_in, bytes_out, sections_in, skills:Set, hasHandoff, hasFallback }
    // #2993 rev-2: últimas N invocaciones para la banda de auditoría.
    // Mantenemos solo metadata: ts, skill, phase, status (OK/FALLBACK/REDACTED).
    const auditCandidates = [];

    for (const evt of events) {
        const ts = evt.ts ? Date.parse(evt.ts) : NaN;
        if (!Number.isFinite(ts) || ts < cutoff7d) continue;
        total7d++;
        const sectionsIn = Number(evt.handoff_sections_in || 0);
        const tokensInThis = Number(evt.handoff_in_tokens || 0);
        const bytesOutThis = Number(evt.handoff_out_bytes || 0);
        const hasHandoff = sectionsIn > 0 || tokensInThis > 0;
        if (hasHandoff) withHandoff7d++;
        else fallbackPhases.add(evt.phase || 'unknown');
        if (ts >= cutoff24h) tokensIn24h += tokensInThis;
        bytesOut7d += bytesOutThis;
        // bucket por día (resolución día calendario UTC)
        const dayKey = new Date(ts).toISOString().slice(0, 10);
        if (!perDay.has(dayKey)) perDay.set(dayKey, { total: 0, withHandoff: 0 });
        const bucket = perDay.get(dayKey);
        bucket.total++;
        if (hasHandoff) bucket.withHandoff++;

        // #2993 rev-2: agregar por issue para top issues table.
        const issueNum = Number(evt.issue || 0);
        if (issueNum > 0) {
            if (!perIssue.has(issueNum)) {
                perIssue.set(issueNum, {
                    issue: issueNum,
                    tokens_in: 0,
                    bytes_out: 0,
                    sections_in: 0,
                    skills: new Set(),
                    has_handoff: false,
                    has_fallback: false,
                });
            }
            const ie = perIssue.get(issueNum);
            ie.tokens_in += tokensInThis;
            ie.bytes_out += bytesOutThis;
            ie.sections_in += sectionsIn;
            if (evt.skill) ie.skills.add(String(evt.skill));
            if (hasHandoff) ie.has_handoff = true;
            else ie.has_fallback = true;
        }

        // #2993 rev-2: candidato para banda de auditoría.
        // Status derivado solo de campos numéricos del evento — NO de contenido
        // (CA-C1).
        let status = 'OK';
        if (!hasHandoff && (evt.phase === 'aprobacion' || evt.phase === 'verificacion')) {
            status = 'FALLBACK';
        }
        // CA-B6: si se reportó truncado (asume campo opcional `handoff_truncated`
        // como bool numérico/contador), marcamos TRUNCATED.
        if (Number(evt.handoff_truncated || 0) > 0) status = 'TRUNCATED';
        // CA-B3: si se reportaron secrets redactados, marcamos REDACTED.
        if (Number(evt.handoff_secrets_redacted || 0) > 0) status = 'REDACTED';
        auditCandidates.push({
            ts: evt.ts || new Date(ts).toISOString(),
            ts_ms: ts,
            agent: String(evt.skill || 'unknown'),
            phase: String(evt.phase || ''),
            issue: issueNum || null,
            status,
            sections_in: sectionsIn,
        });
    }

    // Sparkline: últimos 7 días, día más viejo primero.
    const sparkline = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now - i * day).toISOString().slice(0, 10);
        const b = perDay.get(d) || { total: 0, withHandoff: 0 };
        const pct = b.total === 0 ? 0 : Math.round((b.withHandoff / b.total) * 1000) / 10;
        sparkline.push({ day: d, pct, total: b.total, with_handoff: b.withHandoff });
    }

    // Estimación USD: usamos pricing de Sonnet como cota inferior porque la
    // mayoría de los agentes corren Sonnet/Haiku, y queremos NO sobreestimar
    // el ahorro. 24h × ~30 días = mensual; expresamos por mes para el widget.
    const PRICE_INPUT_PER_M = 3.0; // USD/1M tokens, Sonnet 4.6
    const usdSavedDay = (tokensIn24h * PRICE_INPUT_PER_M) / 1e6;
    const usdSavedMonthly = Math.round(usdSavedDay * 30 * 100) / 100;

    const hitRate = total7d === 0 ? 0 : Math.round((withHandoff7d / total7d) * 1000) / 10;
    const fallbackPct = total7d === 0 ? 0 : Math.round(((total7d - withHandoff7d) / total7d) * 1000) / 10;

    // #2993 rev-2: top issues por ahorro estimado (proxy: tokens_in inyectados
    // — son los tokens que el agente NO tuvo que recargar del issue completo).
    // Solo metadata: issue#, skills (lista corta), tokens, sections, status.
    // NO incluye títulos del issue ni contenido de handoff (CA-C1).
    const topIssues = Array.from(perIssue.values())
        .sort((a, b) => b.tokens_in - a.tokens_in)
        .slice(0, 5)
        .map(ie => ({
            issue: ie.issue,
            skills: Array.from(ie.skills).sort(),
            sections_in: ie.sections_in,
            tokens_in: ie.tokens_in,
            bytes_out: ie.bytes_out,
            status: ie.has_handoff && !ie.has_fallback ? 'activo'
                : ie.has_handoff ? 'parcial'
                : 'fallback',
        }));

    // #2993 rev-2: banda de auditoría = últimos 4 eventos (orden cronológico
    // descendente). Limitamos a 4 (lo que entra en el mockup) y deduplicamos
    // por agent+status para no spamear con runs idénticos.
    const auditEvents = auditCandidates
        .sort((a, b) => b.ts_ms - a.ts_ms)
        .slice(0, 4)
        .map(({ ts, agent, phase, issue, status, sections_in }) => ({
            ts, agent, phase, issue, status, sections_in,
        }));

    return {
        enabled: cfg.enabled,
        kill_switch: !!cfg.kill_switch,
        sample_window: '7d',
        sample_size: total7d,
        hit_rate_pct: hitRate,
        fallback_pct: fallbackPct,
        tokens_in_24h: tokensIn24h,
        bytes_out_7d: bytesOut7d,
        usd_saved_estimate_monthly: usdSavedMonthly,
        sparkline,
        // #2993 rev-2 — datos para tabla y banda del widget.
        // Whitelist de campos validada en test CA-C1.
        top_issues: topIssues,
        audit_events: auditEvents,
        updated_at: new Date().toISOString(),
    };
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
    quotaExhaustedSlice,
    reconcilerStaleOrdersSlice,
    // #2993 — widget de handoff
    handoffMetricsSlice,
    // #2894 — exports internos para testing
    _resolveDevSkillFromLabels: resolveDevSkillFromLabels,
    _buildAgentsForActiveFase: buildAgentsForActiveFase,
    // #2976 — exports internos para testing
    _isDeterministicSkill: isDeterministicSkill,
    _DETERMINISTIC_SKILLS: DETERMINISTIC_SKILLS,
};
