// ETA helpers para el dashboard del pipeline (issue #2895).
//
// Estas funciones puras computan los tiempos que se muestran en cada card
// de la ventana Pipeline:
//   - elapsedMs       → cuánto lleva el issue desde que entró al pipeline
//   - remainingMs     → suma de promedios históricos de skills faltantes
//   - absoluteMs      → epoch estimado de finalización (now + remainingMs)
//   - isStuck         → algún agente working supera N% del promedio
//
// La fuente de verdad para promedios es `state.etaAverages` que ya construye
// `dashboard.getPipelineState()` cruzando los markers reales de procesado/listo
// (ctime - birthtime). Esa misma estructura es la que recibe este módulo, por
// lo que no agrega I/O ni conoce el filesystem.
//
// El issue #2895 propuso usar `metrics/snapshot.json` (campo avg_duration_ms),
// pero el dashboard ya tiene la lógica de markers; mantenerlo evita doble
// fuente de verdad y nos da granularidad por (fase, skill) en lugar de solo
// por skill global. Snapshot.json se puede usar como fallback más adelante
// si hace falta para skills nunca ejecutados (recomendación #2897).

'use strict';

const DEFAULT_STUCK_THRESHOLD_PCT = 150;

/**
 * Devuelve el avg en ms para una clave (fase/skill) cayendo a fase si no
 * existe el promedio fino. Retorna null si no hay histórico.
 */
function lookupAvgMs(etaAverages, fase, skill) {
  if (!etaAverages) return null;
  const finegrain = etaAverages[`${fase}/${skill}`];
  if (finegrain && finegrain.avgMs) return finegrain.avgMs;
  const coarse = etaAverages[fase];
  if (coarse && coarse.avgMs) return coarse.avgMs;
  return null;
}

/**
 * Calcula tiempos de un issue.
 *
 * @param {Object} params
 * @param {Object} params.issueData     - data del issue (matrix entry)
 * @param {Object} params.etaAverages   - state.etaAverages
 * @param {Array}  params.allFases      - lista [{pipeline, fase}] en orden
 * @param {number} [params.now]         - epoch ms; default Date.now()
 * @param {number} [params.stuckPct]    - umbral % para "estancado"; default 150
 *
 * @returns {{
 *   elapsedMs:    number|null,  // null si no hay markers válidos
 *   remainingMs:  number|null,  // null si no hay histórico para skills faltantes
 *   absoluteMs:   number|null,  // now + remainingMs cuando hay remaining
 *   isStuck:      boolean,
 *   stuckSkill:   string|null,  // skill que disparó el stuck (si hay)
 *   stuckOverMs:  number,       // cuánto sobre el promedio
 *   hasEta:       boolean       // alias semántico de remainingMs != null
 * }}
 */
function computeIssueEta({ issueData, etaAverages, allFases, now, stuckPct }) {
  const t0 = typeof now === 'number' ? now : Date.now();
  const threshold = (typeof stuckPct === 'number' ? stuckPct : DEFAULT_STUCK_THRESHOLD_PCT) / 100;

  // Earliest started among all entries (ese es el "issue start time").
  let issueStart = null;
  let lastUpdate = 0;
  for (const entries of Object.values(issueData?.fases || {})) {
    for (const e of entries) {
      if (e.startedAt && (issueStart === null || e.startedAt < issueStart)) issueStart = e.startedAt;
      if (e.updatedAt && e.updatedAt > lastUpdate) lastUpdate = e.updatedAt;
    }
  }
  const elapsedMs = issueStart != null ? Math.max(0, t0 - issueStart) : null;

  // Recorrer fases en orden y sumar ETAs de las pendientes/working.
  let remainingMs = 0;
  let hasAnyEta = false;
  let isStuck = false;
  let stuckSkill = null;
  let stuckOverMs = 0;

  for (const { pipeline, fase } of (allFases || [])) {
    const key = `${pipeline}/${fase}`;
    const entries = (issueData?.fases || {})[key] || [];
    const hasPendingOrWorking = entries.some(e => e.estado === 'pendiente' || e.estado === 'trabajando');
    const isDone = !hasPendingOrWorking && entries.some(e => e.estado === 'listo' || e.estado === 'procesado');
    if (isDone) continue;

    const workingEntry = entries.find(e => e.estado === 'trabajando');
    if (workingEntry) {
      const avgMs = lookupAvgMs(etaAverages, fase, workingEntry.skill);
      if (avgMs && workingEntry.durationMs != null) {
        // Restante = max(0, avg - duración actual)
        remainingMs += Math.max(0, avgMs - workingEntry.durationMs);
        hasAnyEta = true;
        // Stuck: superó threshold del promedio
        if (workingEntry.durationMs > avgMs * threshold && !isStuck) {
          isStuck = true;
          stuckSkill = workingEntry.skill;
          stuckOverMs = workingEntry.durationMs - avgMs;
        }
      } else if (avgMs) {
        // No tenemos durationMs (raro), usar avg directo
        remainingMs += avgMs;
        hasAnyEta = true;
      }
    } else {
      // Fase pendiente sin started: usar avg de fase (sin discriminar skill que va a correr).
      const avgMs = lookupAvgMs(etaAverages, fase, null);
      if (avgMs) {
        remainingMs += avgMs;
        hasAnyEta = true;
      }
    }
  }

  const remaining = hasAnyEta ? remainingMs : null;
  const absolute = remaining != null ? t0 + remaining : null;
  return {
    elapsedMs,
    remainingMs: remaining,
    absoluteMs: absolute,
    isStuck,
    stuckSkill,
    stuckOverMs,
    hasEta: remaining != null,
    issueStartedAt: issueStart,
    lastUpdatedAt: lastUpdate,
  };
}

/**
 * Calcula el "ETA pipeline vacío" para un conjunto de issues activos.
 * Es el max(absoluteMs) — no Σ — porque los issues corren en paralelo.
 *
 * @param {Array} issuesEta - array de objetos {absoluteMs}
 * @returns {number|null} epoch del último issue en finalizar, o null si nadie tiene ETA.
 */
function computeLaneEmptyEta(issuesEta) {
  let maxAbs = null;
  for (const e of issuesEta || []) {
    if (e && typeof e.absoluteMs === 'number' && (maxAbs === null || e.absoluteMs > maxAbs)) {
      maxAbs = e.absoluteMs;
    }
  }
  return maxAbs;
}

/**
 * Formatea un epoch ms a "HH:MM" en hora local.
 */
function fmtAbsoluteHHMM(epochMs) {
  if (!epochMs) return '—';
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

module.exports = {
  computeIssueEta,
  computeLaneEmptyEta,
  lookupAvgMs,
  fmtAbsoluteHHMM,
  DEFAULT_STUCK_THRESHOLD_PCT,
};
