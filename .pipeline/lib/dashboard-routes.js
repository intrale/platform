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
 */
function buildWavesPayload() {
    const updated_at = new Date().toISOString();
    if (!waves) {
        return { active_wave: null, next_wave: null, updated_at, message: 'Planificación no disponible' };
    }
    let active = null;
    let nextWave = null;
    try {
        active = waves.getActiveWave();
    } catch {
        // No volcar el error al cliente — degradación silenciosa.
        active = null;
    }
    if (active) {
        try {
            nextWave = waves.getPlannedWave(active.number + 1);
        } catch {
            nextWave = null;
        }
    }
    const normActive = normalizeWave(active);
    const normNext = normalizeWave(nextWave);
    const payload = { active_wave: normActive, next_wave: normNext, updated_at };
    if (!normActive && !normNext) payload.message = 'Planificación no disponible';
    return payload;
}

const HTML_ROUTES = {
    '/equipo': sat.renderEquipo,
    '/pipeline': sat.renderPipeline,
    '/bloqueados': sat.renderBloqueados,
    '/issues': sat.renderIssues,
    '/matriz': sat.renderMatriz,
    '/ops': sat.renderOps,
    '/kpis': sat.renderKpisDetail,
    '/historial': sat.renderHistorial,
    '/costos': sat.renderCostos,
    '/modo-descanso': sat.renderModoDescanso,
};

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

    const apiPath = url.split('?')[0];
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
            sendJson(res, payload);
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
        try { sendHtml(res, HTML_ROUTES[apiPath]()); }
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
    // Exportados para tests (#3487).
    _internal: {
        buildWavesPayload,
        normalizeWave,
        normalizeWaveIssue,
        WAVES_PRIORITY_WHITELIST,
        WAVES_SIZE_WHITELIST,
        WAVES_STATUS_WHITELIST,
        WAVES_TITLE_MAX_CHARS,
        WAVES_UNKNOWN,
    },
};
