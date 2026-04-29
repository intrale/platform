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
//   GET /api/dash/kpis                {prsLast7d, tokens24h, cycleTimeMs, bouncePct}
//   GET /api/dash/active              {agents:[], totalRunning}
//   GET /api/dash/recent              {recent:[]}
//   GET /api/dash/queue               {queue:[]}
//   GET /api/dash/equipo              {skills:[]}
//   GET /api/dash/pipeline            {matrix, fases}
//   GET /api/dash/bloqueados          {bloqueados:[]}
//   GET /api/dash/ops                 {procesos, servicios, ...}
//   GET /api/dash/historial           {actividad:[]}

'use strict';

const path = require('path');
const slices = require('./dashboard-slices');
const home = require('../views/dashboard/home');
const sat = require('../views/dashboard/satellites');

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
};

const API_ROUTES = {
    '/api/dash/header': (state, ctx) => slices.headerSlice(state, ctx),
    '/api/dash/kpis': (state, ctx) => slices.kpisSlice(state, ctx),
    '/api/dash/active': (state) => {
        const agents = slices.activeAgents(state);
        return { agents, totalRunning: agents.length };
    },
    '/api/dash/recent': (state) => ({ recent: slices.recentlyFinished(state, 10) }),
    '/api/dash/queue': (state, ctx) => ({ queue: slices.nextInQueue(state, ctx, 10) }),
    '/api/dash/equipo': (state) => slices.equipoSlice(state),
    '/api/dash/pipeline': (state) => slices.pipelineSlice(state),
    '/api/dash/bloqueados': (state) => slices.bloqueadosSlice(state),
    '/api/dash/ops': (state) => slices.opsSlice(state),
    '/api/dash/historial': (state) => slices.historialSlice(state),
    '/api/dash/quota': (state, ctx) => slices.quotaSlice(state, ctx),
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
        sendHtml(res, home.renderHomeHTML());
        return true;
    }

    const apiPath = url.split('?')[0];
    if (API_ROUTES[apiPath]) {
        try {
            const state = ctx.getState();
            const payload = API_ROUTES[apiPath](state, ctx);
            sendJson(res, payload);
        } catch (e) {
            sendJson(res, { error: e.message || String(e) }, 500);
        }
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

module.exports = { handle };
