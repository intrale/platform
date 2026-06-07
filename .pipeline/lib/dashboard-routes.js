// V3 Routes — registra los endpoints del nuevo dashboard kiosk vertical.
//
// CONVENCIÓN ANTI-FLICKER (#2801): toda nueva sección/área/tab DEBE usar el
// patrón "fetch JSON + DOM morphing manual" — los endpoints retornan JSON,
// el cliente muta los nodos por id sin reemplazar containers, y los items
// que entran/salen del set usan transiciones CSS (.entering / .leaving).
// NUNCA refrescar HTML completo de un container — produce flicker visible.
//
// Endpoints expuestos:
//   GET /                           home kiosk vertical (HTML)
//   GET /equipo                     tab Equipo
//   GET /pipeline                   tab Pipeline
//   GET /bloqueados                 tab Bloqueados
//   GET /issues                     tab Issues
//   GET /matriz                     tab Matriz
//   GET /ops                        tab Ops
//   GET /kpis                       tab KPIs detalle
//   GET /historial                  tab Historial
//   GET /costos                     tab Costos
//
//   GET /api/dash/header              {mode, allowedIssues, pulpoAlive, ...}
//   GET /api/dash/kpis                {prsLast7d, tokens24h:{total,by_provider}, agentDurationMedianMs, issueCycleTimeMs, bouncePct:{overall,byPhase,...}, cycleTimeMs(deprecated)}
//   GET /api/dash/active              {agents:[], totalRunning}
//   GET /api/dash/recent              {recent:[]}
//   GET /api/dash/queue               {queue:[]}
//   GET /api/dash/equipo              {skills:[]}
//   GET /api/dash/pipeline            {matrix, fases}
//   GET /api/dash/bloqueados          {bloqueados:[]}
//   GET /api/dash/ops                 {procesos, servicios, ...}
//   GET /api/dash/historial           {actividad:[]}
//   GET /api/dash/reconciler-stale-orders        {total_24h, by_reason}
//   GET /api/diagnostico/reconciler-stale-orders {total_24h, by_reason}  (alias)
//   GET /api/dash/quota-snapshot      {state, ageMs, ttlMin, staleMaxHours, lastSnapshot, parserState}  (#3013)

'use strict';

const path = require('path');
const slices = require('./dashboard-slices');
const home = require('../views/dashboard/home');
const sat = require('../views/dashboard/satellites');

// #3732 — Vista Ops extraída del monolito `satellites.js` a su propio módulo
// (split del épico #3715). Require defensivo (patrón CA-A2): si el módulo falla
// al cargar, `renderOpsView` cae a un fallback inerte VISIBLE (CA-A3 / REQ-SEC-7)
// en lugar de dejar la ventana en blanco o tirar 500.
let opsView = null;
try { opsView = require('../views/dashboard/ops'); }
catch (e) {
    try { console.warn('[dashboard-routes] ops view unavailable: ' + (e && e.message)); } catch { /* logger no debe romper el require */ }
}

// Render de la ventana Ops con el state en vivo (opsSlice) + fallback inerte.
// Consumido por el path legacy `/ops` (HTML_ROUTES) y por `?view=ops` (VIEW_SLUGS).
// Ambos resuelven al MISMO thunk para que no diverjan (riesgo declarado en #3732).
function renderOpsView(ctx, opts) {
    if (!opsView || typeof opsView.renderOps !== 'function') {
        return _opsInertFallback('módulo views/dashboard/ops no disponible (require falló)');
    }
    try {
        const state = (ctx && typeof ctx.getState === 'function') ? ctx.getState() : null;
        return opsView.renderOps(slices.opsSlice(state || {}), opts);
    } catch (e) {
        if (typeof opsView.renderInert === 'function') return opsView.renderInert((e && e.message) || 'error de render');
        return _opsInertFallback((e && e.message) || 'error de render');
    }
}

// Fallback inerte standalone para cuando el módulo ops NO cargó (no podemos
// usar opsView.renderInert porque opsView es null). Escapa el motivo.
function _opsInertFallback(reason) {
    const safe = String(reason || 'módulo no disponible').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Intrale · Ops</title></head>' +
        '<body><main style="padding:32px"><h1>Ventana Ops no disponible</h1><p>' + safe + '</p>' +
        '<p>Revisá los logs del dashboard. El render no queda en blanco (CA-A3 / REQ-SEC-7).</p></main></body></html>';
}

// #3736 — Ventana Descanso extraída a su propio módulo (padre #3715). Require
// defensivo: si el módulo aún no aterrizó, HTML_ROUTES/VIEW_SLUGS caen al
// renderer legacy de satellites.js (delegante de una línea).
let descansoView = null;
try { descansoView = require('../views/dashboard/descanso'); } catch { /* fallback a sat.renderModoDescanso */ }

// #3733 — Vista KPIs extraída (split de #3715). Require defensivo: si el
// módulo (o sus deps, ej. lib/escape-html.js) no carga, la entry `kpis` del
// router degrada a un panel inerte visible (CA-A3) en vez de tirar 500.
let kpisView = null;
try { kpisView = require('../views/dashboard/kpis'); } catch { /* opcional */ }

// Render de la ventana KPIs con el state en vivo + fallback inerte. Consumido
// por el path legacy `/kpis` (HTML_ROUTES) y por `?view=kpis` (VIEW_SLUGS),
// ambos al MISMO thunk para que no diverjan (CA-A2). Compone:
//   - kpisSlice (DORA-like: PRs/tokens24h/duración/cycle/rebote) — slice existente.
//   - matrixDerived (Definidos/Pendientes/Trabajando/Bloqueados/Necesitan humano).
//   - sysMini (CPU/RAM/salud) desde state.resources.
//   - routingMetrics (Commander determinístico vs LLM, 7d).
//   - metricsSlice (agentPerf + sesiones) vía ctx.getMetricsData (DI desde dashboard.js).
function renderKpisView(ctx, opts) {
    if (!kpisView || typeof kpisView.renderKpis !== 'function') {
        return _kpisInertFallback('módulo views/dashboard/kpis no disponible (require falló)');
    }
    try {
        const state = (ctx && typeof ctx.getState === 'function') ? ctx.getState() : {};
        const kSlice = slices.kpisSlice(state || {}, ctx || {});
        const metricsSlice = (ctx && typeof ctx.getMetricsData === 'function') ? ctx.getMetricsData() : null;
        return kpisView.renderKpis(Object.assign({}, opts || {}, {
            kpisSlice: kSlice,
            metricsSlice,
            matrixDerived: _deriveKpiCounts(state || {}, ctx),
            sysMini: _deriveSysMini(state || {}),
            routingMetrics: _computeRoutingMetricsSafe(),
        }));
    } catch (e) {
        if (typeof kpisView.renderInert === 'function') return kpisView.renderInert((e && e.message) || 'error de render');
        return _kpisInertFallback((e && e.message) || 'error de render');
    }
}

// Fallback inerte standalone para cuando el módulo kpis NO cargó.
function _kpisInertFallback(reason) {
    const safe = String(reason || 'módulo no disponible').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Intrale · KPIs</title></head>' +
        '<body><main style="padding:32px"><h1>Ventana KPIs no disponible</h1><p>' + safe + '</p>' +
        '<p>Revisá los logs del dashboard. El render no queda en blanco (CA-A3).</p></main></body></html>';
}

// Conteos del KPI row, replicando la lógica del home (dashboard.js:1577-1689).
// Consumidor de state (R2): no recomputa el matrix, lo lee.
function _deriveKpiCounts(state, ctx) {
    const entries = Object.entries(state.issueMatrix || {});
    const trabajando = entries.filter(([, d]) => d && d.estadoActual === 'trabajando').length;
    const pendientes = entries.filter(([, d]) => d && d.estadoActual === 'pendiente').length;
    const blockedBy = (state.blockedIssues && state.blockedIssues.blockedBy) || {};
    const blockedCount = entries.filter(([num, d]) => blockedBy[num] != null && d && d.estadoActual).length;
    const needsHuman = Array.isArray(state.bloqueados) ? state.bloqueados.length : 0;
    let definidos = 0;
    try {
        const config = (ctx && typeof ctx.loadConfig === 'function') ? ctx.loadConfig() : null;
        const defFases = (config && config.pipelines && config.pipelines.definicion && config.pipelines.definicion.fases) || [];
        const lastDef = defFases[defFases.length - 1];
        if (lastDef) {
            definidos = entries.filter(([, d]) => {
                const e = (d && d.fases && d.fases['definicion/' + lastDef]) || [];
                return e.some(x => x && x.estado === 'procesado');
            }).length;
        }
    } catch { /* sin config → definidos = 0 */ }
    return { definidos, pendientes, trabajando, blockedCount, needsHuman };
}

// Mini-card de salud del sistema (CPU/RAM + score), espejo de dashboard.js:2745-2765.
function _deriveSysMini(state) {
    const r = state.resources || {};
    const cpu = (r.cpuPercent == null) ? null : r.cpuPercent;
    const mem = (r.memPercent == null) ? null : r.memPercent;
    const maxCpu = r.maxCpu || 70;
    const maxMem = r.maxMem || 70;
    const worstUtil = Math.min(1, Math.max((cpu || 0) / Math.max(1, maxCpu), (mem || 0) / Math.max(1, maxMem)));
    const healthScore = Math.max(0, Math.round((1 - worstUtil) * 100));
    const health = healthScore > 60 ? 'Óptimo' : healthScore > 30 ? 'Presionado' : healthScore > 10 ? 'Crítico' : 'Saturado';
    return { cpu, mem, health, healthScore };
}

// Commander routing (determinístico vs LLM, 7d). Lectura defensiva: si el módulo
// o los logs faltan, devuelve {} y la vista degrada a "—".
function _computeRoutingMetricsSafe() {
    try {
        const commanderDet = require('./commander-deterministic');
        const LOG_DIR = path.join(__dirname, '..', 'logs');
        const routing = commanderDet.computeRoutingMetrics(LOG_DIR, { days: 7 });
        const today = (routing.buckets && routing.buckets[routing.buckets.length - 1]) || {};
        return { today };
    } catch { return {}; }
}

// #2976 — Lectura defensiva del flag de cuota Anthropic agotada.
// El módulo `./quota-exhausted-state` envuelve a `./quota-exhausted` (#2974,
// PR #2990 ya en main). El try/catch es defensa de cinturón en caso de que
// se ejecute sobre un checkout que aún no incluya esos assets (edge muy
// raro; en main siempre está). Usado por el SSR del banner: `curl /` debe
// devolver "cuota Anthropic" SOLO cuando el flag está activo (CA-14).
let quotaExhaustedState = null;
try { quotaExhaustedState = require('./quota-exhausted-state'); } catch { /* opcional */ }

// #3013 — Banner real-snapshot (depende del JSONL de #3012). Mismo patrón
// defensivo: si el módulo no carga (pre-merge), el endpoint devuelve estado
// 'missing' y el banner queda invisible — comportamiento idéntico al
// pre-feature (CA-15 / CA-S6).
let quotaSnapshotIntegration = null;
try { quotaSnapshotIntegration = require('./quota-snapshot-integration'); } catch { /* opcional */ }

// #3023 — Lectura del modo de pausa para filtrar la cola "Próximos 10" por
// allowlist. Lectura defensiva: si el módulo no carga, el endpoint omite el
// flag `partialPause.active` (degrada a comportamiento running, sin filtro).
let partialPause = null;
try { partialPause = require('./partial-pause'); } catch { /* opcional */ }

// #3259 — Health por provider (cache TTL 5min, allowlist live-ping) +
// dispatch-by-provider (activity log 24h). Lectura defensiva: si el módulo
// no carga, los endpoints devuelven 503.
let providerHealth = null;
try { providerHealth = require('./provider-health'); } catch { /* opcional */ }

// #3487 — Lectura defensiva de la fuente de verdad multi-ola (#3489 H1).
// Si el módulo no carga (pre-merge en un checkout antiguo), el endpoint
// `/api/dash/waves` devuelve estructura vacía con `message`, alineado
// con el CA-7 (Planificación no disponible) sin tirar 500.
let waves = null;
try { waves = require('./waves'); } catch { /* opcional */ }

// #3681 (hijo B del épico #3669) — Endpoint del widget Multi-Provider Coverage.
// Lectura defensiva: si el módulo (o sus deps, ej. ajv) no cargan, el endpoint
// devuelve el envelope `coverage_unavailable` con status 503 — degrada a
// "widget vacío" sin romper el dashboard (CA-B2).
let multiProviderCoverage = null;
try { multiProviderCoverage = require('./multi-provider-coverage'); } catch { /* opcional */ }

// #3259 — Rate-limit inline (security A05): hasta #3285 entregue el middleware
// reusable, mantenemos un semáforo simple en memoria por IP. 6 req/min cubre
// auto-refresh del dashboard (cada 30s = 2 req/min) + headroom para debugging.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 6;
const _rateLimitState = new Map(); // ip → array de timestamps
function rateLimitAllow(ip, now = Date.now()) {
    if (!ip) ip = 'unknown';
    const arr = (_rateLimitState.get(ip) || []).filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
    if (arr.length >= RATE_LIMIT_MAX) {
        _rateLimitState.set(ip, arr);
        return false;
    }
    arr.push(now);
    _rateLimitState.set(ip, arr);
    return true;
}

// #3487 — Whitelists cerrados para el endpoint /api/dash/waves. Cualquier
// valor fuera de estos sets se reemplaza por "unknown" antes de servirlo
// (security review: no propagar campos crudos del filesystem al cliente).
const WAVES_PRIORITY_WHITELIST = new Set(['critical', 'high', 'medium', 'low']);
const WAVES_SIZE_WHITELIST = new Set(['s', 'm', 'l', 'xl']);
const WAVES_STATUS_WHITELIST = new Set(['ready', 'needs-def', 'in-progress', 'blocked', 'completed']);
const WAVES_TITLE_MAX_CHARS = 200;
const WAVES_UNKNOWN = 'unknown';

/**
 * Normaliza un issue de una ola al shape mínimo {id, title, priority, size,
 * status}. NO usa spread — copia campo por campo para que cualquier campo
 * extra que venga de waves.json (intencional o accidental) NO se propague.
 *
 * @param {*} raw — entrada cruda (puede ser cualquier cosa)
 * @returns {{id:number,title:string,priority:string,size:string,status:string}|null}
 */
function normalizeWaveIssue(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const idNum = Number(typeof raw.number !== 'undefined' ? raw.number : raw.id);
    if (!Number.isInteger(idNum) || idNum <= 0) return null;
    const rawTitle = typeof raw.title === 'string' ? raw.title : '';
    const title = rawTitle.length > WAVES_TITLE_MAX_CHARS
        ? rawTitle.slice(0, WAVES_TITLE_MAX_CHARS)
        : rawTitle;
    const p = typeof raw.priority === 'string' ? raw.priority.toLowerCase() : '';
    const priority = WAVES_PRIORITY_WHITELIST.has(p) ? p : WAVES_UNKNOWN;
    const s = typeof raw.size === 'string' ? raw.size.toLowerCase() : '';
    const size = WAVES_SIZE_WHITELIST.has(s) ? s : WAVES_UNKNOWN;
    const st = typeof raw.status === 'string' ? raw.status.toLowerCase() : '';
    const status = WAVES_STATUS_WHITELIST.has(st) ? st : WAVES_UNKNOWN;
    return { id: idNum, title, priority, size, status };
}

/**
 * Normaliza una ola al shape público {number, name, goal, started_at, issues}.
 * Igual que normalizeWaveIssue: campo por campo, sin spread.
 */
function normalizeWave(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const number = Number(raw.number);
    if (!Number.isInteger(number)) return null;
    const name = typeof raw.name === 'string' ? raw.name.slice(0, WAVES_TITLE_MAX_CHARS) : '';
    const goal = typeof raw.goal === 'string' ? raw.goal.slice(0, WAVES_TITLE_MAX_CHARS) : '';
    const started_at = typeof raw.started_at === 'string' ? raw.started_at : null;
    const issues = Array.isArray(raw.issues)
        ? raw.issues.map(normalizeWaveIssue).filter(Boolean)
        : [];
    return { number, name, goal, started_at, issues };
}

/**
 * Construye el payload de /api/dash/waves desde lib/waves.js. Si la librería
 * no cargó o falla la lectura, retorna estructura vacía con `message` —
 * NUNCA expone paths, ENOENT ni stack traces (security CA-4/CA-8).
 *
 * #3616 — Usa `getHorizon(5)` para devolver la ola activa + las próximas 5
 * planificadas. Cada wave pasa por `normalizeWave` (whitelist por campo) —
 * no se expone path interno, hash, timestamp de boot ni stack traces.
 *
 * Backward compat: el payload mantiene `active_wave` + `next_wave` (la primera
 * planificada) por si algún cliente viejo los lee directamente — el frontend
 * nuevo prefiere iterar `planned[]`.
 */
function buildWavesPayload() {
    const updated_at = new Date().toISOString();
    if (!waves) {
        return {
            active_wave: null,
            next_wave: null,
            planned: [],
            updated_at,
            message: 'Planificación no disponible',
        };
    }
    let horizon = [];
    try {
        // getHorizon devuelve [activa, planned[0], ..., planned[N-1]] con
        // status taggeado por la lib. Lo desempacamos por status para
        // construir el payload público.
        horizon = waves.getHorizon(5) || [];
    } catch {
        horizon = [];
    }
    const rawActive = horizon.find((w) => w && w.status === 'active') || null;
    const rawPlanned = horizon.filter((w) => w && w.status === 'planned');
    const normActive = normalizeWave(rawActive);
    const normPlanned = rawPlanned.map(normalizeWave).filter(Boolean);
    const normNext = normPlanned.length > 0 ? normPlanned[0] : null;
    const payload = {
        active_wave: normActive,
        next_wave: normNext,
        planned: normPlanned,
        updated_at,
    };
    if (!normActive && normPlanned.length === 0) {
        payload.message = 'Planificación no disponible';
    }
    return payload;
}

const HTML_ROUTES = {
    '/equipo': sat.renderEquipo,
    '/pipeline': sat.renderPipeline,
    '/bloqueados': sat.renderBloqueados,
    '/issues': sat.renderIssues,
    '/matriz': sat.renderMatriz,
    // #3732 — /ops ahora resuelve al módulo extraído views/dashboard/ops.js
    // con el state en vivo (opsSlice). Recibe ctx desde handle().
    '/ops': (ctx) => renderOpsView(ctx),
    // #3733 — /kpis resuelve al módulo extraído views/dashboard/kpis.js con el
    // state en vivo. Mismo thunk que `?view=kpis` (VIEW_SLUGS) para no divergir.
    '/kpis': (ctx) => renderKpisView(ctx),
    '/historial': sat.renderHistorial,
    '/costos': sat.renderCostos,
    // #3736 — guard: usa el módulo extraído si está disponible, si no el legacy.
    '/modo-descanso': () => (descansoView && descansoView.renderDescanso)
        ? descansoView.renderDescanso()
        : sat.renderModoDescanso(),
};

// #3723 — Router cliente `?view=<slug>` + endpoint `/dashboard/partial`.
//
// Allowlist cerrada de slugs. Object.freeze para inmutabilidad runtime
// (CA-S1 + CA-T1). Lookup directo por clave — NUNCA concatenar `slug` a
// require()/fs.readFile/path.join. Las extracciones #3727..#3737 suman
// entries acá (`'multi-provider'`, `'equipo'`, `'pipeline'`, etc.).
//
// `title` (sin prefijo "Intrale · ") se usa para el `document.title` desde
// el cliente (CA-U2). El SSR ya emite el título completo dentro de cada
// renderer (ver `home.js` → `<title>Intrale · Operación</title>`).
//
// `render(opts)` devuelve el HTML completo de la vista. Por ahora es el
// mismo renderer del SSR, sin separación inner/shell — las extracciones
// futuras (#3727..#3737) refactorizan a `renderXxxInner()`. R4 del análisis
// de guru: los `<head>`/`<body>` redundantes insertados vía innerHTML los
// browsers los ignoran; `<style>` queda inerte; `<script>` no se ejecuta.
function _getQuotaStateSafe() {
    if (!quotaExhaustedState) return null;
    try { return quotaExhaustedState.getQuotaState(); } catch { return null; }
}

const VIEW_SLUGS = Object.freeze({
    home: {
        title: 'Operación',
        render: (opts) => home.renderHomeHTML(Object.assign(
            {},
            opts || {},
            { quotaState: _getQuotaStateSafe() }
        )),
    },
    // #3732 — Ventana Ops extraída (split del épico #3715). El render recibe
    // (opts, ctx) desde handle() para inyectar el state en vivo (opsSlice).
    // Resuelve al MISMO thunk que el path legacy `/ops` (HTML_ROUTES) para que
    // ambos no diverjan (CA-A2 + smoke CA-G2).
    ops: {
        title: 'Ops',
        render: (opts, ctx) => renderOpsView(ctx, opts),
    },
    // #3736 — Ventana Descanso (slug nuevo `descanso`; el path legacy
    // `/modo-descanso` sigue vivo en HTML_ROUTES sin redirect — orígenes
    // operativos distintos: deep-link directo vs router cliente).
    descanso: {
        title: 'Descanso',
        render: (opts) => (descansoView && descansoView.renderDescanso)
            ? descansoView.renderDescanso(opts)
            : sat.renderModoDescanso(),
    },
    // #3733 — Ventana KPIs extraída (split de #3715). El render recibe
    // (opts, ctx) desde handle() para inyectar el state en vivo (slice KPIs)
    // y resolver al MISMO thunk que el path legacy `/kpis` (HTML_ROUTES), para
    // que ambos no diverjan (CA-A2). Degrada a panel inerte visible (CA-A3) si
    // el módulo no cargó.
    kpis: {
        title: 'KPIs',
        render: (opts, ctx) => renderKpisView(ctx, opts),
    },
    // #3727..#3737 sumarán acá:
    // 'multi-provider':          { title: 'Multi-provider',          render: () => mp.renderMultiProvider() },
    // 'multi-provider-coverage': { title: 'Multi-provider Coverage', render: () => mpc.renderMultiProviderCoverage() },
    // 'equipo':                  { title: 'Equipo',                  render: () => sat.renderEquipo() },
    // 'pipeline':                { title: 'Pipeline',                render: () => sat.renderPipeline() },
    // ... una entry por cada ventana extraída.
});

// CA-S1 — fast-reject regex antes del lookup en allowlist. Defensa en
// profundidad: si alguien renombrara un slug a algo "raro" igualmente
// quedaría bloqueado por estructura. Acotado a 31 chars para evitar
// memory pressure y para alinearse con conveniones de URLs cortas.
const VIEW_SLUG_REGEX = /^[a-z][a-z0-9-]{0,30}$/;

// Cap de tamaño del query param antes de regex (evita pasar payloads
// arbitrarios al motor regex).
const VIEW_SLUG_MAX_LEN = 64;

// CA-S2 — loopback gate (defense-in-depth). El bind ya es 127.0.0.1 por
// default (#3177 + #3191), pero validamos también acá por si en algún
// momento se levanta con DASHBOARD_HOST=0.0.0.0 intencionalmente.
function isLoopbackReq(req) {
    const ra = (req && req.socket && req.socket.remoteAddress) || '';
    return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

// CA-S3 — `Sec-Fetch-Site` defense-in-depth. SI el header está presente
// debe ser `same-origin`. Ausencia se acepta (reload directo, browsers
// viejos, herramientas tipo curl) — la barrera dura para esos casos es
// CA-S2 (loopback). Documentado en el header del endpoint partial.
function isSameOriginFetch(req) {
    const site = req && req.headers && req.headers['sec-fetch-site'];
    if (!site) return true;
    return site === 'same-origin';
}

// CA-S5 — headers fijos del partial endpoint. Cache-Control no-store
// evita que intermediarios cacheen un slice mutable; nosniff evita
// reinterpretación por el navegador; Referrer-Policy no-referrer no
// filtra a terceros.
function sendPartialHtml(res, html) {
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
}

// Log estructurado de rechazo del partial (CA-S6). NO loggea el slug
// completo crudo — sólo flags de control para detectar probing/abuse
// sin dar pie a log-injection.
function _logPartialRejected(req, reason, slugLen) {
    try {
        console.warn(JSON.stringify({
            event: 'partial_rejected',
            reason,
            remoteAddr: (req && req.socket && req.socket.remoteAddress) || null,
            secFetchSite: (req && req.headers && req.headers['sec-fetch-site']) || null,
            slugLen: typeof slugLen === 'number' ? slugLen : null,
            ts: new Date().toISOString(),
        }));
    } catch { /* logger no debe romper la respuesta */ }
}

const API_ROUTES = {
    '/api/dash/header': (state, ctx) => slices.headerSlice(state, ctx),
    '/api/dash/kpis': (state, ctx) => slices.kpisSlice(state, ctx),
    '/api/dash/active': (state) => {
        const agents = slices.activeAgents(state);
        return { agents, totalRunning: agents.length };
    },
    // #3035 — `?errorsOnly=1` filtra en server por `resultado === 'rechazado'`.
    // Parseo defensivo: solo los strings literales '1' o 'true' activan el
    // filtro. Cualquier otro valor (incluyendo ausente, 0, false, null) →
    // vista mezclada por defecto. Evita inyección por coerción débil.
    '/api/dash/recent': (state, ctx, query) => {
        const v = query && query.get('errorsOnly');
        const onlyRejected = v === '1' || v === 'true';
        return { recent: slices.recentlyFinished(state, 10, { onlyRejected }) };
    },
    // #3023 — La cola "Próximos 10" se filtra por allowlist cuando el
    // pipeline está en `partial_pause`. Leemos el modo una sola vez por
    // request y lo pasamos al slice (evita doble FS read) + lo exponemos
    // en el payload para que el front renderice el badge "filtrado por
    // pausa parcial" sin re-pegarle al header. El payload sólo expone
    // `{ active, allowedIssues }` — omite `source`/`createdAt`/`depSources`
    // por minimización (security review).
    '/api/dash/queue': (state, ctx) => {
        let pipelineMode = null;
        if (partialPause && typeof partialPause.getPipelineMode === 'function') {
            try { pipelineMode = partialPause.getPipelineMode(); } catch { pipelineMode = null; }
        }
        const queue = slices.nextInQueue(state, ctx, 10, { pipelineMode });
        const active = !!(pipelineMode && pipelineMode.mode === 'partial_pause');
        const allowedIssues = active ? pipelineMode.allowedIssues : [];
        return { queue, partialPause: { active, allowedIssues } };
    },
    '/api/dash/equipo': (state) => slices.equipoSlice(state),
    '/api/dash/pipeline': (state) => slices.pipelineSlice(state),
    '/api/dash/bloqueados': (state) => slices.bloqueadosSlice(state),
    '/api/dash/ops': (state) => slices.opsSlice(state),
    '/api/dash/historial': (state) => slices.historialSlice(state),
    '/api/dash/quota': (state, ctx) => slices.quotaSlice(state, ctx),
    // #2976 — banner amarillo de cuota Anthropic agotada (modo determinístico).
    // Polling natural del dashboard cubre aparición/desaparición sin reload.
    '/api/dash/quota-exhausted': (state) => slices.quotaExhaustedSlice(state),
    // #3013 — banner real-snapshot (4 estados: fresh / stale / missing /
    // parser-offline). El módulo es read-only (sólo `getBannerState`), no
    // muta ni dispara gates. Si el módulo no se cargó (pre-merge de #3012)
    // o el kill-switch está off, devuelve estado 'missing' — el banner queda
    // hidden y el dashboard se ve idéntico al pre-feature (CA-15).
    '/api/dash/quota-snapshot': () => {
        if (!quotaSnapshotIntegration) {
            return { state: 'missing', ageMs: null, ttlMin: 90, staleMaxHours: 6, lastSnapshot: null, parserState: null, reason: 'module_unavailable' };
        }
        try { return quotaSnapshotIntegration.getBannerState(); }
        catch (e) {
            // R8: race en lectura → fallback silencioso a missing.
            return { state: 'missing', ageMs: null, ttlMin: 90, staleMaxHours: 6, lastSnapshot: null, parserState: null, reason: 'io_error' };
        }
    },
    // #2994 — Contador de órdenes del reconciler descartadas por stale.
    // Mismo handler bajo dos paths: el `/api/dash/*` sigue la convención del
    // dashboard kiosk y `/api/diagnostico/*` es el alias documentado en CA5
    // para que humanos puedan consultarlo con `curl` sin acordarse del
    // namespace interno.
    '/api/dash/reconciler-stale-orders': (state, ctx) => slices.reconcilerStaleOrdersSlice(state, ctx),
    '/api/diagnostico/reconciler-stale-orders': (state, ctx) => slices.reconcilerStaleOrdersSlice(state, ctx),
    // #2993 — widget de handoff cross-agente. CA-C2: % hit rate, ahorro USD
    // estimado mensual, sparkline 7d. Refresh natural cada 30s desde el
    // cliente (el endpoint es stateless). Bajo `/api/dash/*` para seguir la
    // convención del kiosk vertical y `/api/handoff-metrics` como alias
    // documentado en CA-C2 (nombre humano-friendly para curl/debug).
    '/api/dash/handoff-metrics': (state, ctx) => slices.handoffMetricsSlice(state, ctx),
    '/api/handoff-metrics': (state, ctx) => slices.handoffMetricsSlice(state, ctx),
    // #3625 CA-5 — widget de audit trail de mutaciones a la allowlist
    // (partial-pause). Devuelve las últimas N entries del audit log, stats
    // de 24h y estado del hash-chain. Refresh natural 30s desde el cliente.
    '/api/dash/partial-pause-audit': (state, ctx) => slices.partialPauseAuditSlice(state, ctx),
    '/api/partial-pause-audit': (state, ctx) => slices.partialPauseAuditSlice(state, ctx),
    // #3492 — ETA agregada por ola (probabilística p50/p75/p90). El cálculo
    // vive en `lib/eta-wave.js`; dashboard.js lo refresca fire-and-forget en
    // un cache TTL 30s y lo publica en `state.olaETA`. Si el módulo no cargó
    // (pipeline antiguo) o el primer refresh aún no completó, devolvemos
    // `{ ready: false }` para que la vista muestre placeholder sin error.
    // Formato de minutos (`45m` / `1h 2m`) se calcula en la VISTA (CA-23).
    '/api/dash/ola-eta': (state) => {
        const data = state && state.olaETA;
        if (!data) return { ready: false };
        return {
            ready: true,
            issues: data.issues || [],
            totalP50: data.totalP50,
            totalP75: data.totalP75,
            totalP90: data.totalP90,
            byIssue: data.byIssue || {},
            concurrencyUsed: data.concurrencyUsed,
            bySize: data.bySize,
            rebounceRate: data.rebounceRate,
            refreshedAt: data.refreshedAt,
        };
    },
    // #3259 / CA-6 — Despachos por provider últimas 24h (lectura del activity
    // log). Síncrono y barato; el card en la home dashboard lo poltea cada 30s.
    '/api/dash/dispatch-by-provider': () => {
        if (!providerHealth) return { error: 'module_unavailable', total: 0, totals: {} };
        return providerHealth.getDispatchByProvider();
    },
    '/api/dashboard/dispatch-by-provider': () => {
        if (!providerHealth) return { error: 'module_unavailable', total: 0, totals: {} };
        return providerHealth.getDispatchByProvider();
    },
    // #3487 — Widget "Próximas Olas". Endpoint best-effort: consume
    // lib/waves.js, retorna {active_wave, next_wave, updated_at} con
    // whitelist explícito de campos y normalización a strings/numbers
    // conocidos. Cualquier error de lectura/parse degrada a payload
    // vacío con `message: "Planificación no disponible"` y HTTP 200
    // (CA-7). Reusa sendJson() → Cache-Control: no-store coherente
    // con el resto de /api/dash/*.
    '/api/dash/waves': () => buildWavesPayload(),
    // #3681 — Widget Multi-Provider Coverage. Lee `.pipeline/multi-provider-coverage.json`
    // (output runtime del harness #3680), valida con ajv contra el schema canónico
    // y sanitiza el payload con whitelist explícita por campo. NUNCA expone
    // API key prefixes, hostnames, latencias absolutas ni raw output (CA-B3 +
    // REQ-SEC-B4). Si el JSON falta, no valida o el módulo (o ajv) no cargan,
    // retorna `{error: 'coverage_unavailable', reason, _status: 503}` — el
    // mapper de status en handle() lo convierte a HTTP 503 (CA-B2). Síncrono
    // (lectura FS local barata, no se registra en ASYNC_API_ROUTES).
    '/api/dash/multi-provider-coverage': () => {
        if (!multiProviderCoverage) {
            return { error: 'coverage_unavailable', reason: 'module_unavailable', _status: 503 };
        }
        try {
            return multiProviderCoverage.buildCoveragePayload();
        } catch {
            return { error: 'coverage_unavailable', reason: 'io_error', _status: 503 };
        }
    },
};

// #3259 / CA-5 — Rutas ASYNC (devuelven Promise). El handler las awaitea.
// `/api/pulpo/provider-health` corre live-ping detrás del cache TTL 5min, no
// martilla las APIs. Allowlist de providers fija en live-ping.js (SSRF
// defense). Rate-limit aplicado en `handle()`.
const ASYNC_API_ROUTES = {
    '/api/pulpo/provider-health': async () => {
        if (!providerHealth) return { error: 'module_unavailable', providers: [] };
        return await providerHealth.getProviderHealth();
    },
};

function sendJson(res, payload, status = 200) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function sendHtml(res, html) {
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
    });
    res.end(html);
}

/**
 * Intentar manejar la request con las rutas V3.
 * @returns {boolean} true si la request fue manejada (no llamar al fallback).
 */
function handle(req, res, ctx) {
    const url = req.url;
    if (req.method !== 'GET') return false;

    // `/` y `/v3` (alias retrocompat) sirven la nueva home kiosk vertical.
    // El render legacy se preserva en `/legacy` (servido por el catch-all
    // de dashboard.js — no se matchea aquí).
    if (url === '/' || url === '' || url === '/v3' || url === '/v3/') {
        // #2976 — SSR del banner de cuota agotada: leemos el flag una
        // vez por request y se lo pasamos a `renderHomeHTML` para que
        // el HTML inicial contenga "cuota Anthropic" SOLO cuando el
        // flag está activo (CA-14). El polling client-side actualiza
        // el banner después del primer render sin reload (CA-2).
        let quotaState = null;
        if (quotaExhaustedState) {
            try { quotaState = quotaExhaustedState.getQuotaState(); } catch { quotaState = null; }
        }
        sendHtml(res, home.renderHomeHTML({ quotaState }));
        return true;
    }

    const pathnameOnly = url.split('?')[0];

    // #3723 — `/dashboard?view=<slug>` SSR shell + view inicial.
    //
    // CA-T1: deep-link directo (`/dashboard?view=foo` pegado en la barra
    // del browser) renderiza SSR la vista correcta sin esperar JS. Slug
    // desconocido → fallback a `home` con bandera `unknownViewRequested`
    // para que el cliente muestre el banner CA-U5. NO devolvemos 400 en
    // el SSR (el 400 vive solo en el partial endpoint, CA-S1) para no
    // dejar al operador con pantalla en blanco si copió mal una URL.
    //
    // CA-S4: el slug NUNCA se refleja en el body — sólo el flag bool
    // y el slug "efectivo" (que pertenece a la allowlist por
    // construcción) se pasan al renderer.
    if (pathnameOnly === '/dashboard' || pathnameOnly === '/dashboard/') {
        let q;
        try { q = new URL(url, 'http://x').searchParams; } catch { q = new URLSearchParams(); }
        const raw = (q.get('view') || 'home').slice(0, VIEW_SLUG_MAX_LEN);
        const valid = VIEW_SLUG_REGEX.test(raw) && Object.prototype.hasOwnProperty.call(VIEW_SLUGS, raw);
        const slug = valid ? raw : 'home';
        const opts = {
            currentView: slug,
            unknownViewRequested: !valid,
        };
        try {
            // #3732 — `ctx` como 2º arg: las vistas con state en vivo (ops)
            // lo consumen; las que no (home) lo ignoran (firma retrocompatible).
            sendHtml(res, VIEW_SLUGS[slug].render(opts, ctx));
        } catch (e) {
            try { console.error(JSON.stringify({ event: 'dashboard_render_error', slug, msg: e.message, ts: new Date().toISOString() })); } catch {}
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('internal error');
        }
        return true;
    }

    // #3723 — `/dashboard/partial?view=<slug>` — lazy-load por DOM morphing.
    //
    // Orden de gates (acordado por architect + security):
    //   CA-S2 loopback → CA-S3 Sec-Fetch-Site (sólo si presente) →
    //   CA-S1 allowlist+regex → render.
    //
    // CA-S4: body genérico `'bad request'` en 400 — el slug NUNCA se refleja.
    // Sólo va al logger estructurado JSON (CA-S6) con `slugLen` (no el slug
    // crudo) para que probing automatizado quede visible sin abrir log-injection.
    //
    // CA-S7: este endpoint NO se agrega a `lib/screenshot-capture.js`
    // ALLOWED_PATHS — el cliente browser lo invoca via `fetch` desde el
    // propio dashboard ya cargado, NO via screenshot-capture headless.
    if (pathnameOnly === '/dashboard/partial') {
        // CA-S2 — loopback gate (defense-in-depth; bind ya es 127.0.0.1).
        if (!isLoopbackReq(req)) {
            _logPartialRejected(req, 'non_loopback');
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end('forbidden');
            return true;
        }
        // CA-S3 — Sec-Fetch-Site mismatch (sólo si está presente).
        if (!isSameOriginFetch(req)) {
            _logPartialRejected(req, 'cross_origin_fetch');
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end('forbidden');
            return true;
        }
        // CA-S1 — slug allowlist + regex.
        let q;
        try { q = new URL(url, 'http://x').searchParams; } catch { q = new URLSearchParams(); }
        const reqSlug = (q.get('view') || '').slice(0, VIEW_SLUG_MAX_LEN);
        if (!VIEW_SLUG_REGEX.test(reqSlug) || !Object.prototype.hasOwnProperty.call(VIEW_SLUGS, reqSlug)) {
            _logPartialRejected(req, 'unknown_slug', reqSlug.length);
            // CA-S1: 400, NO 404 (no leak de existencia).
            // CA-S4: body genérico, el slug NUNCA se refleja.
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end('bad request');
            return true;
        }
        try {
            sendPartialHtml(res, VIEW_SLUGS[reqSlug].render({ currentView: reqSlug }, ctx));
        } catch (e) {
            try { console.error(JSON.stringify({ event: 'partial_render_error', slug: reqSlug, msg: e.message, ts: new Date().toISOString() })); } catch {}
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end('internal error');
        }
        return true;
    }

    const apiPath = pathnameOnly;
    if (API_ROUTES[apiPath]) {
        try {
            const state = ctx.getState();
            // #3035 — Parseo del query string con URLSearchParams para que
            // los handlers que necesiten leer params (ej. errorsOnly) lo
            // hagan de forma segura. URL base inerte (`http://x`), no se
            // resuelve contra red. Si la URL viene mal formada, query =
            // URLSearchParams vacío para que los handlers degraden a default.
            let query;
            try {
                query = new URL(url, 'http://x').searchParams;
            } catch {
                query = new URLSearchParams();
            }
            const payload = API_ROUTES[apiPath](state, ctx, query);
            // #3681 — Patrón opt-in: si el handler emite `_status` (o el
            // envelope canónico `coverage_unavailable`), lo mapeamos a HTTP
            // 503 sin requerir refactor del resto de handlers. El campo
            // `_status` se elimina del body — defensa: no exponer el
            // mecanismo al cliente.
            if (payload && typeof payload === 'object'
                && (Number.isInteger(payload._status) || payload.error === 'coverage_unavailable')) {
                const status = Number.isInteger(payload._status) ? payload._status : 503;
                const { _status, ...body } = payload;
                sendJson(res, body, status);
            } else {
                sendJson(res, payload);
            }
        } catch (e) {
            sendJson(res, { error: e.message || String(e) }, 500);
        }
        return true;
    }

    // #3259 / CA-5 — Rutas async (provider-health). Rate-limit inline + cache
    // TTL 5min internamente. La respuesta nunca incluye API keys (security A02).
    if (ASYNC_API_ROUTES[apiPath]) {
        const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
        if (!rateLimitAllow(ip)) {
            sendJson(res, { error: 'rate_limited', retry_after_s: 60 }, 503);
            return true;
        }
        // Fire-and-forget: no awaiteamos para no bloquear el sync handle()
        // del dashboard. El cliente cierra cuando el body llega.
        Promise.resolve()
            .then(() => ASYNC_API_ROUTES[apiPath](ctx.getState(), ctx))
            .then(payload => sendJson(res, payload))
            .catch(e => sendJson(res, { error: e.message || String(e) }, 500));
        return true;
    }

    if (HTML_ROUTES[apiPath]) {
        // #3732 — `ctx` pasado a los renderers HTML: ops lo usa para el state
        // en vivo; el resto (sat.*) lo ignora (firma sin args, retrocompatible).
        try { sendHtml(res, HTML_ROUTES[apiPath](ctx)); }
        catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('error rendering page: ' + (e.message || e));
        }
        return true;
    }

    return false;
}

module.exports = {
    handle,
    // #3723 — Allowlist canónica de slugs del router cliente.
    // Fuente única consumida por el navbar (#3726). NO duplicar en otra parte.
    VIEW_SLUGS,
    VIEW_SLUG_REGEX,
    // Exportados para tests (#3487, #3723).
    _internal: {
        buildWavesPayload,
        normalizeWave,
        normalizeWaveIssue,
        WAVES_PRIORITY_WHITELIST,
        WAVES_SIZE_WHITELIST,
        WAVES_STATUS_WHITELIST,
        WAVES_TITLE_MAX_CHARS,
        WAVES_UNKNOWN,
        // #3723
        isLoopbackReq,
        isSameOriginFetch,
        sendPartialHtml,
        VIEW_SLUG_MAX_LEN,
    },
};
