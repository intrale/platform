'use strict';

// =============================================================================
// operator-wait.js — Métrica de espera de operador + balde de lead time (#4588)
// (épico #4570 · diseño docs/pipeline/gates-firma-operador.md).
//
// QUÉ RESUELVE
// ------------
// Con los gates de firma (#4574 GATE 1 / #4575 GATE 2) aparece un tiempo nuevo
// que las métricas de ola no modelaban: la **espera por la firma del operador**.
// Si una ola se frena horas/días esperando firmas, el ETA debe reflejarlo y hay
// que medirlo como métrica de primera clase, atribuida (no diluida en "pipeline
// lento").
//
// Descompone el lead time de cada issue en un balde nuevo — `waitOperatorMin` —
// separado del tiempo de agente activo y del tiempo en cola, derivado de los
// timestamps de transición del estado `waiting-operator`.
//
// FUENTE DE VERDAD (requisito A04 de security/guru — no gameable)
// ---------------------------------------------------------------
// Los timestamps NO se derivan de un `mtime` mutable que un agente pueda
// backdatear. Se derivan de dos audit logs **append-only hash-chained**:
//   - ENTRADA a `waiting-operator`: `.pipeline/audit/gate-verdicts.jsonl`
//     (evento `transition`, `to: 'waiting-operator'`, escrito por el pulpo GATE 0
//     — pulpo.js:5024). Trae `issue`, `created_at`, `actor: 'pulpo:gate0:<fase>'`.
//   - SALIDA de `waiting-operator`: `.pipeline/audit/operator-gate-signatures.jsonl`
//     (firma del operador, `result` != 'accepted-before-transition', `gate` !=
//     null — operator-gate.js:auditSignature). Trae `issue`, `created_at`, `gate`.
//
// Un intervalo cerrado = [entrada, salida]. Un issue todavía en el gate tiene un
// intervalo ABIERTO = [entrada, now] (se muestra como espera en curso).
//
// CLASE DE GATE (agregación CA-4)
// -------------------------------
// La `fase` de la transición de entrada mapea a la taxonomía del diseño:
//   - fase `criterios`  → GATE 1 (Firma de Definición)
//   - fase `aprobacion` → GATE 2 (Firma de Aceptación)
//   - otra              → GATE 0 (veredicto honesto transversal)
//
// SEGURIDAD / ROBUSTEZ
// --------------------
//   - Read-only sobre el FS (mismo contrato que `eta-wave.js`): cero writes.
//   - Parseo defensivo línea-a-línea: una línea corrupta se descarta, no rompe.
//   - Timestamps validados como finitos; intervalos negativos / fechas futuras /
//     NaN se descartan (no restan, no explotan el ETA — anti-DoS del cálculo).
//   - La proyección pública expone SÓLO números y labels de gate fijos: nunca
//     paths, nombres de archivo de estado ni tokens (CA-10 del dashboard).
//   - `issue` forzado a entero > 0 antes de usarse como clave.
// =============================================================================

const fs = require('fs');
const path = require('path');

const trace = require('./traceability');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');

// Labels de clase de gate — CONGELADOS y seguros para render (sin datos crudos).
const GATE_CLASS = Object.freeze({
    GATE1: 'GATE 1',
    GATE2: 'GATE 2',
    GATE0: 'GATE 0',
});

const WAITING_STATE = 'waiting-operator';

// Marcador del audit de firma que NO cierra el intervalo (el operador-gate
// audita dos veces por firma: 'accepted-before-transition' primero y luego el
// resultado real de la transición). Sólo el segundo cierra la espera.
const PRE_TRANSITION_RESULT = 'accepted-before-transition';

function auditDir(pipelineDir) {
    return path.join(pipelineDir, 'audit');
}

/**
 * Mapea la `fase` de la transición de entrada a la clase de gate (CA-4).
 * Conservador: cualquier fase desconocida cae a GATE 0 (transversal).
 */
function gateClassForFase(fase) {
    if (fase === 'criterios') return GATE_CLASS.GATE1;
    if (fase === 'aprobacion') return GATE_CLASS.GATE2;
    return GATE_CLASS.GATE0;
}

/**
 * Extrae la `fase` del actor `pulpo:gate0:<fase>` (pulpo.js:4852). Devuelve
 * null si el formato no matchea (no confiamos en el string crudo para nada más
 * que el mapeo de gate).
 */
function faseFromActor(actor) {
    if (typeof actor !== 'string') return null;
    const m = /^pulpo:gate0:([a-z]+)$/.exec(actor);
    return m ? m[1] : null;
}

/** Parsea un timestamp (ISO string o epoch ms) a ms finito, o null. */
function parseTs(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0 ? value : null;
    }
    if (typeof value === 'string') {
        const t = Date.parse(value);
        return Number.isFinite(t) && t > 0 ? t : null;
    }
    return null;
}

/** Fuerza un issue a entero > 0, o null. Anti-inyección de clave. */
function normalizeIssue(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
}

/**
 * Lee un audit .jsonl append-only de forma DEFENSIVA: línea por línea, saltando
 * las corruptas. No usa `audit-log.readAll` (que hace `JSON.parse` sin try/catch
 * y aborta ante una línea rota) porque la robustez ante state corrupto es un CA.
 * Read-only: nunca escribe.
 */
function readJsonlSafe(file, fsImpl) {
    const _fs = fsImpl || fs;
    let content;
    try {
        if (!_fs.existsSync(file)) return [];
        content = _fs.readFileSync(file, 'utf8');
    } catch {
        return [];
    }
    const out = [];
    for (const line of String(content).split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
            const obj = JSON.parse(t);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) out.push(obj);
        } catch {
            /* línea corrupta: se descarta, no rompe la métrica */
        }
    }
    return out;
}

/**
 * Reconstruye los intervalos de espera de operador por issue a partir de los dos
 * audit logs. Emparejamiento por orden temporal: cada ENTRADA (transición a
 * `waiting-operator`) abre un intervalo; la primera SALIDA (firma con resultado
 * de transición) posterior lo cierra. Una entrada sin salida queda ABIERTA.
 *
 * @param {object} opts
 * @param {string} [opts.pipelineDir]
 * @param {object} [opts.fsImpl]
 * @param {function} [opts.now] — clock inyectable (ms).
 * @returns {{intervals: Array, byIssue: Map<number, object>}}
 *   intervals: [{ issue, gateClass, startMs, endMs|null, open:boolean, waitMin }]
 */
function collectOperatorWaitIntervals(opts = {}) {
    const pipelineDir = opts.pipelineDir || PIPELINE_DIR;
    const _fs = opts.fsImpl || fs;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const nowMs = (() => { const t = Number(now()); return Number.isFinite(t) && t > 0 ? t : Date.now(); })();

    const dir = auditDir(pipelineDir);
    const verdicts = readJsonlSafe(path.join(dir, 'gate-verdicts.jsonl'), _fs);
    const signatures = readJsonlSafe(path.join(dir, 'operator-gate-signatures.jsonl'), _fs);

    // Entradas: evento transition con to === 'waiting-operator'.
    const entriesByIssue = new Map();  // issue → [{ startMs, gateClass }]
    for (const r of verdicts) {
        if (!r || r.event !== 'transition' || r.to !== WAITING_STATE) continue;
        const issue = normalizeIssue(r.issue);
        const startMs = parseTs(r.created_at || r.ts);
        if (issue === null || startMs === null) continue;
        const gateClass = gateClassForFase(faseFromActor(r.actor));
        if (!entriesByIssue.has(issue)) entriesByIssue.set(issue, []);
        entriesByIssue.get(issue).push({ startMs, gateClass });
    }

    // Salidas: firma con resultado de transición real (no el pre-transition), lo
    // que marca que el operador cerró el gate.
    const exitsByIssue = new Map();  // issue → [endMs]
    for (const r of signatures) {
        if (!r) continue;
        if (r.result === PRE_TRANSITION_RESULT) continue;   // no cierra
        if (r.gate === null || r.gate === undefined) continue; // el 2º audit trae gate
        const issue = normalizeIssue(r.issue);
        const endMs = parseTs(r.created_at || r.ts);
        if (issue === null || endMs === null) continue;
        if (!exitsByIssue.has(issue)) exitsByIssue.set(issue, []);
        exitsByIssue.get(issue).push(endMs);
    }

    const intervals = [];
    const byIssue = new Map();

    for (const [issue, entries] of entriesByIssue.entries()) {
        // Orden temporal estable para emparejar FIFO entrada↔salida.
        const sortedEntries = entries.slice().sort((a, b) => a.startMs - b.startMs);
        const exits = (exitsByIssue.get(issue) || []).slice().sort((a, b) => a - b);
        let exitIdx = 0;

        for (const entry of sortedEntries) {
            // Buscar la primera salida posterior (o igual) a la entrada aún no usada.
            let endMs = null;
            while (exitIdx < exits.length && exits[exitIdx] < entry.startMs) exitIdx++;
            if (exitIdx < exits.length) {
                endMs = exits[exitIdx];
                exitIdx++;
            }
            const open = endMs === null;
            const rawEnd = open ? nowMs : endMs;
            // Robustez: intervalos negativos / no finitos se descartan (waitMin = 0
            // y no cuentan como muestra). Fecha futura de entrada ⇒ delta ≤ 0.
            let waitMin = 0;
            if (Number.isFinite(rawEnd) && rawEnd >= entry.startMs) {
                waitMin = (rawEnd - entry.startMs) / 60000;
            }
            const iv = {
                issue,
                gateClass: entry.gateClass,
                startMs: entry.startMs,
                endMs: open ? null : endMs,
                open,
                waitMin,
            };
            intervals.push(iv);

            if (!byIssue.has(issue)) {
                byIssue.set(issue, { issue, waitOperatorMin: 0, openWaitMin: 0, byGate: {}, intervals: 0, openIntervals: 0 });
            }
            const agg = byIssue.get(issue);
            agg.waitOperatorMin += waitMin;
            agg.intervals += 1;
            if (open) { agg.openIntervals += 1; agg.openWaitMin += waitMin; }
            agg.byGate[iv.gateClass] = (agg.byGate[iv.gateClass] || 0) + waitMin;
        }
    }

    return { intervals, byIssue };
}

/** Percentil lineal sobre un array ASC (mismo criterio que eta-wave.js). */
function percentile(sortedAsc, p) {
    if (!sortedAsc.length) return 0;
    if (sortedAsc.length === 1) return sortedAsc[0];
    const idx = (p / 100) * (sortedAsc.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sortedAsc[lo];
    const frac = idx - lo;
    return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/**
 * Distribución de la latencia HISTÓRICA de firma del operador (sólo intervalos
 * CERRADOS: una firma efectivamente ocurrió). Alimenta la predicción del ETA
 * operador-bound y la alerta de slippage.
 *
 * @returns {{p50, p75, p90, samples, meanMin, maxMin}} en minutos.
 */
function operatorLatencyDistribution(intervals) {
    const closed = (intervals || [])
        .filter((iv) => iv && !iv.open && Number.isFinite(iv.waitMin) && iv.waitMin >= 0)
        .map((iv) => iv.waitMin)
        .sort((a, b) => a - b);
    if (!closed.length) {
        return { p50: null, p75: null, p90: null, samples: 0, meanMin: null, maxMin: null };
    }
    const sum = closed.reduce((s, v) => s + v, 0);
    return {
        p50: Math.round(percentile(closed, 50) * 100) / 100,
        p75: Math.round(percentile(closed, 75) * 100) / 100,
        p90: Math.round(percentile(closed, 90) * 100) / 100,
        samples: closed.length,
        meanMin: Math.round((sum / closed.length) * 100) / 100,
        maxMin: Math.round(closed[closed.length - 1] * 100) / 100,
    };
}

/**
 * Métrica agregada de espera de operador para una ola (lista de issues) + por
 * clase de gate (CA-4). Todos los valores son números finitos ≥ 0.
 *
 * @param {number[]} issueList — issues de la ola (se normalizan a enteros).
 * @param {object} [opts] — { pipelineDir, fsImpl, now }.
 * @returns {{
 *   totalWaitMin, openWaitMin, closedWaitMin,
 *   byGate: {gateClass: {waitMin, issues, openIssues}},
 *   byIssue: {issue: {waitOperatorMin, openWaitMin, byGate}},
 *   waitingNow: [{issue, gateClass, waitMin}],
 *   operatorLatency, issuesConsidered
 * }}
 */
function calculateOperatorWait(issueList, opts = {}) {
    const wanted = new Set(
        (Array.isArray(issueList) ? issueList : [])
            .map(normalizeIssue)
            .filter((n) => n !== null),
    );
    const { intervals, byIssue } = collectOperatorWaitIntervals(opts);

    const relevant = wanted.size > 0
        ? intervals.filter((iv) => wanted.has(iv.issue))
        : intervals;

    const byGate = {};
    const waitingNow = [];
    let totalWaitMin = 0;
    let openWaitMin = 0;

    for (const iv of relevant) {
        totalWaitMin += iv.waitMin;
        if (iv.open) {
            openWaitMin += iv.waitMin;
            waitingNow.push({ issue: iv.issue, gateClass: iv.gateClass, waitMin: round2(iv.waitMin) });
        }
        if (!byGate[iv.gateClass]) byGate[iv.gateClass] = { waitMin: 0, issues: new Set(), openIssues: new Set() };
        byGate[iv.gateClass].waitMin += iv.waitMin;
        byGate[iv.gateClass].issues.add(iv.issue);
        if (iv.open) byGate[iv.gateClass].openIssues.add(iv.issue);
    }

    // Materializar sets → conteos (proyección pública, sin estructuras internas).
    const byGateOut = {};
    for (const [gc, v] of Object.entries(byGate)) {
        byGateOut[gc] = {
            waitMin: round2(v.waitMin),
            issues: v.issues.size,
            openIssues: v.openIssues.size,
        };
    }

    const byIssueOut = {};
    for (const [issue, agg] of byIssue.entries()) {
        if (wanted.size > 0 && !wanted.has(issue)) continue;
        const byGateIssue = {};
        for (const [gc, m] of Object.entries(agg.byGate)) byGateIssue[gc] = round2(m);
        byIssueOut[issue] = {
            waitOperatorMin: round2(agg.waitOperatorMin),
            openWaitMin: round2(agg.openWaitMin),
            byGate: byGateIssue,
        };
    }

    return {
        totalWaitMin: round2(totalWaitMin),
        openWaitMin: round2(openWaitMin),
        closedWaitMin: round2(totalWaitMin - openWaitMin),
        byGate: byGateOut,
        byIssue: byIssueOut,
        waitingNow: waitingNow.sort((a, b) => b.waitMin - a.waitMin),
        operatorLatency: operatorLatencyDistribution(intervals),
        issuesConsidered: wanted.size,
    };
}

function round2(n) {
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * Proyecta la espera de operador PENDIENTE para el ETA operador-bound (los dos
 * ETAs del diseño: "ETA si firmás ya" = pipeline-bound vs "ETA con tu latencia
 * histórica de firma" = operador-bound). El gap entre ambos = costo visible de
 * los gates.
 *
 * Modelo honesto (sin inventar gates futuros que el issue todavía no cruzó):
 *   - Para cada issue HOY en `waiting-operator`, el tiempo restante hasta la
 *     firma ≈ `max(0, p50Latencia − yaEsperado)`. Si `yaEsperado > p50`, la firma
 *     está VENCIDA (`overdueSignatures`) → aporta 0 al restante pero se cuenta.
 *   - Si no hay historia de latencia (`p50 == null`), no se proyecta futuro: las
 *     firmas pendientes quedan como `pendingSignatures` con ETA desconocido.
 *
 * @param {object} operatorWait — salida de `calculateOperatorWait`.
 * @returns {{projectedWaitMin, perSignatureMin, pendingSignatures, overdueSignatures}}
 */
function projectPendingOperatorWait(operatorWait) {
    const lat = operatorWait && operatorWait.operatorLatency;
    const p50 = lat && Number.isFinite(lat.p50) ? lat.p50 : null;
    const waiting = (operatorWait && Array.isArray(operatorWait.waitingNow)) ? operatorWait.waitingNow : [];
    let projected = 0;
    let overdue = 0;
    for (const w of waiting) {
        if (p50 === null) continue;   // sin historia: no proyectamos futuro
        const remain = p50 - (Number.isFinite(w.waitMin) ? w.waitMin : 0);
        if (remain > 0) projected += remain;
        else overdue += 1;
    }
    return {
        projectedWaitMin: round2(projected),
        perSignatureMin: p50,
        pendingSignatures: waiting.length,
        overdueSignatures: overdue,
    };
}

/**
 * Detector de alerta (CA opcional): ¿la espera de operador amenaza el ETA de la
 * ola? Devuelve los issues cuya espera en curso ya supera el umbral. Función
 * PURA de decisión — el envío efectivo (Telegram) queda fuera, sólo métrica
 * (requisito A09: sin bodies/paths/secrets).
 *
 * @param {object} operatorWait — salida de `calculateOperatorWait`.
 * @param {object} [opts]
 * @param {number} [opts.thresholdMin=120] — umbral de espera en curso (min).
 * @returns {{shouldAlert:boolean, thresholdMin, offenders:[{issue,gateClass,waitMin}], totalOpenWaitMin}}
 */
function evaluateOperatorWaitAlert(operatorWait, opts = {}) {
    const thresholdMin = Number.isFinite(opts.thresholdMin) && opts.thresholdMin > 0
        ? opts.thresholdMin
        : 120;
    const waiting = (operatorWait && Array.isArray(operatorWait.waitingNow)) ? operatorWait.waitingNow : [];
    const offenders = waiting
        .filter((w) => Number.isFinite(w.waitMin) && w.waitMin >= thresholdMin)
        .map((w) => ({ issue: w.issue, gateClass: w.gateClass, waitMin: round2(w.waitMin) }));
    return {
        shouldAlert: offenders.length > 0,
        thresholdMin,
        offenders,
        totalOpenWaitMin: operatorWait && Number.isFinite(operatorWait.openWaitMin)
            ? operatorWait.openWaitMin : 0,
    };
}

/**
 * Mensaje de alerta — SÓLO métrica (A09). Sin números de issue con contexto
 * sensible, sin paths, sin bodies. Formato humano corto en minutos/horas.
 */
function formatOperatorWaitAlert(alert) {
    if (!alert || !alert.shouldAlert) return null;
    const n = alert.offenders.length;
    const hrs = (min) => (min >= 60 ? `${Math.round(min / 6) / 10}h` : `${Math.round(min)}min`);
    const worst = alert.offenders.reduce((a, b) => (b.waitMin > a.waitMin ? b : a), alert.offenders[0]);
    return `⏳ La ola va a slippear: ${n} issue(s) esperando tu firma hace >${hrs(alert.thresholdMin)} `
        + `(el que más, #${worst.issue} en ${worst.gateClass}, hace ${hrs(worst.waitMin)}).`;
}

module.exports = {
    // API pública
    calculateOperatorWait,
    operatorLatencyDistribution,
    projectPendingOperatorWait,
    evaluateOperatorWaitAlert,
    formatOperatorWaitAlert,
    // constantes
    GATE_CLASS,
    WAITING_STATE,
    // helpers expuestos para tests
    _internal: {
        collectOperatorWaitIntervals,
        gateClassForFase,
        faseFromActor,
        parseTs,
        normalizeIssue,
        readJsonlSafe,
        percentile,
        round2,
        auditDir,
        PRE_TRANSITION_RESULT,
    },
};
