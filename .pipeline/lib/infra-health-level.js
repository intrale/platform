// =============================================================================
// infra-health-level.js — Semáforo global explicable del dashboard (#3954,
// EP8-H1 CA-2/CA-3).
//
// Función PURA extraída de `dashboard.js` (donde vivía como
// `computeInfraHealthLevel`, sólo-infra). Se extrae a lib para que la consuman
// SIN dependencia circular tanto `dashboard.js` (semáforo de la home legacy)
// como `views/dashboard/home.js` (Banda 1 del mission-control kiosk).
//
// Extendida de "solo infra" (DNS / circuit-breaker / retries) a
// `pulpo + infra + cuota + anomalía`. Devuelve, además del `{ level, label }`
// retrocompatible, un array `reasons[]` (`{ code, level, text }`) que enumera
// QUÉ degradó el semáforo para el tooltip CA-2. Con el sistema sano `reasons`
// queda vacío y el caller muestra "sin degradaciones".
//
// El texto de cada razón es server-side y de catálogo cerrado (NO refleja
// input externo), pero igualmente debe escaparse al renderizar en el DOM
// (REQ-SEC-6, defensa en profundidad por si a futuro un `text` incorpora
// nombres de skill/issue).
// =============================================================================
'use strict';

const HEALTH_RANK = Object.freeze({ ok: 0, warn: 1, stale: 2, alert: 3 });
const HEALTH_LABEL = Object.freeze({ ok: 'SALUDABLE', warn: 'DEGRADADO', stale: 'STALE', alert: 'CRITICO' });

/**
 * Computa el semáforo global explicable.
 *
 * @param {object} h — datos de infra: `{ dns:{status,lastCheck,latencyMs},
 *                      circuitBreaker:{state}, retries:{ratePercent} }`.
 * @param {object} [extra] — fuentes nuevas (#3954), todas opcionales:
 *   - `pulpoAlive` (bool|null): `false` ⇒ orquestador caído.
 *   - `quotaState` (obj): `{ active: true }` ⇒ cuota Anthropic agotada.
 *   - `costAnomaly` (obj): `{ active: true }` ⇒ anomalía de costo.
 * @param {number} [nowMs] — inyectable para tests (default Date.now()).
 * @returns {{ level: string, label: string, reasons: Array<{code,level,text}> }}
 */
function computeInfraHealthLevel(h, extra, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const reasons = [];
    let level = 'ok';
    const escalate = (lvl) => { if (HEALTH_RANK[lvl] > HEALTH_RANK[level]) level = lvl; };
    const addReason = (code, lvl, text) => { reasons.push({ code, level: lvl, text }); escalate(lvl); };

    // ── Fuente: infra (DNS / circuit-breaker / retries) ──
    const lastCheck = h && h.dns && h.dns.lastCheck;
    const dnsAge = lastCheck ? (now - new Date(lastCheck).getTime()) : Infinity;
    if (!isFinite(dnsAge) || dnsAge > 300000) {
        addReason('infra:stale', 'stale', 'Healthcheck de infra sin datos recientes (>5 min)');
    } else {
        if (h.circuitBreaker && h.circuitBreaker.state === 'open') {
            addReason('infra:circuit-breaker', 'alert', 'Circuit breaker abierto — pipeline pausado');
        }
        if (h.dns && h.dns.status === 'FAIL') {
            addReason('infra:dns', 'alert', 'Resolución DNS fallando');
        }
        const rate = h.retries && typeof h.retries.ratePercent === 'number' ? h.retries.ratePercent : 0;
        if (rate > 20) {
            addReason('infra:retries', 'alert', 'Tasa de reintentos crítica (>20%)');
        } else if (rate >= 5) {
            addReason('infra:retries', 'warn', 'Tasa de reintentos elevada (5–20%)');
        }
        const lat = h.dns && typeof h.dns.latencyMs === 'number' ? h.dns.latencyMs : 0;
        if (lat > 3000) {
            addReason('infra:latency', 'warn', 'Latencia DNS alta (>3s)');
        }
    }

    // ── Fuentes nuevas (#3954): pulpo / cuota / anomalía ──
    const ex = extra || {};
    if (ex.pulpoAlive === false) {
        addReason('pulpo:down', 'alert', 'Pulpo (orquestador) caído — no se lanzan agentes');
    }
    if (ex.quotaState && ex.quotaState.active === true) {
        addReason('cuota:exhausted', 'warn', 'Cuota Anthropic agotada — pipeline en modo determinístico');
    }
    if (ex.costAnomaly && ex.costAnomaly.active === true) {
        addReason('anomalia:cost', 'warn', 'Anomalía de consumo detectada');
    }

    return { level, label: HEALTH_LABEL[level] || 'SALUDABLE', reasons };
}

module.exports = { computeInfraHealthLevel, HEALTH_RANK, HEALTH_LABEL };
