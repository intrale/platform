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
const DETERMINISTIC_SKILLS = new Set(['build', 'tester', 'delivery', 'linter']);

// #3023 — Filtro de la cola "Próximos 10" por allowlist de pausa parcial.
// Importación defensiva: si el módulo no está disponible (edge: checkout
// pre-#2490), `nextInQueue` degrada a comportamiento running (sin filtro).
let partialPause = null;
try { partialPause = require('./partial-pause'); } catch { /* opcional */ }

// Detector de artifacts auxiliares (.guidance.txt, .reason.json, .comment.md,
// y cualquier filename con > 2 segmentos). Compartido con human-block para
// que ambos listadores excluyan los mismos fantasmas. Fallback defensivo si
// el módulo no carga.
// Artifacts auxiliares: detección centralizada en `lib/marker-artifact.js`
// (#3638 CA-F-1).
const { isMarkerArtifact } = require('./marker-artifact');

// #3948 (EP-7) — Presencia observacional del Commander. Canal separado del
// filesystem de fases: el archivo vive en la raíz de runtime del pipeline
// (`commander-presence.json`), NO bajo `<pipeline>/<fase>/trabajando/`, así los
// contadores de concurrencia (`countRunningBySkill`/`countRunningDevs`) nunca lo
// ven (CA-2). Importación defensiva del enum/path; si el módulo no carga, el
// merge se degrada a no-op y `/api/dash/active` sigue funcionando.
let commanderPresence = null;
try { commanderPresence = require('./commander-presence'); } catch { /* opcional */ }

// TTL para considerar la presencia stale (CA-8 / SEC-4). Alineado con el default
// del helper; si el Commander crashea a mitad de petición, la card no queda
// colgada más de ~5 min.
const COMMANDER_PRESENCE_TTL_MS = 5 * 60 * 1000;

// #3955 EP8-H2 (CA-4 / SEC-6) — Cooldowns por fast-fail. Fuente única y
// server-authoritative: `<pipeline>/cooldowns.json`, escrita por pulpo.js
// (`registerFastFail`), con shape `{ "<skill>:<issue>": { failures, cooldownUntil } }`.
// El dashboard SOLO lee y expone; nunca habilita acciones por su cuenta.
const COOLDOWNS_FILE = path.join(__dirname, '..', 'cooldowns.json');

// Lee el cooldown vigente para un par skill+issue. Devuelve `null` si no hay
// cooldown o si ya venció (no exponemos contadores stale como activos). El
// objeto de cooldowns se pasa pre-leído para no pegarle al FS por agente.
function cooldownFor(cooldowns, skill, issue, now) {
    if (!cooldowns) return null;
    const entry = cooldowns[`${skill}:${issue}`];
    if (!entry || !entry.cooldownUntil) return null;
    const untilMs = Date.parse(entry.cooldownUntil);
    if (!Number.isFinite(untilMs) || untilMs <= now) return null;
    return { failures: entry.failures || 0, cooldownUntil: entry.cooldownUntil };
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
    // #3955 — Cooldowns leídos una sola vez por request (CA-4/SEC-6).
    const cooldowns = safeReadJson(COOLDOWNS_FILE, null);
    const now = Date.now();
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
                // #3955 CA-3 — defaults explícitos para que el front no tenga que
                // inferir; el Commander (más abajo) los pisa con false/true.
                cancelable: true,
                observational: false,
                // #3955 CA-4/SEC-6 — estado de cooldown server-authoritative.
                cooldown: cooldownFor(cooldowns, e.skill, issueId, now),
            });
        }
    }
    out.sort((a, b) => b.durationMs - a.durationMs);

    // #3948 (EP-7) — Mergear la presencia del Commander como agente SINTÉTICO
    // observacional, leído del canal separado (NO del issueMatrix de fases). Va
    // al frente (`unshift`) para que aparezca primero en la banda "Ejecutando
    // ahora". Lectura defensiva (`safeReadJson` ya tolera corrupción) + TTL por
    // `startedAt` (SEC-4 / CA-8) + validación de fase contra el enum cerrado
    // (SEC-2). NO afecta `totalRunning` como slot real: es presencia, los
    // contadores de concurrencia del pulpo viven en otro lado y no lo cuentan
    // (CA-2). El archivo NO contiene PII (CA-6, garantizado por el writer).
    if (commanderPresence) {
        const pres = safeReadJson(commanderPresence.presencePath(), null);
        if (pres && typeof pres === 'object' &&
            commanderPresence.isValidPhase(pres.fase) &&
            typeof pres.petitionId === 'string' && pres.petitionId &&
            typeof pres.startedAt === 'number') {
            const ageMs = Date.now() - pres.startedAt;
            if (ageMs >= 0 && ageMs < COMMANDER_PRESENCE_TTL_MS) {
                out.unshift({
                    issue: null,
                    title: 'Commander',
                    skill: 'commander',
                    pipeline: null,
                    fase: pres.fase,
                    petitionId: pres.petitionId, // id opaco (SEC-1)
                    durationMs: ageMs,
                    ageMin: Math.floor(ageMs / 60000),
                    observational: true,         // CA-3 / CA-4
                    cancelable: false,           // CA-3 / CA-4
                    hasLog: false,               // SEC-3: sin link a log crudo en esta iteración
                    etaMs: null,                 // presencia sin ETA (barra indeterminada en UI)
                });
            }
        }
    }

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
    //
    // #3241 CA-Slice — shape enriquecido para la UI nueva (#3242):
    //   { active, isWithinNow, currentPeriod, nextPeriod, periodsToday, manual }
    // Conservamos los campos legacy (`start`, `end`, `days`, `timezone`,
    // `isWithinWindow`, `updatedAt`) para retrocompat del pill viejo durante
    // la transición — `getWindow()` los sintetiza desde `schedule`.
    let restMode = { active: false };
    if (restModeWindow) {
        try {
            const now = Date.now();
            const w = restModeWindow.getWindow({ pipelineDir: PIPELINE });
            const within = restModeWindow.isWithinWindow(w, now);
            const describe = typeof restModeWindow.describeRestModeNow === 'function'
                ? restModeWindow.describeRestModeNow(w, now)
                : { active: !!w.active, isWithinNow: within, currentPeriod: null,
                    nextPeriod: null, periodsToday: 0, manual: !!w.manual };
            restMode = {
                // Campos enriquecidos #3241 (CA-Slice — UI nueva los consume)
                active: describe.active,
                isWithinNow: describe.isWithinNow,
                currentPeriod: describe.currentPeriod,
                nextPeriod: describe.nextPeriod,
                periodsToday: describe.periodsToday,
                manual: describe.manual,
                // Schedule completo para clientes que necesitan iterar
                schedule: w.schedule || null,
                // Campos legacy sintetizados (retrocompat pill viejo)
                start: w.start || null,
                end: w.end || null,
                timezone: w.timezone || null,
                days: Array.isArray(w.days) ? w.days : [],
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
//
// CA-1.3 (#3357): si `gh` falla, conservamos el valor anterior del cache.
// Cuando nunca tuvo valor, prsLast7d sigue como `null` (UI muestra "—"); si
// ya teníamos un conteo previo, lo mantenemos hasta que vuelva la conexión.
//
// CA-1.4 (#3357): la ventana se calcula con UTC (`slice(0,10)` sobre toISO).
// El operador en hora local AR (UTC-3) puede ver una "ventana corrida"
// cerca de medianoche UTC — bajo impacto, documentado acá.
let _prsCache = { value: null, at: 0 };
const PRS_CACHE_TTL_MS = 5 * 60 * 1000;

// Cache de issues cerrados — sirve a `issueCycleTimeMs` (CA-3.2 #3357).
// TTL = 5 min, mismo patrón defensivo que `_prsCache`. Si `gh` falla,
// el valor previo se preserva.
let _closedIssuesCache = { value: null, at: 0 };
const CLOSED_ISSUES_CACHE_TTL_MS = 5 * 60 * 1000;

// Snapshot del aggregator V3 — TTL más agresivo (10 min) porque generar el
// snapshot es lento (escanea activity-log.jsonl entero) y los tokens no
// cambian en milisegundos. Refresh en background sin bloquear la response.
//
// CA-2.1 (#3357): escribimos DOS snapshots en paralelo — `snapshot.json`
// (window=all, consumidores externos pre-existentes) y `snapshot-24h.json`
// (window=24h, lectura del `tokens24h` del kpisSlice). Cada uno con su
// flag de refresh para no superponer spawns.
let _snapshotRefreshing = false;
let _snapshotLastRefresh = 0;
let _snapshot24hRefreshing = false;
let _snapshot24hLastRefresh = 0;
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

// CA-2.1 (#3357): refresh dedicado del snapshot 24h. El aggregator escribe
// `snapshot.json` para el window pedido — para tener DOS snapshots paralelos
// pasamos `--out snapshot-24h.json` (flag opcional aceptada por aggregator
// post-#3357, fallback a comportamiento legacy si no se reconoce).
function maybeRefreshSnapshot24h(ROOT, snapshot24hPath) {
    if (_snapshot24hRefreshing) return;
    let mtimeMs = 0;
    try { mtimeMs = require('fs').statSync(snapshot24hPath).mtimeMs; } catch {}
    const ageMs = Date.now() - mtimeMs;
    if (ageMs < SNAPSHOT_TTL_MS && Date.now() - _snapshot24hLastRefresh < SNAPSHOT_TTL_MS) return;
    _snapshot24hRefreshing = true;
    _snapshot24hLastRefresh = Date.now();
    try {
        const { spawn } = require('child_process');
        const aggregatorPath = path.join(__dirname, '..', 'metrics', 'aggregator.js');
        const child = spawn(
            process.execPath,
            [aggregatorPath, '--once', '--window', '24h', '--out', 'snapshot-24h.json'],
            { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true },
        );
        child.unref();
        child.on('exit', () => { _snapshot24hRefreshing = false; });
        child.on('error', () => { _snapshot24hRefreshing = false; });
    } catch { _snapshot24hRefreshing = false; }
}

// CA-1 (#3357): query simplificada. `--search "merged:>=<date>"` ya implica
// `state:merged`, así que eliminamos el `--state merged` redundante.
// `--limit 500` da margen frente a semanas pico (51 PRs hoy, techo 500).
//
// NOTA UTC (CA-1.4): `since` se calcula vía `toISOString().slice(0,10)`, que
// es UTC. El operador en hora local AR (UTC-3) puede percibir la ventana
// "corrida" 1 día cerca de medianoche UTC — bajo impacto operativo.
function ghPrCommand(ghBin, sinceUtc) {
    return `"${ghBin}" pr list --search "merged:>=${sinceUtc}" --json number,createdAt,mergedAt --limit 500`;
}

// CA-3.2 (#3357): query a `gh issue list` con `closed:>=<date>` para
// `issueCycleTimeMs`. Trae `createdAt` + `closedAt` para calcular la
// duración real del flujo (issue creation → close ≈ DORA cycle time).
function ghClosedIssuesCommand(ghBin, sinceUtc) {
    return `"${ghBin}" issue list --state closed --search "closed:>=${sinceUtc}" --json number,createdAt,closedAt --limit 500`;
}

function _todayUtcMinus(days) {
    return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

// CA-3 (#3357): mediana sobre array numérico. Vacío → null.
function _median(arr) {
    if (!arr || arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function kpisSlice(state, ctx) {
    const PIPELINE = ctx.PIPELINE;
    const ROOT = ctx.ROOT;
    const GH_BIN = ctx.GH_BIN;

    // -------------------------------------------------------------------
    // CA-1 (#3357): PRs últimos 7 días con cache defensivo
    // -------------------------------------------------------------------
    let prsLast7d = _prsCache.value;
    if (Date.now() - _prsCache.at > PRS_CACHE_TTL_MS) {
        try {
            const since = _todayUtcMinus(7);
            const result = execSync(
                ghPrCommand(GH_BIN, since),
                { cwd: ROOT, encoding: 'utf8', timeout: 8000, windowsHide: true }
            );
            const parsed = JSON.parse(result || '[]');
            prsLast7d = parsed.length;
            // Solo persistimos el cache cuando `gh` respondió OK. Si la query
            // tirara en el próximo poll, el valor previo se preserva.
            _prsCache = { value: prsLast7d, at: Date.now(), prs: parsed };
        } catch {
            // CA-1.3: NO sobreescribir _prsCache.value con null. Si nunca tuvo
            // valor, sigue null (UI: "—"). Si tenía valor previo, lo conservamos.
        }
    }

    // -------------------------------------------------------------------
    // CA-2 (#3357): tokens últimas 24h con breakdown por provider
    // -------------------------------------------------------------------
    let tokens24h = null;
    let snapshot24h = null;
    try {
        const snap24hPath = path.join(PIPELINE, 'metrics', 'snapshot-24h.json');
        // Refresh paralelo del snapshot 24h (no bloquea response actual).
        maybeRefreshSnapshot24h(ROOT, snap24hPath);
        snapshot24h = safeReadJson(snap24hPath, null);
        // Fallback al snapshot all-time si el 24h aún no se generó (primer arranque).
        if (!snapshot24h) {
            const snapPath = path.join(PIPELINE, 'metrics', 'snapshot.json');
            maybeRefreshSnapshot(ROOT, snapPath);
            snapshot24h = safeReadJson(snapPath, null);
        }
        if (snapshot24h && snapshot24h.totals) {
            const totals = snapshot24h.totals;
            const totalSum = (totals.tokens_in || 0) + (totals.tokens_out || 0);
            // Breakdown por provider — CA-2.2/2.3. El aggregator expone
            // `totals.by_provider: { <provider>: { tokens_in, tokens_out, ... } }`
            // post-#3357. Si el snapshot todavía no lo tiene (versión vieja),
            // degrade limpio: solo `total`, sin `by_provider`.
            let byProvider = null;
            if (totals.by_provider && typeof totals.by_provider === 'object') {
                byProvider = {};
                for (const [prov, bucket] of Object.entries(totals.by_provider)) {
                    if (!bucket || typeof bucket !== 'object') continue;
                    const tokSum = (bucket.tokens_in || 0) + (bucket.tokens_out || 0);
                    byProvider[prov] = tokSum;
                }
            }
            if (totalSum > 0) {
                tokens24h = { total: totalSum, by_provider: byProvider };
            } else {
                // Sin datos en 24h → null (UI: "—"). Distinguir de "estado vacío".
                tokens24h = null;
            }
        }
    } catch { /* snapshot ausente / corrupto — degrade a null */ }

    // -------------------------------------------------------------------
    // CA-3 (#3357): agentDurationMedianMs (renombrado) + issueCycleTimeMs
    // -------------------------------------------------------------------
    let agentDurationMedianMs = null;
    try {
        // CA-3.3: fix doble conteo `listo` + `procesado`. Por (issue, fase, skill)
        // preferimos `procesado` (estado final). Si no hay `procesado`, usamos
        // `listo`. Así un marker reciclado cuenta UNA sola vez.
        //
        // CA-3.4: cap superior de duración subido de 24h → 7d para no enmascarar
        // builds grandes / QA E2E con video que legítimamente duran horas.
        const MAX_DUR_MS = 7 * 24 * 3600 * 1000;
        const bestPerKey = new Map(); // `${issue}|${fase}|${skill}` → entry
        for (const [issueId, data] of Object.entries(state.issueMatrix || {})) {
            for (const [faseKey, entries] of Object.entries(data.fases || {})) {
                for (const e of entries) {
                    if (e.estado !== 'procesado' && e.estado !== 'listo') continue;
                    if (!(e.durationMs >= 1000) || e.durationMs >= MAX_DUR_MS) continue;
                    const key = `${issueId}|${faseKey}|${e.skill}`;
                    const prev = bestPerKey.get(key);
                    // Preferir `procesado` sobre `listo`; si ambos son procesado,
                    // tomar el más reciente por updatedAt.
                    if (!prev) {
                        bestPerKey.set(key, e);
                    } else if (prev.estado === 'listo' && e.estado === 'procesado') {
                        bestPerKey.set(key, e);
                    } else if (prev.estado === e.estado && (e.updatedAt || 0) > (prev.updatedAt || 0)) {
                        bestPerKey.set(key, e);
                    }
                }
            }
        }
        const allDurations = [...bestPerKey.values()].map(e => e.durationMs);
        agentDurationMedianMs = _median(allDurations);
    } catch { /* ignore */ }

    // CA-3.2 (#3357): nuevo issueCycleTimeMs = mediana de (closedAt - createdAt)
    // de issues cerrados en los últimos 7d. Usamos `gh issue list` cacheado.
    let issueCycleTimeMs = null;
    try {
        let closedIssues = _closedIssuesCache.value;
        if (Date.now() - _closedIssuesCache.at > CLOSED_ISSUES_CACHE_TTL_MS) {
            try {
                const since = _todayUtcMinus(7);
                const result = execSync(
                    ghClosedIssuesCommand(GH_BIN, since),
                    { cwd: ROOT, encoding: 'utf8', timeout: 8000, windowsHide: true }
                );
                closedIssues = JSON.parse(result || '[]');
                _closedIssuesCache = { value: closedIssues, at: Date.now() };
            } catch { /* gh offline — preservar valor previo */ }
        }
        if (Array.isArray(closedIssues) && closedIssues.length > 0) {
            const durations = closedIssues
                .map(i => {
                    const c = i.createdAt ? Date.parse(i.createdAt) : NaN;
                    const cl = i.closedAt ? Date.parse(i.closedAt) : NaN;
                    if (!Number.isFinite(c) || !Number.isFinite(cl) || cl < c) return null;
                    return cl - c;
                })
                .filter(d => d != null && d > 0);
            issueCycleTimeMs = _median(durations);
        }
    } catch { /* ignore */ }

    // -------------------------------------------------------------------
    // CA-4 (#3357): bouncePct con denominador = issues, breakdown por fase
    // -------------------------------------------------------------------
    let bouncePct = null;
    try {
        const WINDOW_MS = 7 * 24 * 3600 * 1000;
        const cutoff = Date.now() - WINDOW_MS;
        const issuesInWindow = new Set();         // issues con cualquier marker activo/terminado en 7d
        const issuesWithBounce = new Set();       // issues con ≥1 marker rechazado en 7d
        const phaseTotals = new Map();            // fase → { issues:Set, bouncedIssues:Set }

        for (const [issueId, data] of Object.entries(state.issueMatrix || {})) {
            // Track per-fase: ¿el issue terminó algo en esa fase dentro de la ventana?
            // ¿fue rebotado en esa fase?
            for (const [faseKey, entries] of Object.entries(data.fases || {})) {
                let phaseFinishedInWindow = false;
                let phaseRejectedInWindow = false;
                for (const e of entries) {
                    if (e.estado !== 'procesado' && e.estado !== 'listo') continue;
                    if (!e.resultado) continue;
                    const ts = e.updatedAt || 0;
                    if (ts < cutoff) continue;
                    phaseFinishedInWindow = true;
                    issuesInWindow.add(issueId);
                    if (e.resultado === 'rechazado') {
                        phaseRejectedInWindow = true;
                        issuesWithBounce.add(issueId);
                    }
                }
                if (phaseFinishedInWindow) {
                    if (!phaseTotals.has(faseKey)) {
                        phaseTotals.set(faseKey, { issues: new Set(), bouncedIssues: new Set() });
                    }
                    const slot = phaseTotals.get(faseKey);
                    slot.issues.add(issueId);
                    if (phaseRejectedInWindow) slot.bouncedIssues.add(issueId);
                }
            }
        }

        // CA-4.4: si total = 0, devolver null (NO 0%, NO div/0).
        if (issuesInWindow.size > 0) {
            const overall = (issuesWithBounce.size / issuesInWindow.size) * 1000;
            const byPhase = {};
            for (const [faseKey, slot] of phaseTotals.entries()) {
                if (slot.issues.size === 0) continue;
                byPhase[faseKey] = Math.round((slot.bouncedIssues.size / slot.issues.size) * 1000) / 10;
            }
            bouncePct = {
                overall: Math.round(overall) / 10,
                byPhase,
                windowDays: 7,
                issuesTotal: issuesInWindow.size,
                issuesBounced: issuesWithBounce.size,
            };
        }
    } catch { /* ignore */ }

    return {
        prsLast7d,
        tokens24h,
        // CA-3.1: nombre semánticamente correcto (lo que mide HOY).
        agentDurationMedianMs,
        // CA-3.2: nueva métrica DORA-like (issue creation → close).
        issueCycleTimeMs,
        // CA-3.1: alias legacy deprecado — mantener durante 1 release para
        // no romper consumidores externos. Borrar después de la próxima review.
        // @deprecated usar agentDurationMedianMs
        cycleTimeMs: agentDurationMedianMs,
        bouncePct,
        timestamp: Date.now(),
    };
}

// -----------------------------------------------------------------------------
// #3897 CA-4 — Métrica de precisión de Sherlock (épico #3894, hija 3/3).
//
// Lee los audit logs canónicos `sherlock-*.jsonl` (writer de #3896,
// `lib/sherlock-audit-jsonl.js`) y computa SOLO agregados numéricos/booleanos.
//
// SEC-6 (NO NEGOCIABLE): el payload NUNCA incluye claims, comandos crudos,
// stdout/stderr, session-ids ni ningún string derivado del contenido del
// audit. NO replicar `partialPauseAuditSlice` (expone texto por-entry) —
// SEC-6 es estrictamente más restrictivo. La capa de color/semáforo (UX-1)
// vive en el front (`views/dashboard/*.js`), no acá.
//
// Definición de "contradicción/validación correcta": la resolución registrada
// es COHERENTE con el tri-estado del árbitro canónico —
//   - commander_vs_sherlock 'consistent'   + resolucion 'accepted' → correcta
//   - commander_vs_sherlock 'inconsistent' + resolucion 'rejected' → correcta
//     (contradicción respaldada por hecho canónico)
//   - cualquier otra combinación → incorrecta (ej. contradicción emitida sin
//     respaldo del árbitro = falso positivo estilo #3729).
// `resultado === 'not_verifiable'` cuenta aparte (no entra al denominador).
// -----------------------------------------------------------------------------
const SHERLOCK_PRECISION_TARGET = 0.90;          // UX-1: verde ≥ 90%
const SHERLOCK_PRECISION_ALERT_BELOW = 0.80;     // CA-4: alerta visible < 80%
const SHERLOCK_PRECISION_MIN_SAMPLE = 5;         // UX-1: n<5 → muestra insuficiente

// CA-3 (#3921) — meta de verificaciones same-provider: < 10%. Con cross-provider
// por defecto, una verificación same-provider solo debería ocurrir en el fallback
// de último recurso (chain alternativa agotada). Si el % sube de la meta, la
// adversariality cross-provider se está degradando seguido → alerta visible.
const SHERLOCK_SAME_PROVIDER_TARGET = 0.10;      // meta visible: < 10%

// #3923 EP2-H3 — ENUM CERRADO de fuentes (LOCKSTEP con AUDIT_SOURCE_ENUM de
// sherlock-audit-jsonl.js y el enum `source` de canonical-facts.js). El objeto
// not_verifiable_by_source SIEMPRE emite estas claves (default 0).
const SHERLOCK_NV_SOURCES = ['git', 'github-api', 'heartbeat', 'filesystem', 'pipeline-state', 'waves'];
function _emptyNvBySource() {
    const o = {};
    for (const s of SHERLOCK_NV_SOURCES) o[s] = 0;
    return o;
}

function _sherlockRecordCorrecto(rec) {
    const cmp = rec && rec.commander_vs_sherlock;
    const res = rec && rec.resolucion;
    return (cmp === 'consistent' && res === 'accepted')
        || (cmp === 'inconsistent' && res === 'rejected');
}

function sherlockPrecisionSlice(state, ctx) {
    try {
        const PIPELINE = (ctx && ctx.PIPELINE) || path.join(process.cwd(), '.pipeline');
        const auditDir = path.join(PIPELINE, 'audit');
        let files = [];
        try {
            files = fs.readdirSync(auditDir)
                .filter((f) => f.startsWith('sherlock-') && f.endsWith('.jsonl'));
        } catch { files = []; /* dir ausente → estado vacío, no error */ }

        let correctas = 0;
        let totales = 0;
        let notVerifiable = 0;
        // CA-3 (#3921) — agregado de same-provider sobre el total de records que
        // declaran el campo `same_provider` (booleano). SEC-3: cuenta TODAS las
        // same-provider, incluido el fallback de último recurso (el verifier
        // persiste el flag en cada validación canónica del veredicto). SEC-4: solo
        // booleans/contadores, sin claims/comandos/PII.
        let sameProviderTotal = 0;
        let sameProviderCount = 0;
        // #3923 EP2-H3 — tasa de not_verifiable POR FUENTE (insumo EP8-H8). SEC-6:
        // solo contadores por enum cerrado, nunca claims/comandos/stdout.
        const notVerifiableBySource = _emptyNvBySource();
        for (const f of files) {
            let raw = '';
            try { raw = fs.readFileSync(path.join(auditDir, f), 'utf8'); }
            catch { continue; }
            for (const line of raw.split('\n')) {
                if (!line.trim()) continue;
                let rec = null;
                try { rec = JSON.parse(line); } catch { continue; }
                if (typeof (rec && rec.same_provider) === 'boolean') {
                    sameProviderTotal += 1;
                    if (rec.same_provider === true) sameProviderCount += 1;
                }
                const resultado = rec && rec.resultado;
                if (resultado === 'not_verifiable') {
                    notVerifiable += 1;
                    // Acumula por fuente SOLO si pertenece al enum cerrado (records
                    // viejos sin `source` no rompen el shape).
                    const src = rec && rec.source;
                    if (typeof src === 'string'
                        && Object.prototype.hasOwnProperty.call(notVerifiableBySource, src)) {
                        notVerifiableBySource[src] += 1;
                    }
                    continue;
                }
                if (resultado !== 'true' && resultado !== 'false') continue;
                totales += 1;
                if (_sherlockRecordCorrecto(rec)) correctas += 1;
            }
        }

        const ratio = totales > 0 ? correctas / totales : null; // null => muestra vacía
        const sameProviderRatio = sameProviderTotal > 0
            ? sameProviderCount / sameProviderTotal
            : null;                                             // null => muestra vacía
        return {
            correctas,
            totales,
            not_verifiable: notVerifiable,
            // #3923 EP2-H3 — contadores por fuente (insumo EP8-H8). SEC-6: solo numbers.
            not_verifiable_by_source: notVerifiableBySource,
            ratio,                                              // number|null, sin string
            insufficient_sample: totales < SHERLOCK_PRECISION_MIN_SAMPLE,
            target: SHERLOCK_PRECISION_TARGET,
            alert: ratio !== null && ratio < SHERLOCK_PRECISION_ALERT_BELOW,
            // CA-3 (#3921) — % verificaciones same-provider (meta < 10%).
            same_provider_count: sameProviderCount,
            same_provider_total: sameProviderTotal,
            same_provider_ratio: sameProviderRatio,             // number|null
            same_provider_target: SHERLOCK_SAME_PROVIDER_TARGET,
            same_provider_alert: sameProviderRatio !== null && sameProviderRatio >= SHERLOCK_SAME_PROVIDER_TARGET,
        };
    } catch {
        // Degrade limpio: mismo shape numérico/booleano + código de error de
        // allowlist (literal constante, NO derivado del contenido del audit).
        return {
            correctas: 0,
            totales: 0,
            not_verifiable: 0,
            // #3923 EP2-H3 — mismo shape con ceros en el degrade (insumo EP8-H8).
            not_verifiable_by_source: _emptyNvBySource(),
            ratio: null,
            insufficient_sample: true,
            target: SHERLOCK_PRECISION_TARGET,
            alert: false,
            same_provider_count: 0,
            same_provider_total: 0,
            same_provider_ratio: null,
            same_provider_target: SHERLOCK_SAME_PROVIDER_TARGET,
            same_provider_alert: false,
            error: 'sherlock_precision_unavailable',
        };
    }
}

// #3955 EP8-H2 (CA-5) — Sparkline de carga 24h por skill. Fuente: mtimes de los
// archivos en `<pipeline>/<fase>/procesado/` agrupados en 24 buckets horarios.
// NO introduce proceso de muestreo nuevo: deriva del FS existente (documentado
// en el PR). Cada bucket cuenta cuántos markers terminó ese skill en esa hora.
// El array tiene 24 enteros, índice 0 = hace 23h … índice 23 = hora actual.
const SPARK_BUCKETS = 24;
const SPARK_HOUR_MS = 3600 * 1000;
const SPARK_CACHE_TTL_MS = 30 * 1000;
let _sparkCache = { at: 0, data: null };

function skillSpark24h(state, now) {
    now = now || Date.now();
    if (_sparkCache.data && (now - _sparkCache.at) < SPARK_CACHE_TTL_MS) {
        return _sparkCache.data;
    }
    const PIPELINE = path.join(__dirname, '..');
    const windowStart = now - SPARK_BUCKETS * SPARK_HOUR_MS;
    const bySkill = {};
    const fases = Array.isArray(state.allFases) ? state.allFases : [];
    for (const { pipeline: pName, fase } of fases) {
        const dir = path.join(PIPELINE, pName, fase, 'procesado');
        let files;
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
            if (f.startsWith('.') || isMarkerArtifact(f)) continue;
            // marker `<issue>.<skill>` → skill es lo que sigue al primer punto.
            const dot = f.indexOf('.');
            if (dot < 0) continue;
            const skill = f.slice(dot + 1);
            if (!/^[a-z0-9-]+$/.test(skill)) continue;
            let mtime;
            try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch { continue; }
            if (mtime < windowStart || mtime > now) continue;
            const bucket = Math.min(SPARK_BUCKETS - 1, Math.floor((mtime - windowStart) / SPARK_HOUR_MS));
            if (!bySkill[skill]) bySkill[skill] = new Array(SPARK_BUCKETS).fill(0);
            bySkill[skill][bucket]++;
        }
    }
    _sparkCache = { at: now, data: bySkill };
    return bySkill;
}

function equipoSlice(state) {
    const skillLoad = state.skillLoad || {};
    const spark = skillSpark24h(state);
    const skills = Object.entries(skillLoad).map(([skill, load]) => ({
        skill,
        running: load.running,
        max: load.max,
        utilization: load.max > 0 ? load.running / load.max : 0,
        // #3955 CA-5 — sparkline de carga 24h (vacío si el skill no tuvo
        // actividad en la ventana).
        spark24h: spark[skill] || new Array(SPARK_BUCKETS).fill(0),
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

    // #3905 — waveIssues: cruce de la allowlist (ola actual) con el matrix.
    // Los issues de la allowlist que NO tienen work-file en ninguna fase
    // (faltantes = allowlist − matrix) se representan en la franja terminal
    // "Ola — fuera de flujo" del board: estado `no-ingreso` (open en GitHub) o
    // `finalizado` (closed). Reutiliza classifyStatus de wave-snapshot (#3262)
    // en vez de duplicar la lógica de derivación.
    //
    // Nota (staleness): un issue recién cerrado puede tardar en reflejar
    // `finalizado` hasta que expire el TTL del title-cache. Aceptable para un
    // dashboard de operador (el dato no es de seguridad).
    const waveIssues = [];
    try {
        const { _internal } = require('./wave-snapshot');
        let allowlist = [];
        if (ctx && Array.isArray(ctx.allowlist)) {
            // Override inyectable (tests / callers que ya leyeron la allowlist).
            allowlist = ctx.allowlist;
        } else if (partialPause && typeof partialPause.readPreviousAllowlist === 'function') {
            allowlist = partialPause.readPreviousAllowlist() || [];
        }
        // SEC-2: .partial-pause.json es editable a mano → validar enteros
        // antes de usarlos. (readPreviousAllowlist ya normaliza, pero el filtro
        // explícito documenta el requisito de seguridad y es defensivo ante
        // cambios futuros del módulo.)
        allowlist = allowlist.filter((n) => Number.isInteger(n));
        const titles = state.issueTitles || {};
        for (const n of allowlist) {
            // Anti-duplicado (CA-6): si ya está en el matrix tiene fase actual y
            // se dibuja en su columna — no va a la franja terminal.
            if (matrix[String(n)]) continue;
            const meta = titles[String(n)] || {};
            const isClosed = String(meta.state).toUpperCase() === 'CLOSED';
            const cls = _internal.classifyStatus({
                isClosed, isBlocked: false, isPaused: false, faseActual: null, pct: 0,
            });
            waveIssues.push({
                issue: String(n),
                title: meta.title || '',
                estado: cls === 'closed' ? 'finalizado' : 'no-ingreso',
            });
        }
    } catch { /* wave-snapshot opcional: degradamos a franja vacía */ }

    return {
        matrix,
        fases: state.allFases,
        priorityOrder,
        matrixCounts,
        staleThresholdMin: STALE_THRESHOLD_MIN,
        waveIssues,
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
//
// #3357 CA-5: multi-provider. El slice devuelve quota por cada provider
// declarado en `agent-models.json` (vía `quotaUsage(provider, ...)` del
// dispatcher de quota-adapters). Retrocompat:
//   - Campos legacy (hoursUsed7d, pct, status, session.*, etc.) quedan en
//     el TOP-LEVEL del objeto retornado — son el resultado del adapter de
//     Anthropic, idéntico byte-a-byte al shape pre-#3357. Esto evita romper
//     consumidores del banner del dashboard.
//   - Campo nuevo `providers: { anthropic, openai-codex, groq, ... }` expone
//     el shape multi-provider para la UI nueva del kpi panel (CA-UX-2).
function quotaSlice(state, ctx) {
    const PIPELINE = ctx.PIPELINE;
    const ROOT = ctx.ROOT;
    const metricsDir = path.join(PIPELINE, 'metrics');
    const activityLog = path.join(ROOT, '.claude', 'activity-log.jsonl');
    const configLimitHours = Number(process.env.ANTHROPIC_MAX_WEEKLY_HOURS) || undefined;

    // Resolver providers declarados en agent-models.json. Si el archivo no
    // está disponible (caso edge), cae al set mínimo conocido. NO usar `eval`
    // ni `require` dinámico con paths construidos — siempre el path fijo.
    let declaredProviders = ['anthropic', 'openai-codex', 'gemini-google', 'groq', 'cerebras', 'nvidia-nim'];
    try {
        const modelsPath = path.join(PIPELINE, 'agent-models.json');
        const models = safeReadJson(modelsPath, null);
        if (models && models.providers && typeof models.providers === 'object') {
            // Filtrar `deterministic` (no consume cuota) y deduplicar.
            const fromConfig = Object.keys(models.providers).filter(p => p !== 'deterministic');
            if (fromConfig.length > 0) declaredProviders = fromConfig;
        }
    } catch { /* fallback al set mínimo */ }

    // Anthropic primero — su resultado se flat-mergea al top-level para
    // backward-compat con consumidores legacy (banner del dashboard).
    let anthropicResult = null;
    const providers = {};
    try {
        const { quotaUsage } = require('./quota-adapters');
        for (const provider of declaredProviders) {
            try {
                const result = quotaUsage(provider, {
                    metricsDir,
                    activityLogPath: activityLog,
                    configLimitHours: provider === 'anthropic' ? configLimitHours : undefined,
                });
                providers[provider] = result;
                if (provider === 'anthropic') anthropicResult = result;
            } catch (err) {
                // Defensa: el dispatcher es fail-secure, pero por si acaso.
                providers[provider] = {
                    provider,
                    adapterStatus: 'error',
                    errorReason: err && err.message ? err.message : 'unknown',
                    pct: null,
                    status: 'unknown',
                };
            }
        }
    } catch (e) {
        // quota-adapters no está disponible — cae al cómputo legacy directo.
        try {
            const quotaLib = require('./weekly-quota');
            anthropicResult = quotaLib.computeQuota(metricsDir, activityLog, { configLimitHours });
            providers.anthropic = anthropicResult;
        } catch (e2) {
            return { error: e2.message, hoursUsed7d: 0, pct: 0, status: 'unknown', providers: {} };
        }
    }

    // Retrocompat: campos legacy de Anthropic en el top-level + nuevo
    // `providers` con el desglose por adapter.
    const out = anthropicResult && typeof anthropicResult === 'object'
        ? { ...anthropicResult }
        : { hoursUsed7d: 0, pct: 0, status: 'unknown' };
    out.providers = providers;
    return out;
}

// =============================================================================
// #2976 — quotaExhaustedSlice: banner amarillo de cuota Anthropic agotada.
//
// Lee el flag `.pipeline/quota-exhausted.json` vía `quota-exhausted-state.js`
// (lectura defensiva, ver hija #2974) y enriquece el payload con dos
// counters que el banner muestra en paneles comparativos (CA-5):
//
//   - `deterministicRunning`: agentes determinísticos (build/tester/
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

// #3625 CA-5 — Widget de audit trail de mutaciones a la allowlist.
//
// Devuelve un slice consumible por el dashboard con:
//   - Las últimas N entries del audit log (default 3, configurable via opts).
//   - Stats de las últimas 24h (total, autorizadas, rechazadas, sin autoría).
//   - Estado del hash-chain (`verifyChain`).
//
// Cada entry se mapea a 4 estados visuales (UX-#3625):
//   - 'human'        → mutación OK por humano (commander:leo).
//   - 'subsystem'    → mutación OK por subsistema (waves, planner-split, etc.).
//   - 'rejected'     → action: 'reject' (gate bloqueó la mutación).
//   - 'unauthorized' → action 'write' pero authorized_by null (puerta trasera).
//
// La UI usa estos estados para colores/iconos. Si el hash-chain está roto,
// emitimos `chain_broken: true` para que la UI dispare el banner crítico.
function partialPauseAuditSlice(state, ctx) {
    const _ctx = ctx || {};
    const limit = Number.isFinite(_ctx.limit) && _ctx.limit > 0 ? _ctx.limit : 3;
    let entries = [];
    let stats = { total: 0, authorized: 0, rejected: 0, unknown: 0, since: null };
    let chainStatus = { ok: true, entriesChecked: 0 };
    try {
        const ppa = require('./partial-pause-audit');
        entries = ppa.tail(limit);
        stats = ppa.statsSince({});
        chainStatus = ppa.verifyChain();
    } catch (err) {
        return {
            entries: [],
            stats,
            chain_broken: false,
            chain_error: err && err.message,
            error: 'partial_pause_audit_unavailable',
        };
    }

    const mapped = entries.map((e) => {
        let visual = 'human';
        if (e.action === 'reject') visual = 'rejected';
        else if (!e.authorized_by) visual = 'unauthorized';
        else if (e.authorized_by === 'commander:leo') visual = 'human';
        else visual = 'subsystem';
        return {
            timestamp: e.timestamp,
            source: e.source,
            action: e.action,
            authorized_by: e.authorized_by,
            justification: (e.justification || '').slice(0, 80),
            justification_truncated: (e.justification || '').length > 80,
            justification_redacted: !!e.justification_redacted,
            diff: e.diff || { added: [], removed: [] },
            visual,
            backfill: !!e._backfill,
        };
    });

    // Cualquier entry con autoría null y NO marcada como backfill dispara el
    // banner condicional "Sin autoría".
    const hasUnauthorizedNonBackfill = mapped.some(
        (e) => e.visual === 'unauthorized' && !e.backfill
    );

    return {
        entries: mapped,
        stats,
        chain_broken: !chainStatus.ok,
        chain_broken_at: chainStatus.brokenAt || null,
        chain_broken_reason: chainStatus.reason || null,
        chain_entries_checked: chainStatus.entriesChecked || 0,
        has_unauthorized_non_backfill: hasUnauthorizedNonBackfill,
    };
}

// #3954 EP8-H1 CA-5 — Bandeja de alertas del Home mission-control. Slice
// modelado 1:1 sobre `partialPauseAuditSlice`: tail de acciones del operador
// (ack/snooze) con timestamp/actor/justificación truncada a 80, stats de 24h,
// verificación de la cadena de hashes y supresiones vigentes.
//
// El actor SIEMPRE es `operador-local` (grabado server-side, REQ-SEC-3) — el
// slice no lo deriva del cliente. Degrada a `{error}` si el store no está
// disponible (espejo de partial-pause), sin romper el dashboard.
function alertTraySlice(state, ctx) {
    const _ctx = ctx || {};
    const limit = Number.isFinite(_ctx.limit) && _ctx.limit > 0 ? _ctx.limit : 5;
    let entries = [];
    let stats = { total: 0, ack: 0, snooze: 0, rejected: 0, since: null };
    let chainStatus = { ok: true, entriesChecked: 0 };
    let suppressions = {};
    try {
        const ata = require('./alert-tray-audit');
        entries = ata.tail(limit);
        stats = ata.statsSince({});
        chainStatus = ata.verifyChain();
        suppressions = ata.activeSuppressions();
    } catch (err) {
        return {
            entries: [],
            stats,
            suppressions: {},
            chain_broken: false,
            chain_error: err && err.message,
            error: 'alert_tray_audit_unavailable',
        };
    }

    const mapped = entries.map((e) => {
        let visual = 'ack';
        if (e.action === 'reject') visual = 'rejected';
        else if (e.action === 'snooze') visual = 'snooze';
        else visual = 'ack';
        return {
            timestamp: e.timestamp,
            actor: e.actor || null,
            action: e.action,
            alert_id: e.alert_id || null,
            snooze_until: e.snooze_until || null,
            snooze_hours: e.snooze_hours || null,
            justification: (e.justification || '').slice(0, 80),
            justification_truncated: (e.justification || '').length > 80,
            justification_redacted: !!e.justification_redacted,
            reject_reason: e.reject_reason || null,
            visual,
        };
    });

    return {
        entries: mapped,
        stats,
        suppressions,
        chain_broken: !chainStatus.ok,
        chain_broken_at: chainStatus.brokenAt || null,
        chain_broken_reason: chainStatus.reason || null,
        chain_entries_checked: chainStatus.entriesChecked || 0,
    };
}

// #3642 — Widget architect 4 estados. Slice consume el resolver puro
// (lib/architect-state-resolver) y devuelve la informacion que el badge del
// dashboard necesita para un issue dado. Defensivo si el resolver falta.
let _architectResolver = null;
try { _architectResolver = require('./architect-state-resolver'); } catch { /* opcional */ }
let _architectBadge = null;
try { _architectBadge = require('./architect-badge-renderer'); } catch { /* opcional */ }

function architectStateSlice(state, issueNum) {
    if (!_architectResolver || !state || !state.issueMatrix) return null;
    const key = String(issueNum);
    const data = state.issueMatrix[key];
    if (!data || !data.fases) return null;
    try {
        return _architectResolver.resolveArchitectState(data.fases);
    } catch {
        return null;
    }
}

// #3642 CA-1/CA-4/CA-5/CA-6/CA-IMPL-B6-XSS-DEFENSIVE — Renderer del badge.
// Recibe `info` (resultado del resolver) y `{ esc, ic }` inyectados (las
// helpers reales viven en dashboard.js; los tests pueden inyectar fakes).
//
// Switch explicito por estado — necesario para que el grep CA-2 sobre
// `.pipeline/lib/dashboard-slices.js` encuentre las 4 referencias a
// `ic('architect-<state>')`. Mantener las 4 literales (no concatenar).
//
// Defensa XSS: `esc()` sobre cada valor dinamico interpolado en title="" /
// aria-label="" y en el cuerpo del span. El text/a11y vienen del helper
// puro `architect-badge-renderer.js`, que ya garantiza formato HH:MM manual
// + fallback `—` para fechas invalidas.
function architectBadgeHTML(info, deps) {
    if (!info || !info.state || !_architectBadge) return '';
    if (!deps || typeof deps.esc !== 'function' || typeof deps.ic !== 'function') return '';
    const { esc, ic } = deps;
    const a11y = _architectBadge.architectAriaLabel(info);
    const text = _architectBadge.architectBadgeText(info);
    let svg = '';
    switch (info.state) {
        case 'pending':  svg = ic('architect-pending', a11y);  break;
        case 'running':  svg = ic('architect-running', a11y);  break;
        case 'approved': svg = ic('architect-approved', a11y); break;
        case 'rejected': svg = ic('architect-rejected', a11y); break;
        default: return '';
    }
    return `<span class="lc-state-badge lc-state-architect-${info.state}" title="${esc(a11y)}" aria-label="${esc(a11y)}">${svg} ${esc(text)}</span>`;
}

module.exports = {
    activeAgents,
    recentlyFinished,
    nextInQueue,
    headerSlice,
    kpisSlice,
    equipoSlice,
    // #3955 EP8-H2 — helpers exportados para test unitario.
    skillSpark24h,
    cooldownFor,
    pipelineSlice,
    bloqueadosSlice,
    opsSlice,
    historialSlice,
    quotaSlice,
    quotaExhaustedSlice,
    reconcilerStaleOrdersSlice,
    // #2993 — widget de handoff
    handoffMetricsSlice,
    // #3625 — widget de audit trail de allowlist
    partialPauseAuditSlice,
    // #3954 EP8-H1 — bandeja de alertas del Home mission-control
    alertTraySlice,
    // #3897 CA-4 — métrica de precisión de Sherlock (solo agregados, SEC-6)
    sherlockPrecisionSlice,
    _sherlockRecordCorrecto,
    // #3642 — widget architect 4 estados
    architectStateSlice,
    architectBadgeHTML,
    // #2894 — exports internos para testing
    _resolveDevSkillFromLabels: resolveDevSkillFromLabels,
    _buildAgentsForActiveFase: buildAgentsForActiveFase,
    // #2976 — exports internos para testing
    _isDeterministicSkill: isDeterministicSkill,
    _DETERMINISTIC_SKILLS: DETERMINISTIC_SKILLS,
};
