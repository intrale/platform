// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// process-audit / index — corrida del auditor del modelo operativo (#6809)
// =============================================================================
//
// `runAudit({ pipelineDir, cfgRoot, now, windowDays, minSamplesHora })` lee la
// telemetría de la ventana y evalúa los tres ejes:
//
//   - proceso      (H2) — pasos invariantes, fallos recurrentes, costo por
//                         fase, controles apagados; rebotes/reintentos de soporte.
//   - capacidad    (H3) — paralelismo contra recursos y causa de la ociosidad.
//   - proveedores  (H4) — cuota, schedule, cadena y plan.
//
// Devuelve `{ generado_at, ventana, ejes: { proceso, capacidad, proveedores },
// hallazgos }`. Cada eje corre en su propio try/catch: si uno falla queda
// `{ veredicto: 'error' }` y los otros siguen.
//
// 100 % determinístico (D1 / SEC-6809-1): sin LLM, sin red, sin `gh`. Este
// módulo NO escribe nada; la única escritura del auditor es el estado del cron
// (`cron.js`) y la publicación en el registro (`publish.js`).

const fs = require('fs');
const path = require('path');

const DAY_MS = 86400000;
const LOOKBACK_CUOTA_DIAS = 8;

function ymd(ms) { return new Date(ms).toISOString().slice(0, 10); }

function leerAgentModels(pipelineDir, fsImpl) {
    try {
        const parsed = JSON.parse(String(fsImpl.readFileSync(path.join(pipelineDir, 'agent-models.json'), 'utf8')));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function ejeSeguro(fn) {
    try {
        const r = fn();
        return (r && typeof r === 'object') ? r : { veredicto: 'error', hallazgos: [], detalle: {} };
    } catch (e) {
        return { veredicto: 'error', hallazgos: [], detalle: { error: (e && e.name) || 'Error' } };
    }
}

/**
 * @param {object} p
 * @param {string} p.pipelineDir
 * @param {object} p.cfgRoot
 * @param {number} [p.now]
 * @param {number} [p.windowDays=14]
 * @param {number} [p.minSamplesHora=60]
 * @param {object} [p.fsImpl]
 * @param {object} [p.deps]   inyección de lectores/ejes para tests
 */
function runAudit({ pipelineDir, cfgRoot, now = Date.now(), windowDays = 14, minSamplesHora = 60, fsImpl = fs, deps = {} } = {}) {
    const hasta = now;
    const desde = now - windowDays * DAY_MS;
    const ventana = `${windowDays}d hasta ${ymd(hasta)}`;
    const agentModels = deps.agentModels || leerAgentModels(pipelineDir, fsImpl);

    const rv = deps.readVerdicts || require('./read-verdicts');
    const rca = deps.readControlAge || require('./read-control-age');
    const rh = deps.readHourly || require('./read-hourly');
    const ql = deps.quotaLedger || require('../multi-provider/quota-ledger');
    const axProceso = deps.axisProcess || require('./axis-process');
    const axCapacidad = deps.axisCapacity || require('./axis-capacity');
    const axProveedores = deps.axisProviders || require('./axis-providers');

    const proceso = ejeSeguro(() => {
        const leer = { pipelineDir, from: desde, to: hasta, fsImpl };
        return axProceso.evaluarProceso({
            verdicts: rv.readProcesadoVerdicts(leer).rows,
            rebounds: rv.readRebounds(leer).rows,
            costRuns: rv.readCostRuns(leer).rows,
            failures: rv.readFailures(leer).rows,
            controls: rca.readControlAges({ pipelineDir, cfgRoot, now, fsImpl, execFileSync: deps.execFileSync }),
            agentModels,
            ventana,
        });
    });

    const capacidad = ejeSeguro(() => axCapacidad.evaluarCapacidad({
        horas: rh.readHourly({ pipelineDir, from: desde, to: hasta, fsImpl }).horas,
        cfgRoot,
        minSamplesHora,
        ventana,
    }));

    const proveedores = ejeSeguro(() => {
        const lookback = desde - LOOKBACK_CUOTA_DIAS * DAY_MS;
        return axProveedores.evaluarProveedores({
            cfgRoot,
            agentModels,
            samples: ql.readSamples({ pipelineDir, sinceMs: lookback }),
            detectorEvents: ql.readDetectorEvents({ pipelineDir, desde, hasta, lookbackDays: LOOKBACK_CUOTA_DIAS }),
            healthEvents: ql.readHealthEvents({ pipelineDir, desde, hasta, lookbackDays: LOOKBACK_CUOTA_DIAS }),
            scheduleEntries: ql.readScheduleEntries({ pipelineDir }),
            creditRedemptions: ql.readCreditRedemptions({ pipelineDir }),
            costRecords: ql.readCostRecords({ pipelineDir }),
            desde,
            hasta,
            ventana,
            isActiveAt: deps.isActiveAt,
        });
    });

    const ejes = { proceso, capacidad, proveedores };
    const hallazgos = [];
    for (const eje of Object.values(ejes)) {
        for (const h of Array.isArray(eje.hallazgos) ? eje.hallazgos : []) hallazgos.push(h);
    }
    return {
        generado_at: new Date(now).toISOString(),
        ventana: { desde: new Date(desde).toISOString(), hasta: new Date(hasta).toISOString(), dias: windowDays },
        ejes,
        hallazgos,
    };
}

module.exports = { runAudit };
