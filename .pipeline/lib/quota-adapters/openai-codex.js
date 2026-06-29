// =============================================================================
// quota-adapters/openai-codex.js — Adapter OpenAI/Codex (#4202 M2b).
//
// Estrategia (OFFLINE — security CA-#6):
//
//   * Codex opera por **presupuesto mensual**, no por ventana rolling de 5h
//     como Anthropic. Por eso solo poblamos el bucket SEMANAL del panel con
//     `costMensual / MAX_MONTHLY_BUDGET_USD * 100`; el bucket SESIÓN queda en
//     "sin dato" (no hay ventana de 5h que medir). Decisión de definición
//     validada por PO (#4202 CA-3).
//
//   * El consumo se computa SIEMPRE offline desde `metrics/snapshot.json`
//     (`dailyByProvider[]` → `{day, provider, cost_usd, sessions}`), generado
//     por `metrics/aggregator.js` a partir del activity-log. El adapter NUNCA
//     realiza pedidos de red a la API de OpenAI (evita SSRF / secrets en
//     runtime del dashboard — security CA-#6). El check de la receta (grep de
//     clientes HTTP sobre los adapters) debe seguir en cero matches.
//
//   * Sin datos de Codex (snapshot ausente, sin entradas del proveedor en el
//     mes corriente) → `not_implemented`/`no_quota` con `pct: null`, NUNCA
//     `pct: 0` ("luz verde silenciosa" — security CA-#3 + UX G1).
//
// Hard cap del budget (security CA-#2/req#3):
//
//   * `MAX_MONTHLY_BUDGET_USD` hardcoded en 1000 — es el denominador del % y
//     el techo del budget configurable. Subirlo a un valor enorme desactiva
//     la detección de cuota agotada (gasto descontrolado). Cualquier cambio
//     requiere revisión humana.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { ADAPTER_STATUS, QUOTA_STATUS, emptyResult } = require('./_shape');

// Hard cap del budget mensual (security CA-#2/req#3). Es el denominador del
// porcentaje semanal y el techo del budget configurable. Cambiar este valor
// requiere revisión humana — un PR que lo suba a $999_999 desactiva la
// detección de cuota agotada y permite gasto descontrolado.
const MAX_MONTHLY_BUDGET_USD = 1000;

/**
 * Mapea un porcentaje de cuota al enum `status` (mismos cortes que el resto
 * del pipeline: ok <50, normal <75, warning <90, critical >=90).
 * @param {number} pct
 * @returns {string}
 */
function statusFromPct(pct) {
    if (pct >= 90) return QUOTA_STATUS.CRITICAL;
    if (pct >= 75) return QUOTA_STATUS.WARNING;
    if (pct >= 50) return QUOTA_STATUS.NORMAL;
    return QUOTA_STATUS.OK;
}

/**
 * Lee `dailyByProvider` del snapshot de métricas de forma defensiva. NO lanza:
 * cualquier error (archivo ausente, JSON corrupto, shape inesperado) devuelve
 * `null` para que el caller degrade a "sin dato".
 *
 * @param {string} metricsDir
 * @returns {Array<Object>|null}
 */
function readDailyByProvider(metricsDir) {
    if (typeof metricsDir !== 'string' || metricsDir.length === 0) return null;
    let raw;
    try {
        // Cap de lectura defensivo: el snapshot no debería superar unos pocos
        // MB; si está corrupto/inflado, no queremos volar la memoria.
        const snapPath = path.join(metricsDir, 'snapshot.json');
        raw = fs.readFileSync(snapPath, 'utf8');
    } catch {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.dailyByProvider)) {
        return null;
    }
    return parsed.dailyByProvider;
}

/**
 * Adapter OpenAI/Codex. Computa el % del presupuesto mensual consumido
 * (bucket semanal) leyendo `snapshot.json` offline. El bucket de sesión queda
 * en "sin dato" (Codex no tiene ventana de 5h).
 *
 * @param {Object} sessionData
 *   @property {string} metricsDir   path a .pipeline/metrics
 *   @property {number} [budgetUsd]  budget mensual configurado (<= cap)
 *   @property {number} [now]        epoch ms para determinar el mes corriente (test)
 * @returns {QuotaResult}
 */
function openaiCodexAdapter(sessionData) {
    // Defensa del cap del budget (security CA-#2). Si llega un budget inválido
    // o que excede el cap, devolvemos `error` para alertar al operador.
    const budget = sessionData && sessionData.budgetUsd;
    if (budget != null) {
        if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) {
            return emptyResult('openai-codex', ADAPTER_STATUS.ERROR,
                'Cuota OpenAI: budgetUsd debe ser número finito >= 0');
        }
        if (budget > MAX_MONTHLY_BUDGET_USD) {
            return emptyResult('openai-codex', ADAPTER_STATUS.ERROR,
                `Cuota OpenAI: budget USD (${budget}) excede el cap hardcoded (${MAX_MONTHLY_BUDGET_USD}) — revisar config`);
        }
    }

    const metricsDir = sessionData && sessionData.metricsDir;
    const daily = readDailyByProvider(metricsDir);
    if (!daily) {
        // Sin snapshot disponible → "sin dato" explícito (NO 0%).
        return emptyResult('openai-codex', ADAPTER_STATUS.NOT_IMPLEMENTED,
            'Cuota OpenAI/Codex: sin snapshot de métricas disponible (metrics/snapshot.json)');
    }

    // Mes corriente en formato `YYYY-MM` para filtrar `dailyByProvider`. Usamos
    // `sessionData.now` cuando viene (tests deterministas), sino el reloj real.
    const nowMs = (sessionData && Number.isFinite(sessionData.now)) ? sessionData.now : Date.now();
    const d = new Date(nowMs);
    const monthPrefix = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

    let costMonth = 0;
    let matched = 0;
    for (const entry of daily) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.provider !== 'openai-codex') continue;
        if (typeof entry.day !== 'string' || entry.day.slice(0, 7) !== monthPrefix) continue;
        const cost = Number(entry.cost_usd);
        if (Number.isFinite(cost) && cost >= 0) {
            costMonth += cost;
            matched += 1;
        }
    }

    if (matched === 0) {
        // No hay consumo de Codex registrado en el mes → "sin dato" (NO 0%).
        // Distinguimos de "0% real": no sabemos si Codex no se usó o si el
        // snapshot no capturó sus sesiones (security CA-#3).
        return emptyResult('openai-codex', ADAPTER_STATUS.NO_QUOTA,
            'Cuota OpenAI/Codex: sin consumo registrado este mes');
    }

    // pct semanal = costo mensual / cap mensual * 100 (CA-3). Capeamos a 100
    // para la barra; guardamos el raw para debug de saturación.
    const denom = MAX_MONTHLY_BUDGET_USD;
    const pctRaw = (costMonth / denom) * 100;
    const pct = Math.min(100, Math.max(0, pctRaw));
    const capped = pctRaw > 100;
    const status = statusFromPct(pct);

    const result = emptyResult('openai-codex', ADAPTER_STATUS.OK, null);
    // Bucket SEMANAL (el panel lee `realPct ?? pct` para weekly).
    result.pct = Math.round(pct * 10) / 10;
    result.realPct = null; // Codex no se calibra contra dato externo; el pct ya es real.
    result.realPctRaw = Math.round(pctRaw * 10) / 10;
    result.realPctCapped = capped;
    result.status = status;
    result.realStatus = status;
    // Bucket SESIÓN: queda en "sin dato" (session.pct === null de emptyResult)
    // — Codex opera por presupuesto mensual, no hay ventana de 5h.
    return result;
}

// Exportar el cap para que tests + consumidores lo verifiquen.
openaiCodexAdapter.MAX_MONTHLY_BUDGET_USD = MAX_MONTHLY_BUDGET_USD;

module.exports = openaiCodexAdapter;
