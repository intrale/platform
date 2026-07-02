'use strict';

// =============================================================================
// #4362 — Derivación del estado de avance de un issue cuando NO tiene marcador
// de fase activo en disco (faseActual/estadoActual == null).
//
// El tablero arma `state.issueMatrix[issue]` escaneando carpetas del pipeline.
// `faseActual`/`estadoActual` sólo se setean para estados activos
// (pendiente/trabajando/listo); las entradas en `procesado/` NO los setean.
// Resultado: un issue que terminó una fase intermedia y todavía no arrancó la
// siguiente (típico de agentes on-demand que viven minutos) queda con ambos en
// null y la grilla lo pintaba en blanco = "sin arrancar", o peor, se colaba en
// `doneIssueIds` como "terminado".
//
// Este módulo cruza dos señales YA disponibles (cero I/O costoso nuevo):
//   1. `data.fases` conserva las entradas `procesado` aunque `estadoActual` sea
//      null → detectar "≥1 procesado en una fase NO terminal".
//   2. Actividad reciente de agentes desde `.claude/activity-log.jsonl`
//      (eventos `session:*`) cruzando por issue dentro de una ventana temporal.
//
// Estados canónicos derivados:
//   - 'activo'       → tiene estadoActual (fase activa en disco; no aplica derivado).
//   - 'entre-fases'  → sin estadoActual + procesado en fase no terminal + actividad reciente.
//   - 'terminado'    → sin estadoActual + closed en GitHub o procesado en fase terminal.
//   - 'sin-arrancar' → resto (nunca arrancó, o procesado viejo sin latido reciente).
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

// Ventana temporal (min) por defecto para considerar "actividad reciente".
// Reutiliza el mismo umbral que el resto del dashboard (STALE) para coherencia.
const DEFAULT_WINDOW_MIN = Number(process.env.PIPELINE_STALE_MIN_THRESHOLD) || 30;

// Cap de líneas del activity-log a leer (append-only). Las últimas 10000 líneas
// cubren >24h de operación normal — más que suficiente para una ventana de 30m.
const ACTIVITY_MAX_LINES = 10000;

const PROGRESS_STATES = Object.freeze({
    ACTIVO: 'activo',
    SIN_ARRANCAR: 'sin-arrancar',
    ENTRE_FASES: 'entre-fases',
    TERMINADO: 'terminado',
});

// -----------------------------------------------------------------------------
// terminalFaseKeySet(allFases) → Set<'<pipeline>/<fase>'>
//
// Fase terminal del FLUJO = última fase del último pipeline (último elemento de
// `allFases`, que dashboard.js construye iterando pipelines y fases en orden).
// NO se toman las terminales de pipelines intermedios (p.ej. `definicion/sizing`)
// como "terminado": un issue que las terminó sigue avanzando hacia el pipeline
// siguiente (desarrollo), no está terminado. Ver #4362.
// -----------------------------------------------------------------------------
function terminalFaseKeySet(allFases) {
    const set = new Set();
    const list = Array.isArray(allFases) ? allFases : [];
    if (list.length === 0) return set;
    const last = list[list.length - 1];
    if (last && last.pipeline && last.fase) set.add(`${last.pipeline}/${last.fase}`);
    return set;
}

// -----------------------------------------------------------------------------
// readRecentActivityIssues(repoRoot, {now, windowMin}) → Set<string>
//
// Lee `.claude/activity-log.jsonl` UNA vez y devuelve el set de issueIds con al
// menos un evento `session:*` dentro de la ventana. Nunca lanza: archivo
// ausente → set vacío. CA-6: el issue id se valida como numérico (`^[0-9]+$`)
// antes de indexar (defensa en profundidad, aunque acá no se interpola a shell).
// -----------------------------------------------------------------------------
function readRecentActivityIssues(repoRoot, opts) {
    const o = opts || {};
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    const windowMin = Number.isFinite(o.windowMin) ? o.windowMin : DEFAULT_WINDOW_MIN;
    const cutoff = now - windowMin * 60000;
    const set = new Set();
    if (!repoRoot) return set;

    let raw = '';
    try { raw = fs.readFileSync(path.join(repoRoot, '.claude', 'activity-log.jsonl'), 'utf8'); }
    catch { return set; /* archivo ausente → sin actividad, no error */ }

    const lines = raw.split(/\r?\n/);
    const tail = lines.length > ACTIVITY_MAX_LINES ? lines.slice(-ACTIVITY_MAX_LINES) : lines;
    for (const line of tail) {
        if (!line) continue;
        let rec = null;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!rec || typeof rec.event !== 'string' || !rec.event.startsWith('session:')) continue;
        if (rec.issue === undefined || rec.issue === null) continue;
        const issueId = String(rec.issue);
        if (!/^[0-9]+$/.test(issueId)) continue;   // CA-6 — id numérico validado
        let tsMs = rec.ts;
        if (typeof tsMs === 'string') tsMs = Date.parse(tsMs);
        if (!Number.isFinite(tsMs)) continue;
        // Dentro de la ventana [cutoff, now]; toleramos +60s de skew de reloj.
        if (tsMs < cutoff || tsMs > now + 60000) continue;
        set.add(issueId);
    }
    return set;
}

// -----------------------------------------------------------------------------
// deriveProgressState(data, {terminalFaseKeys, recentActivity}) → estado canónico
//
// Pura y testeable. NO reasigna faseActual/estadoActual (cambio aditivo, CA-4).
// -----------------------------------------------------------------------------
function deriveProgressState(data, opts) {
    const d = data || {};
    // Marcador de fase activo en disco → issue activo; el derivado no aplica.
    if (d.estadoActual) return PROGRESS_STATES.ACTIVO;

    const o = opts || {};
    const terminalFaseKeys = o.terminalFaseKeys instanceof Set ? o.terminalFaseKeys : new Set();
    const recentActivity = !!o.recentActivity;
    const closed = typeof d.state === 'string' && d.state.toLowerCase() === 'closed';

    let hasProcesadoNonTerminal = false;
    let hasProcesadoTerminal = false;
    const fases = d.fases || {};
    for (const [faseKey, entries] of Object.entries(fases)) {
        const list = Array.isArray(entries) ? entries : [];
        if (!list.some((e) => e && e.estado === 'procesado')) continue;
        if (terminalFaseKeys.has(faseKey)) hasProcesadoTerminal = true;
        else hasProcesadoNonTerminal = true;
    }

    // Terminado real = closed en GitHub o procesado en la fase terminal del flujo.
    if (closed || hasProcesadoTerminal) return PROGRESS_STATES.TERMINADO;
    // Entre fases = procesado en fase intermedia + latido reciente (anti falso-verde, CA-3).
    if (hasProcesadoNonTerminal && recentActivity) return PROGRESS_STATES.ENTRE_FASES;
    // Resto: nunca arrancó, o procesado viejo sin actividad reciente.
    return PROGRESS_STATES.SIN_ARRANCAR;
}

module.exports = {
    PROGRESS_STATES,
    DEFAULT_WINDOW_MIN,
    terminalFaseKeySet,
    readRecentActivityIssues,
    deriveProgressState,
};
