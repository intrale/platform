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
// #3961 EP8-H8 — loader de umbrales configurables del dashboard (CA-6/CA-9).
let dashboardThresholds = null;
try { dashboardThresholds = require('./dashboard-thresholds'); } catch { /* opcional */ }
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

// EP8-H7 (#3960) — store de transiciones vivo↔muerto (CA-1) y serie temporal
// del reconciler (CA-4). Best-effort: si faltan, los endpoints degradan a
// payload vacío sin romper el resto del dashboard.
let opsTransitions = null;
try { opsTransitions = require('./process-transitions'); } catch { /* opcional */ }
let opsReconcilerHistory = null;
try { opsReconcilerHistory = require('./reconciler-history'); } catch { /* opcional */ }
// #3959 (EP8-H6) CA-2 — historial horario de matrixCounts para la tendencia
// ▲▼ por celda de la Matriz. Opcional: si no cargó, el slice degrada sin flecha.
let matrixHistory = null;
try { matrixHistory = require('./matrix-history'); } catch { /* opcional */ }

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

// #3737 — Vista Providers (NUEVA, split del épico #3715). Lista las
// credenciales gestionadas (masked + fingerprint desde secrets-rw.listKeys()),
// READ-ONLY. Require defensivo (patrón CA-A2): si el módulo falla al cargar,
// `renderProvidersView` cae a un fallback inerte VISIBLE (CA-A3 / SEC-7) en
// lugar de dejar la ventana en blanco o tirar 500. Coexiste con /multi-provider.
let providersView = null;
try { providersView = require('../views/dashboard/providers'); }
catch (e) {
    try { console.warn('[dashboard-routes] providers view unavailable: ' + (e && e.message)); } catch { /* logger no debe romper el require */ }
}

// Render de la ventana Providers + fallback inerte. La vista NO necesita el
// state en vivo (lee `secrets.listKeys()` por sí misma), por eso el thunk no
// consume ctx. Consumido por el path legacy `/providers` (HTML_ROUTES) y por
// `?view=providers` (VIEW_SLUGS) — ambos resuelven al MISMO thunk para que no
// diverjan (CA-PRV-3).
function renderProvidersView() {
    if (!providersView || typeof providersView.renderProviders !== 'function') {
        return _providersInertFallback('módulo views/dashboard/providers no disponible (require falló)');
    }
    try {
        return providersView.renderProviders();
    } catch (e) {
        if (typeof providersView.renderInert === 'function') return providersView.renderInert((e && e.message) || 'error de render');
        return _providersInertFallback((e && e.message) || 'error de render');
    }
}

// Fallback inerte standalone para cuando el módulo providers NO cargó.
function _providersInertFallback(reason) {
    const safe = String(reason || 'módulo no disponible').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Intrale · Providers</title></head>' +
        '<body><main style="padding:32px"><h1>Ventana Providers no disponible</h1><p>' + safe + '</p>' +
        '<p>Revisá los logs del dashboard. El render no queda en blanco (CA-A3 / SEC-7).</p></main></body></html>';
}

// #3736 — Ventana Descanso extraída a su propio módulo (padre #3715). Require
// defensivo: si el módulo aún no aterrizó, HTML_ROUTES/VIEW_SLUGS caen al
// renderer legacy de satellites.js (delegante de una línea).
let descansoView = null;
try { descansoView = require('../views/dashboard/descanso'); } catch { /* fallback a sat.renderModoDescanso */ }

// #3731 — Ventana Matriz extraída del monolito `satellites.js` a su propio
// módulo (split del épico #3715). Require defensivo (patrón CA-A2): si el
// módulo falla al cargar, `renderMatrizView` cae a un fallback inerte VISIBLE
// (CA-A3) en lugar de dejar la ventana en blanco o tirar 500. Ventana
// READ-ONLY: hidrata client-side desde `/api/dash/pipeline`.
let matrizView = null;
try { matrizView = require('../views/dashboard/matriz'); } catch { /* opcional */ }

// Render de la ventana Matriz con fallback inerte. Consumido por el path
// legacy `/matriz` (HTML_ROUTES) y por `?view=matriz` (VIEW_SLUGS), ambos al
// MISMO thunk para que no diverjan (CA-A2). No requiere state inyectado: la
// grilla se hidrata 100% client-side.
function renderMatrizView() {
    if (!matrizView || typeof matrizView.renderMatriz !== 'function') {
        return _matrizInertFallback('módulo views/dashboard/matriz no disponible (require falló)');
    }
    try {
        return matrizView.renderMatriz();
    } catch (e) {
        return _matrizInertFallback((e && e.message) || 'error de render');
    }
}

// Fallback inerte standalone para cuando el módulo matriz NO cargó. Escapa el
// motivo para no abrir reflexión cruda (CA-A3).
function _matrizInertFallback(reason) {
    const safe = String(reason || 'módulo no disponible').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Intrale · Matriz</title></head>' +
        '<body><main style="padding:32px"><h1>Ventana Matriz no disponible</h1><p>' + safe + '</p>' +
        '<p>Revisá los logs del dashboard. El render no queda en blanco (CA-A3).</p></main></body></html>';
}

// #3729 — Vista Bloqueados extraída (split de #3715). Require defensivo: si el
// módulo (o sus deps, ej. lib/escape-html.js) no carga, `renderBloqueadosView`
// degrada a un panel inerte visible (CA-A3) en vez de tirar 500.
let bloqueadosView = null;
try { bloqueadosView = require('../views/dashboard/bloqueados'); }
catch (e) {
    try { console.warn('[dashboard-routes] bloqueados view unavailable: ' + (e && e.message)); } catch { /* logger no debe romper el require */ }
}

// Render de la ventana Bloqueados con el state en vivo (bloqueadosSlice) +
// fallback inerte. Consumido por el path legacy `/bloqueados` (HTML_ROUTES) y por
// `?view=bloqueados` (VIEW_SLUGS), ambos al MISMO thunk para que no diverjan
// (CA-A2). El slice ordena por prioridad manual y enriquece `priorityIndex`.
function renderBloqueadosView(ctx, opts) {
    if (!bloqueadosView || typeof bloqueadosView.renderBloqueados !== 'function') {
        return _bloqueadosInertFallback('módulo views/dashboard/bloqueados no disponible (require falló)');
    }
    try {
        const state = (ctx && typeof ctx.getState === 'function') ? ctx.getState() : {};
        const sliceState = Object.assign({}, state || {}, slices.bloqueadosSlice(state || {}));
        return bloqueadosView.renderBloqueados(sliceState, opts);
    } catch (e) {
        return _bloqueadosInertFallback((e && e.message) || 'error de render');
    }
}

// Fallback inerte standalone para cuando el módulo bloqueados NO cargó. Escapa el
// motivo para no abrir reflexión cruda (CA-A3).
function _bloqueadosInertFallback(reason) {
    const safe = String(reason || 'módulo no disponible').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Intrale · Bloqueados</title></head>' +
        '<body><main style="padding:32px"><h1>Ventana Bloqueados no disponible</h1><p>' + safe + '</p>' +
        '<p>Revisá los logs del dashboard. El render no queda en blanco (CA-A3).</p></main></body></html>';
}

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
// #3961 EP8-H8 — helper try/catch que nunca rompe el render (fail-open).
function _safe(fn) {
    try { return fn(); } catch { return null; }
}

// #3961 EP8-H8 (CA-4) — series diarias de tendencia para las cards DORA. Deriva
// el throughput/PRs por día contando las entregas con timestamp; las métricas
// sin serie disponible quedan en `null` → la sparkline muestra "muestra
// insuficiente" (degrade honesto, G-5). No instrumenta nada nuevo.
function _buildDoraSpark(metricsSlice) {
    try {
        const entregas = (metricsSlice && Array.isArray(metricsSlice.entregas)) ? metricsSlice.entregas : [];
        const items = entregas
            .map((e) => (e && (e.ts != null) ? { ts: e.ts } : null))
            .filter(Boolean);
        const prs = slices.dailyBuckets(items, { days: 7, agg: 'count' });
        return { prs, cycle: null, duration: null, bounce: null };
    } catch {
        return { prs: null, cycle: null, duration: null, bounce: null };
    }
}

// #3961 EP8-H8 (CA-6) — normaliza los valores DORA para el chequeo de umbral.
function _buildDoraForAlerts(kSlice, metricsSlice) {
    try {
        const k = kSlice || {};
        const m = metricsSlice || {};
        const now = Date.now();
        const entregas = Array.isArray(m.entregas) ? m.entregas : [];
        const toMs = (ts) => (typeof ts === 'number' ? ts : Date.parse(String(ts || '')));
        const delivered7d = entregas.filter((e) => {
            const ms = e ? toMs(e.ts) : NaN;
            return Number.isFinite(ms) && (now - ms) < 7 * 86400000;
        }).length;
        const throughputPerDay = Math.round((delivered7d / 7) * 10) / 10;
        const totalProcessed = Number(m.totalProcessed) || 0;
        const totalRejected = Number(m.totalRejected) || 0;
        const failRatePct = totalProcessed > 0 ? (totalRejected / totalProcessed) * 100 : null;
        return {
            leadTimeMs: Number.isFinite(k.issueCycleTimeMs) ? k.issueCycleTimeMs : null,
            throughputPerDay,
            failRatePct,
        };
    } catch {
        return { leadTimeMs: null, throughputPerDay: null, failRatePct: null };
    }
}

function renderKpisView(ctx, opts) {
    if (!kpisView || typeof kpisView.renderKpis !== 'function') {
        return _kpisInertFallback('módulo views/dashboard/kpis no disponible (require falló)');
    }
    try {
        const state = (ctx && typeof ctx.getState === 'function') ? ctx.getState() : {};
        const kSlice = slices.kpisSlice(state || {}, ctx || {});
        const metricsSlice = (ctx && typeof ctx.getMetricsData === 'function') ? ctx.getMetricsData() : null;
        // #3932 EP3-H6 — panel "Entregables por skill" (sólo agregados, CA-5).
        let deliverablesBySkill = null;
        try { deliverablesBySkill = slices.deliverablesBySkillSlice(state || {}, ctx || {}); }
        catch { deliverablesBySkill = null; }

        // #3961 EP8-H8 — umbrales configurables + KPIs operativos + alertas.
        const config = (ctx && typeof ctx.loadConfig === 'function') ? _safe(() => ctx.loadConfig())
            : ((state && state.config) || null);
        const thresholds = dashboardThresholds
            ? dashboardThresholds.loadThresholds(config)
            : null;
        const sherlock = _safe(() => slices.sherlockPrecisionSlice(state || {}, ctx || {}));
        const voice = _safe(() => slices.voiceLatencySlice(state || {}, ctx || {}));

        // CA-4 — series diarias de tendencia DORA. El throughput/PRs diario sale
        // de las entregas (count por día); el resto degrada a insuficiente (G-5).
        const doraSpark = _buildDoraSpark(metricsSlice);

        // CA-6 — objeto DORA para detectar excesos de umbral.
        const dora = _buildDoraForAlerts(kSlice, metricsSlice);

        // CA-6 — bandeja de alertas de umbral derivada por alertTraySlice
        // (read-only; NO escribe en alert-tray-audit). Le pasamos los KPIs ya
        // computados + thresholds por ctx para no releer el FS.
        const alertCtx = Object.assign({}, ctx || {}, {
            kpis: { sherlock, voice, deliverables: deliverablesBySkill, dora },
            thresholds,
        });
        const alertTray = _safe(() => slices.alertTraySlice(state || {}, alertCtx));

        return kpisView.renderKpis(Object.assign({}, opts || {}, {
            kpisSlice: kSlice,
            metricsSlice,
            deliverablesBySkill,
            matrixDerived: _deriveKpiCounts(state || {}, ctx),
            sysMini: _deriveSysMini(state || {}),
            routingMetrics: _computeRoutingMetricsSafe(),
            // #3961 EP8-H8
            sherlock,
            voice,
            thresholds,
            doraSpark,
            alertTray,
            // #4198 (Ola 7.1) — DORA normalizado (lead time / throughput / rebote)
            // para el banner de misión que diagnostica + badges de las cards DORA.
            dora,
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

// #3730 — Vista Issues extraída (split de #3715, Interpretación B: vista
// operacional cards). Require defensivo: si el módulo (o sus deps, ej.
// lib/escape-html.js) no carga, la ruta degrada al renderer legacy
// `sat.renderIssues` (fallback conservado en el MISMO commit como cinturón de
// runtime, R-4) en vez de tirar 500.
let issuesView = null;
try { issuesView = require('../views/dashboard/issues'); } catch { /* fallback a sat.renderIssues */ }

// Render de la ventana Issues con el snapshot del pipeline para SSR de cards.
// Consumido por el path legacy `/issues` (HTML_ROUTES) y por `?view=issues`
// (VIEW_SLUGS), ambos al MISMO thunk para que no diverjan (CA-A2). El cliente
// re-hidrata vía /api/dash/pipeline. Si el módulo nuevo no cargó o su render
// tira, degrada a `sat.renderIssues` (defensa en profundidad, R-4).
function renderIssuesView(ctx, opts) {
    if (!issuesView || typeof issuesView.renderIssuesHTML !== 'function') {
        return sat.renderIssues();
    }
    // El snapshot para el SSR de cards es best-effort: si pipelineSlice tira
    // (state parcial, dep faltante), el módulo nuevo igual renderiza su chrome
    // y el cliente hidrata vía /api/dash/pipeline. NO degradamos a la tabla
    // legacy sólo por falta de datos iniciales.
    let pSlice = null;
    try {
        const state = (ctx && typeof ctx.getState === 'function') ? ctx.getState() : {};
        pSlice = slices.pipelineSlice(state || {}, ctx || {});
    } catch { pSlice = null; }
    try {
        return issuesView.renderIssuesHTML(Object.assign({}, opts || {}, {
            matrix: pSlice ? pSlice.matrix : null,
            priorityOrder: pSlice ? pSlice.priorityOrder : [],
        }));
    } catch (e) {
        if (typeof issuesView.renderInert === 'function') {
            return issuesView.renderInert((e && e.message) || 'error de render');
        }
        return sat.renderIssues();
    }
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

// #3954 EP8-H1 — Store del audit de la bandeja de alertas (ack/snooze). Lectura
// defensiva: si el módulo no carga, los endpoints POST devuelven 503 y el slice
// degrada a `{error}` (el dashboard se ve idéntico al pre-feature).
let alertTrayAudit = null;
try { alertTrayAudit = require('./alert-tray-audit'); } catch { /* opcional */ }

// #3962 EP8-H9 — Presupuesto mensual persistido (endpoint mutante de Costos) +
// módulo de render del rediseño. Requires defensivos: si no cargan, el endpoint
// devuelve 503 y la vista cae al render legacy sin el bloque rediseñado.
let budgetConfig = null;
try { budgetConfig = require('../metrics/budget-config'); } catch { /* opcional */ }
let costosView = null;
try { costosView = require('../views/dashboard/costos'); } catch { /* opcional */ }
// Cota máxima del presupuesto (REQ-SEC A03). Reusa la del módulo si está, sino
// un default razonable.
const BUDGET_MAX = (budgetConfig && budgetConfig.BUDGET_MAX) || 1000000;

// #3962 EP8-H9 — Render de la pantalla Costos con el bloque rediseñado (gráfico
// área apilada + presupuesto + proyecciones + drill-down) inyectado ARRIBA del
// contenido legacy (cuota Plan Max + consumo). SSR: el slice se arma server-side
// para que el deep-link `/dashboard?view=costos` y `/costos` muestren el gráfico
// sin esperar JS. Aditivo (CA-7): si el módulo de render o el slice fallan, cae
// al render legacy intacto. Resuelve al MISMO thunk desde `/costos` (HTML_ROUTES)
// y `?view=costos` (VIEW_SLUGS) para que no diverjan (CA-A2).
function renderCostosView(ctx, opts) {
    let redesignHtml = '';
    if (costosView && typeof costosView.renderCostosRedesign === 'function') {
        try {
            const state = (ctx && typeof ctx.getState === 'function') ? ctx.getState() : {};
            const slice = slices.costosSlice(state || {}, ctx || {});
            redesignHtml = costosView.renderCostosRedesign(slice);
        } catch (e) {
            try { console.warn('[dashboard-routes] costos redesign unavailable: ' + (e && e.message)); } catch { /* noop */ }
            redesignHtml = '';
        }
    }
    return sat.renderCostos(Object.assign({}, opts || {}, { redesignHtml }));
}

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
    // #3729 — `/bloqueados` resuelve al módulo extraído (mismo thunk que
    // `?view=bloqueados`). Si el módulo no cargó, degrada a fallback inerte (CA-A3).
    '/bloqueados': (ctx) => renderBloqueadosView(ctx),
    // #3730 — `/issues` resuelve al módulo extraído (vista operacional cards)
    // con el snapshot del pipeline para SSR. Indirección por arrow: HTML_ROUTES
    // se evalúa una sola vez en module-load; sin la arrow agarraríamos `null`
    // si el require de issues.js fallara (R-4). Degrada a sat.renderIssues.
    '/issues': (ctx) => renderIssuesView(ctx),
    // #3731 — `/matriz` resuelve al módulo extraído (mismo thunk que
    // `?view=matriz`). Si el módulo no cargó, degrada a fallback inerte (CA-A3).
    '/matriz': () => renderMatrizView(),
    // #3732 — /ops ahora resuelve al módulo extraído views/dashboard/ops.js
    // con el state en vivo (opsSlice). Recibe ctx desde handle().
    '/ops': (ctx) => renderOpsView(ctx),
    // #3737 — /providers resuelve al módulo NUEVO views/dashboard/providers.js
    // (read-only, lee secrets.listKeys() por sí mismo; ignora ctx).
    '/providers': () => renderProvidersView(),
    // #3733 — /kpis resuelve al módulo extraído views/dashboard/kpis.js con el
    // state en vivo. Mismo thunk que `?view=kpis` (VIEW_SLUGS) para no divergir.
    '/kpis': (ctx) => renderKpisView(ctx),
    '/historial': sat.renderHistorial,
    // #3962 EP8-H9 — /costos resuelve al render con el bloque rediseñado SSR.
    '/costos': (ctx) => renderCostosView(ctx),
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
    // #3737 — Ventana Providers extraída (split del épico #3715). NUEVA, no
    // existía en el monolito. Read-only: el render no consume ctx (la vista lee
    // `secrets.listKeys()`). Resuelve al MISMO thunk que el path legacy
    // `/providers` (HTML_ROUTES) para no diverger (CA-PRV-3 + smoke CA-G2).
    providers: {
        title: 'Providers',
        render: () => renderProvidersView(),
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
    // #3729 — Ventana Bloqueados (slug `bloqueados`). Resuelve al MISMO thunk
    // que el path legacy `/bloqueados` (HTML_ROUTES) para que ambos no diverjan
    // (CA-A2). Recibe (opts, ctx) desde handle() para inyectar el state en vivo
    // (bloqueadosSlice). Degrada a panel inerte visible (CA-A3) si el módulo no
    // cargó. La compat retro `?section=needs-human` redirige acá (D9 narrativa UX).
    bloqueados: {
        title: 'Bloqueados',
        render: (opts, ctx) => renderBloqueadosView(ctx, opts),
    },
    // #3731 — Ventana Matriz (slug `matriz`). Resuelve al MISMO thunk que el
    // path legacy `/matriz` (HTML_ROUTES) para que ambos no diverjan (CA-A2).
    // Degrada a panel inerte visible (CA-A3) si el módulo no cargó. READ-ONLY:
    // no requiere ctx/state, hidrata client-side desde `/api/dash/pipeline`.
    matriz: {
        title: 'Matriz',
        render: () => renderMatrizView(),
    },
    // #3730 — Ventana Issues (slug `issues`). Resuelve al MISMO thunk que el
    // path legacy `/issues` (HTML_ROUTES) para que ambos no diverjan (CA-A2).
    // Recibe (opts, ctx) desde handle() para inyectar el snapshot del pipeline
    // (SSR de cards). Degrada a sat.renderIssues si el módulo no cargó (R-4).
    issues: {
        title: 'Issues',
        render: (opts, ctx) => renderIssuesView(ctx, opts),
    },
    // #3735 — Ventana Costos (split de #3715). Resuelve al MISMO renderer que
    // el path legacy `/costos` (HTML_ROUTES → sat.renderCostos) para que
    // `?view=costos` y `/costos` no diverjan (CA-A2). El banner/pill embebido en
    // home se extrajo a views/dashboard/costos.js; esta entry habilita el
    // deep-link `/dashboard?view=costos` (CA-1.2).
    costos: {
        title: 'Costos',
        // #3962 EP8-H9 — render con el bloque rediseñado SSR (mismo thunk que
        // el path legacy `/costos`). Recibe ctx desde handle() para armar el slice.
        render: (opts, ctx) => renderCostosView(ctx, opts),
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
    '/api/dash/pipeline': (state, ctx) => {
        const payload = slices.pipelineSlice(state, ctx);
        // #3959 (EP8-H6) CA-2 — persistir un snapshot horario de matrixCounts
        // para la serie temporal de la tendencia por celda (debounceado a
        // ~1/hora dentro del lib). Best-effort: no romper el endpoint si falla
        // (mismo patrón que /api/dash/reconciler-stale-orders).
        if (matrixHistory && ctx && ctx.PIPELINE && payload && payload.matrixCounts) {
            try { matrixHistory.recordSnapshot(payload.matrixCounts, { pipelineDir: ctx.PIPELINE }); }
            catch { /* no romper el endpoint por el snapshot */ }
        }
        return payload;
    },
    '/api/dash/bloqueados': (state) => slices.bloqueadosSlice(state),
    '/api/dash/ops': (state) => slices.opsSlice(state),
    '/api/dash/historial': (state) => slices.historialSlice(state),
    '/api/dash/quota': (state, ctx) => slices.quotaSlice(state, ctx),
    // #3962 EP8-H9 — hidrata la pantalla Costos rediseñada: serie diaria por
    // proveedor + presupuesto + estado de anomalía + proyecciones (con método)
    // + drill-down REDACTADO. Hereda el gate loopback CA-S2 + Sec-Fetch-Site del
    // dispatch de API_ROUTES.
    '/api/dash/costos': (state, ctx) => slices.costosSlice(state, ctx),
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
    '/api/dash/reconciler-stale-orders': (state, ctx) => {
        const payload = slices.reconcilerStaleOrdersSlice(state, ctx);
        // EP8-H7 (#3960) CA-4 — persistir un snapshot del breakdown para la
        // serie temporal (debounceado a ~1/hora dentro del lib). Best-effort.
        if (opsReconcilerHistory && ctx && ctx.PIPELINE) {
            try { opsReconcilerHistory.recordSnapshot({ total: payload.total_24h, by_reason: payload.by_reason }, { pipelineDir: ctx.PIPELINE }); }
            catch { /* no romper el endpoint por el snapshot */ }
        }
        return payload;
    },
    '/api/diagnostico/reconciler-stale-orders': (state, ctx) => slices.reconcilerStaleOrdersSlice(state, ctx),
    // EP8-H7 (#3960) CA-1 — historial de transiciones vivo↔muerto por servicio
    // con agregación por motivo en ventana 7d. `?service=<svc>` filtra; sin
    // param devuelve todos. El `lastError` ya viene redactado del store
    // (REQ-SEC-H7-1). Degrada a payload vacío si el lib no cargó.
    '/api/dash/ops-transitions': (state, ctx, query) => {
        if (!opsTransitions) return { service: null, downCount: 0, byReason: {}, summary: 'caídas 7 d: 0', lastError: '', transitions: [] };
        const service = query && typeof query.get === 'function' ? (query.get('service') || null) : null;
        const pipelineDir = (ctx && ctx.PIPELINE) || undefined;
        try { return opsTransitions.readTransitions(service, { pipelineDir }); }
        catch { return { service, downCount: 0, byReason: {}, summary: 'caídas 7 d: 0', lastError: '', transitions: [] }; }
    },
    // EP8-H7 (#3960) CA-4 — serie temporal 7d del reconciler (sparkline). Lee
    // del store persistido por el endpoint reconciler-stale-orders.
    '/api/dash/reconciler-history': (state, ctx) => {
        if (!opsReconcilerHistory) return { points: [], totals: [], windowDays: 7 };
        const pipelineDir = (ctx && ctx.PIPELINE) || undefined;
        try { return opsReconcilerHistory.readSeries({ pipelineDir }); }
        catch { return { points: [], totals: [], windowDays: 7 }; }
    },
    // #2993 — widget de handoff cross-agente. CA-C2: % hit rate, ahorro USD
    // estimado mensual, sparkline 7d. Refresh natural cada 30s desde el
    // cliente (el endpoint es stateless). Bajo `/api/dash/*` para seguir la
    // convención del kiosk vertical y `/api/handoff-metrics` como alias
    // documentado en CA-C2 (nombre humano-friendly para curl/debug).
    '/api/dash/handoff-metrics': (state, ctx) => slices.handoffMetricsSlice(state, ctx),
    '/api/handoff-metrics': (state, ctx) => slices.handoffMetricsSlice(state, ctx),
    // #3932 EP3-H6 — KPI "Entregables por skill" (% de cierres de fase con
    // entregable notificado, por skill). Sólo agregados numéricos (CA-5: el
    // payload NO contiene preview/content_hash/dropfile/attachment_path).
    // Refresh natural ~30s desde el cliente; cache 5min server-side en el lib.
    '/api/dash/deliverables-by-skill': (state, ctx) => slices.deliverablesBySkillSlice(state, ctx),
    // #3625 CA-5 — widget de audit trail de mutaciones a la allowlist
    // (partial-pause). Devuelve las últimas N entries del audit log, stats
    // de 24h y estado del hash-chain. Refresh natural 30s desde el cliente.
    '/api/dash/partial-pause-audit': (state, ctx) => slices.partialPauseAuditSlice(state, ctx),
    '/api/partial-pause-audit': (state, ctx) => slices.partialPauseAuditSlice(state, ctx),
    // #3954 EP8-H1 CA-5 — Bandeja de alertas del Home mission-control. Lectura
    // del audit trail (ack/snooze): últimas N entries, stats 24h, estado del
    // hash-chain y supresiones vigentes. Refresh natural 30s desde el cliente.
    // Hereda gate loopback CA-S2 + Sec-Fetch-Site + no-store del partial
    // (registrado dentro de API_ROUTES). Alias humano para curl/debug.
    '/api/dash/alert-tray': (state, ctx) => slices.alertTraySlice(state, ctx),
    '/api/alert-tray': (state, ctx) => slices.alertTraySlice(state, ctx),
    // #3897 CA-4 — métrica de precisión de Sherlock (épico #3894). SEC-6: el
    // slice devuelve SOLO agregados numéricos/booleanos (ratio, contadores,
    // not_verifiable count) — nunca claims/comandos/stdout del audit JSONL.
    // Registrado DENTRO de API_ROUTES (no handler propio) para heredar el
    // gate loopback CA-S2 + Sec-Fetch-Site CA-S3 + no-store/nosniff CA-S5
    // del endpoint partial (A01). Alias humano para curl/debug, mismo patrón
    // que `/api/handoff-metrics`.
    '/api/dash/sherlock-precision': (state, ctx) => slices.sherlockPrecisionSlice(state, ctx),
    '/api/sherlock-precision': (state, ctx) => slices.sherlockPrecisionSlice(state, ctx),
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
    // #3963 EP8 — Historial como timeline agrupado por día, paginado y filtrado
    // server-side. Parsea el querystring (skill / resultado / issue / q / period
    // / cursor / limit) y delega el cómputo a `historialTimelineSlice`. NUNCA
    // devuelve el historial completo: el slice acota el límite máximo por request
    // (HIST_PAGE_MAX) y la búsqueda es match literal (no RegExp → ReDoS-safe).
    // Hereda Cache-Control: no-store de sendJson() como el resto de /api/dash/*.
    '/api/dash/historial': (state, ctx, query) => {
        const q = query || new URLSearchParams();
        // Colector de entregables best-effort (CA-2). Issue-scoped, repo-root
        // como base. Si el módulo no carga o falla, degrada a [] (CA-3).
        const repoRoot = (ctx && ctx.ROOT) ? ctx.ROOT : process.cwd();
        let collectAttachments = null;
        try {
            const deliverables = require('./skill-deliverable-attachments');
            collectAttachments = (skill, issue, fase) => {
                try { return deliverables.collectAttachmentsForSkill(skill, issue, fase, { pipelineRoot: repoRoot }); }
                catch { return []; }
            };
        } catch { collectAttachments = null; }
        return slices.historialTimelineSlice(state, ctx, {
            skill: q.get('skill') || null,
            resultado: q.get('resultado') || null,
            issue: q.get('issue') || null,
            q: q.get('q') || null,
            period: q.get('period') || 'all',
            cursor: q.get('cursor'),
            limit: q.get('limit'),
            collectAttachments,
        });
    },
    '/api/historial': (state, ctx, query) => API_ROUTES['/api/dash/historial'](state, ctx, query),
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

// #3954 EP8-H1 CA-12 — Headers fijos de las respuestas de los endpoints
// mutantes (ack/snooze): no-store evita cache de un POST, nosniff evita
// reinterpretación MIME, no-referrer no filtra a terceros. Mismo criterio que
// `sendPartialHtml`.
function sendMutationJson(res, payload, status = 200) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

// #3954 REQ-SEC-8 — Lectura de body con cap de bytes. ack/snooze son payloads
// minúsculos; cualquier cosa por encima de 4KB se rechaza (413) y la conexión
// se corta (`req.destroy()`) para no mantener un socket abierto leyendo basura
// (defensa DoS).
const ALERT_BODY_MAX_BYTES = 4096;
function readBodyCapped(req, cap, onDone) {
    let size = 0;
    const chunks = [];
    let finished = false;
    const finish = (err, body) => { if (finished) return; finished = true; onDone(err, body); };
    req.on('data', (chunk) => {
        size += chunk.length;
        if (size > cap) {
            finish(new Error('body_too_large'));
            try { req.destroy(); } catch { /* noop */ }
            return;
        }
        chunks.push(chunk);
    });
    req.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (e) => finish(e));
}

// #3954 EP8-H1 CA-12 — Endpoints mutantes (PRIMEROS POST del dashboard).
// Replica LITERALMENTE el cinturón de gates de `/dashboard/partial`, en orden:
//   método incorrecto → 405
//   no-loopback       → 403 (gatea aun si DASHBOARD_HOST cambia el bind — REQ-SEC-7)
//   cross-site        → 403 (anti-CSRF — REQ-SEC-1)
//   Content-Type inválido → 415
//   body sobre el cap → 413 (REQ-SEC-8)
//   snooze fuera de allowlist / alertId inválido → 400 (validado server-side)
// El actor se graba server-side fijo (`operador-local`), NUNCA del body (REQ-SEC-3).
// Devuelve true si la ruta es una de las mutantes (la maneja, con respuesta
// sync o async); false si no le corresponde (sigue el resto del router).
function handleAlertMutation(req, res) {
    const pathnameOnly = (req.url || '').split('?')[0];
    const isAck = pathnameOnly === '/dashboard/alert/ack';
    const isSnooze = pathnameOnly === '/dashboard/alert/snooze';
    if (!isAck && !isSnooze) return false;

    // Gate 1 — método.
    if (req.method !== 'POST') {
        _logPartialRejected(req, 'alert_method_not_allowed');
        sendMutationJson(res, { error: 'method_not_allowed' }, 405);
        return true;
    }
    // Gate 2 — loopback (REQ-SEC-1/7, independiente del bind).
    if (!isLoopbackReq(req)) {
        _logPartialRejected(req, 'alert_non_loopback');
        sendMutationJson(res, { error: 'forbidden' }, 403);
        return true;
    }
    // Gate 3 — same-origin (anti-CSRF, REQ-SEC-1).
    if (!isSameOriginFetch(req)) {
        _logPartialRejected(req, 'alert_cross_origin');
        sendMutationJson(res, { error: 'forbidden' }, 403);
        return true;
    }
    // Gate 4 — Content-Type debe ser JSON.
    const ct = (req.headers && req.headers['content-type']) || '';
    if (!/^application\/json\b/i.test(ct)) {
        _logPartialRejected(req, 'alert_bad_content_type');
        sendMutationJson(res, { error: 'unsupported_media_type' }, 415);
        return true;
    }
    // Módulo de store disponible.
    if (!alertTrayAudit) {
        sendMutationJson(res, { error: 'module_unavailable' }, 503);
        return true;
    }

    // Gate 5 — body con cap (REQ-SEC-8) + parseo + acción.
    readBodyCapped(req, ALERT_BODY_MAX_BYTES, (err, raw) => {
        if (err) {
            const tooLarge = err.message === 'body_too_large';
            _logPartialRejected(req, tooLarge ? 'alert_body_too_large' : 'alert_body_read_error');
            sendMutationJson(res, { error: tooLarge ? 'payload_too_large' : 'bad_request' }, tooLarge ? 413 : 400);
            return;
        }
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = null; }
        if (!parsed || typeof parsed !== 'object') {
            sendMutationJson(res, { error: 'bad_request' }, 400);
            return;
        }
        // NUNCA leemos `actor` del body (REQ-SEC-3): lo graba el store fijo.
        const alertId = parsed.alertId != null ? parsed.alertId : parsed.alert_id;
        const justification = typeof parsed.justification === 'string' ? parsed.justification : undefined;
        try {
            let result;
            if (isSnooze) {
                const hours = parsed.hours != null ? parsed.hours : parsed.snoozeHours;
                result = alertTrayAudit.recordSnooze({ alertId, snoozeHours: hours, justification });
            } else {
                result = alertTrayAudit.recordAck({ alertId, justification });
            }
            if (!result.applied) {
                // Validación server-side falló (alertId fuera de allowlist o
                // snooze fuera de 1/4/24h). Body genérico — no reflejamos input.
                sendMutationJson(res, { error: 'bad_request', applied: false }, 400);
                return;
            }
            sendMutationJson(res, { ok: true, applied: true, actor: alertTrayAudit.FIXED_ACTOR }, 200);
        } catch (e) {
            try { console.error(JSON.stringify({ event: 'alert_mutation_error', msg: e && e.message, ts: new Date().toISOString() })); } catch {}
            sendMutationJson(res, { error: 'internal_error' }, 500);
        }
    });
    return true;
}

// #3962 EP8-H9 CA-4 — Endpoint mutante del presupuesto mensual. Replica
// LITERALMENTE el cinturón de gates de `handleAlertMutation`, en el MISMO orden:
//   método≠POST → 405
//   no-loopback → 403 (REQ-SEC-1/7, independiente del bind)
//   cross-site  → 403 (anti-CSRF, REQ-SEC-1)
//   Content-Type≠json → 415
//   body sobre cap → 413 (REQ-SEC-8)
//   valor inválido (no-number / NaN / Infinity / ≤0 / > cota / notación
//     científica / string) → 400 SIN reflejar el input (REQ-SEC A03)
// El actor se graba server-side FIJO (`operador-local`), NUNCA del body
// (REQ-SEC-3). Persistencia atómica tmp+rename (en budget-config.writeBudget).
function handleBudgetMutation(req, res) {
    const pathnameOnly = (req.url || '').split('?')[0];
    if (pathnameOnly !== '/dashboard/costos/budget') return false;

    // Gate 1 — método.
    if (req.method !== 'POST') {
        _logPartialRejected(req, 'budget_method_not_allowed');
        sendMutationJson(res, { error: 'method_not_allowed' }, 405);
        return true;
    }
    // Gate 2 — loopback (REQ-SEC-1/7, independiente del bind).
    if (!isLoopbackReq(req)) {
        _logPartialRejected(req, 'budget_non_loopback');
        sendMutationJson(res, { error: 'forbidden' }, 403);
        return true;
    }
    // Gate 3 — same-origin (anti-CSRF, REQ-SEC-1).
    if (!isSameOriginFetch(req)) {
        _logPartialRejected(req, 'budget_cross_origin');
        sendMutationJson(res, { error: 'forbidden' }, 403);
        return true;
    }
    // Gate 4 — Content-Type debe ser JSON.
    const ct = (req.headers && req.headers['content-type']) || '';
    if (!/^application\/json\b/i.test(ct)) {
        _logPartialRejected(req, 'budget_bad_content_type');
        sendMutationJson(res, { error: 'unsupported_media_type' }, 415);
        return true;
    }
    // Módulo de persistencia disponible.
    if (!budgetConfig) {
        sendMutationJson(res, { error: 'module_unavailable' }, 503);
        return true;
    }

    // Gate 5 — body con cap (REQ-SEC-8) + parseo + validación estricta del valor.
    readBodyCapped(req, ALERT_BODY_MAX_BYTES, (err, raw) => {
        if (err) {
            const tooLarge = err.message === 'body_too_large';
            _logPartialRejected(req, tooLarge ? 'budget_body_too_large' : 'budget_body_read_error');
            sendMutationJson(res, { error: tooLarge ? 'payload_too_large' : 'bad_request' }, tooLarge ? 413 : 400);
            return;
        }
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = null; }
        if (!parsed || typeof parsed !== 'object') {
            sendMutationJson(res, { error: 'bad_request' }, 400);
            return;
        }
        // Validación server-side ESTRICTA (REQ-SEC A03):
        const value = parsed.monthlyUsd;
        const n = Number(value);
        const rawStr = String(value);
        const valid = typeof value === 'number'        // rechaza strings ("100")
            && Number.isFinite(n)                       // rechaza NaN / Infinity
            && n > 0                                     // rechaza ≤ 0
            && n <= BUDGET_MAX                           // rechaza por encima de la cota
            && !/[eE]/.test(rawStr);                     // rechaza notación científica (1e3)
        if (!valid) {
            // Body genérico — NO reflejamos el input crudo.
            sendMutationJson(res, { error: 'bad_request', applied: false }, 400);
            return;
        }
        try {
            budgetConfig.writeBudget(n, { actor: 'operador-local' }); // actor FIJO, atómico tmp+rename
            sendMutationJson(res, { ok: true, applied: true, actor: 'operador-local' }, 200);
        } catch (e) {
            try { console.error(JSON.stringify({ event: 'budget_mutation_error', msg: e && e.message, ts: new Date().toISOString() })); } catch {}
            sendMutationJson(res, { error: 'internal_error' }, 500);
        }
    });
    return true;
}

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

    // #3954 EP8-H1 — Endpoints mutantes (ack/snooze). Se evalúan ANTES del
    // gate GET-only: son las ÚNICAS rutas de escritura habilitadas. Cada una
    // pasa su propio cinturón de gates (loopback + same-origin + Content-Type
    // + cap de body). El resto del dashboard sigue siendo read-only.
    if (handleAlertMutation(req, res)) return true;
    // #3962 EP8-H9 CA-4 — endpoint mutante del presupuesto mensual. Mismo lugar
    // que ack/snooze: ANTES del gate GET-only, con su propio cinturón de gates.
    if (handleBudgetMutation(req, res)) return true;

    if (req.method !== 'GET') return false;

    // #3729 (D9 narrativa UX) — compat retro del popout legacy. El link viejo
    // `/?section=needs-human` (y `/legacy?section=...`) redirige server-side a
    // `/dashboard?view=bloqueados` para no romper marcadores guardados por el
    // operador. 302 (temporal) — el slug nuevo es el canónico.
    {
        const qIdx = url.indexOf('?');
        if (qIdx !== -1) {
            let sp;
            try { sp = new URL(url, 'http://x').searchParams; } catch { sp = new URLSearchParams(); }
            if (sp.get('section') === 'needs-human') {
                res.writeHead(302, { 'Location': '/dashboard?view=bloqueados', 'Cache-Control': 'no-store' });
                res.end();
                return true;
            }
        }
    }

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
        // #3954 — endpoints mutantes ack/snooze
        handleAlertMutation,
        ALERT_BODY_MAX_BYTES,
        // #3962 EP8-H9 — endpoint mutante del presupuesto mensual
        handleBudgetMutation,
        BUDGET_MAX,
        renderCostosView,
    },
};
