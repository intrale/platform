// Weekly Quota — estimación del consumo del Plan Max de Anthropic.
//
// ⚠️ DEPRECADO como FUENTE de la cuota Anthropic (#4597) — y RETIRADO en #4861.
//   `computeQuota` (heurística de `duration_ms`), `saveCalibration` y
//   `clearCalibration` (calibración manual EMA/factor) fueron ELIMINADAS: eran
//   la causa del valor divergente 57%/76% que mostraba el dashboard. La fuente
//   ÚNICA de verdad de la cuota Anthropic es el uso REAL de `claude -p "/usage"`
//   (ver lib/anthropic-usage.js + quota-adapters/anthropic.js). Este archivo se
//   conserva ÚNICAMENTE por los helpers de reset semanal standalone
//   (`getLastWeeklyResetMs`/`getNextWeeklyResetMs`) que consumen pacing-bucket.js
//   y quota-exhausted.js para anclar la ventana semanal, más el re-export de
//   `quotaUsage`. No re-introducir cálculo/calibración de cuota Anthropic acá.
//
// Anthropic NO expone API pública del uso del plan, así que aproximamos:
//
//  1. Sumamos `duration_ms` de eventos `session:end` del activity-log
//     (los emitidos por el pulpo desde el fix #2801) en una ventana
//     deslizante de 7 días → horas reales de uso.
//
// Multi-provider (M2 #3092 + #3065 §5.4):
//
//   * La API legacy `computeQuota(metricsDir, log)` fue retirada en #4861.
//     Los consumidores usan `quotaUsage('anthropic', ...)`.
//
//   * La API multi-provider canónica vive en `lib/quota-adapters/`:
//
//       const { quotaUsage } = require('./lib/quota-adapters');
//       const result = quotaUsage('anthropic', { metricsDir, activityLogPath });
//
//     `quotaUsage` valida `provider` contra una allowlist hardcoded, dispatcha
//     al adapter correspondiente y devuelve un shape uniforme con
//     `adapterStatus` discriminado (ok/unknown/error/not_implemented/no_quota).
//
//   * Para conveniencia y para que callers existentes puedan migrar progresivo
//     sin importar dos paquetes, este módulo re-exporta `quotaUsage`. El
//     dispatch es idéntico, la lógica vive en quota-adapters/ — fuente única.
//
// Schema versioning del state (`weekly-quota.json`):
//
//   * Antes de M2 los archivos persistidos no tenían `schema_version`. Se
//     considera schema v1 implícito.
//   * Desde M2 escribimos `schema_version: 2` explícito; en lectura se
//     completa lazy con default = 2 si falta. Esto habilita futuras
//     migraciones sin romper instalaciones existentes.
//
//  2. Comparamos contra un límite estimado configurable
//     (default 40h/semana basado en consenso de comunidad de Claude Code).
//
//  3. **Auto-ajuste pasivo**: si en cualquier ventana de 7d acumulamos
//     más horas que `effective_limit` SIN observar un bloqueo, subimos
//     `effective_limit` al máximo observado + 5h de buffer. Así el
//     número va calibrándose con más data sin requerir intervención.
//
//  4. Estado persistido en `.pipeline/metrics/weekly-quota.json`:
//     {
//       config_limit_hours: 40,
//       effective_limit_hours: 47.3,    // ajustado
//       observed_max_hours: 42.3,       // máximo observado en 7d
//       observed_max_at: "2026-04-23T..." ,
//       adjustments: [
//         {at:"2026-04-23T", from:40, to:45, reason:"observed_max=42.3"}
//       ]
//     }
//
// Detección de bloqueo (TODO #2801-followup): cuando el pulpo identifique
// patrón "rate_limit_error" / "weekly limit" en stderr/stdout del agente,
// debería persistir el `hours_at_block` y bajar `effective_limit` a ese
// valor (con prioridad sobre observed_max). Por ahora solo subimos.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LIMIT_HOURS = 40;
const DEFAULT_SESSION_LIMIT_HOURS = 5;       // Plan Max: sesión rolling de 5h
const ADJUSTMENT_BUFFER_HOURS = 5;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
// Anthropic resetea la cuota semanal **domingo 21:00 hora local del usuario**
// (constatado en claude.ai/settings/usage). En Argentina = UTC-3 fijo (sin DST).
// Configurable vía env por si el operador está en otra TZ.
const RESET_DAY_LOCAL = 0;  // 0 = Domingo
const RESET_HOUR_LOCAL = 21;
const TZ_OFFSET_MIN = Number(process.env.QUOTA_TZ_OFFSET_MIN) || -180; // ART por default

/**
 * Devuelve el timestamp del último reset semanal (último domingo 21:00 local)
 * para una marca temporal dada.
 */
function getLastWeeklyResetMs(now = Date.now()) {
    // Convertir now a "hora local" sumando offset (offset es diff de UTC, en min)
    const localNow = new Date(now + TZ_OFFSET_MIN * 60000);
    // Construir el "domingo 21:00" más reciente en hora local
    const localReset = new Date(localNow);
    localReset.setUTCHours(RESET_HOUR_LOCAL, 0, 0, 0);
    const dow = localNow.getUTCDay(); // 0=Sun
    let daysBack = (dow - RESET_DAY_LOCAL + 7) % 7;
    if (daysBack === 0 && localNow.getUTCHours() < RESET_HOUR_LOCAL) {
        // Es domingo antes de las 21:00 → el reset fue hace 7 días
        daysBack = 7;
    }
    localReset.setUTCDate(localReset.getUTCDate() - daysBack);
    // Volver de "hora local fingida" a UTC real
    return localReset.getTime() - TZ_OFFSET_MIN * 60000;
}

function getNextWeeklyResetMs(now = Date.now(), driftMin = 0) {
    return getLastWeeklyResetMs(now) + WEEK_MS + (driftMin || 0) * 60000;
}

function quotaFile(metricsDir) {
    return path.join(metricsDir, 'weekly-quota.json');
}

// Schema version del state persistido. Antes de M2 (#3092) los archivos no
// tenían version explícito (= "v1 implícito"). Desde M2 se persiste explícito.
// La migración es lazy y aditiva — no hay rename ni drop de campos.
const STATE_SCHEMA_VERSION = 2;

function loadState(metricsDir) {
    try {
        const raw = fs.readFileSync(quotaFile(metricsDir), 'utf8');
        const parsed = JSON.parse(raw);
        // Defaults para campos nuevos en estados viejos
        if (!parsed.calibration) parsed.calibration = null;
        if (!parsed.calibrations) parsed.calibrations = [];
        // Migración lazy v1 → v2: si no hay schema_version, asumimos v1 y
        // promovemos a v2 SIN tocar más campos (la nueva API multi-provider
        // no requiere reformato del legacy).
        if (!parsed.schema_version) parsed.schema_version = STATE_SCHEMA_VERSION;
        return parsed;
    } catch {
        return {
            schema_version: STATE_SCHEMA_VERSION,
            config_limit_hours: DEFAULT_LIMIT_HOURS,
            effective_limit_hours: DEFAULT_LIMIT_HOURS,
            observed_max_hours: 0,
            observed_max_at: null,
            adjustments: [],
            calibration: null,
            calibrations: [],
        };
    }
}

// #4861 — saveCalibration/clearCalibration y el helper round2 se RETIRARON.
// La calibración manual EMA (factor real/pipeline sobre la heurística
// duration_ms) producía el valor divergente 57%/76% del dashboard. La fuente
// única de verdad de la cuota Anthropic es ahora claude -p /usage vía
// lib/anthropic-usage.js + lib/quota-adapters/anthropic.js. computeQuota
// tambien se retiro (ver mas abajo). getLastWeeklyResetMs/getNextWeeklyResetMs
// se conservan: los consumen pacing-bucket.js y quota-exhausted.js.

function saveState(metricsDir, state) {
    try {
        fs.mkdirSync(metricsDir, { recursive: true });
        fs.writeFileSync(quotaFile(metricsDir), JSON.stringify(state, null, 2));
    } catch { /* best-effort */ }
}

/**
 * Suma duration_ms de session:end desde un timestamp de inicio hasta now.
 * @param {string} activityLogPath
 * @param {number} sinceMs - timestamp inicial (ej. último reset semanal)
 * @returns {{hoursUsed: number, sessionsCount: number, hoursLast24h: number}}
 */
function computeUsageSince(activityLogPath, sinceMs) {
    let raw;
    try { raw = fs.readFileSync(activityLogPath, 'utf8'); }
    catch { return { hoursUsed: 0, sessionsCount: 0, hoursLast24h: 0 }; }

    const now = Date.now();
    const day24Start = now - DAY_MS;
    let totalMs = 0;
    let totalMs24h = 0;
    let count = 0;
    for (const line of raw.split('\n')) {
        if (!line.startsWith('{')) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.event !== 'session:end') continue;
        if (!evt.ts || !evt.duration_ms) continue;
        const ts = new Date(evt.ts).getTime();
        if (Number.isNaN(ts) || ts < sinceMs) continue;
        // Excluir determinísticos (model:'deterministic') porque no consumen
        // cuota del plan Max — solo los agentes Claude reales cuentan.
        if (evt.model === 'deterministic') continue;
        // CA-5.1 (#3357): filtrar por provider — solo Anthropic cuenta al
        // plan Max. Sesiones con provider explícito distinto (groq, openai-codex,
        // gemini-google, cerebras, nvidia-nim, etc.) NO consumen cuota Anthropic.
        // Eventos sin `provider` se asumen Anthropic (compat con log histórico
        // anterior a M2 multi-provider, donde no se emitía el campo).
        if (evt.provider && evt.provider !== 'anthropic') continue;
        totalMs += evt.duration_ms;
        if (ts >= day24Start) totalMs24h += evt.duration_ms;
        count++;
    }
    return {
        hoursUsed: totalMs / 3600000,
        sessionsCount: count,
        hoursLast24h: totalMs24h / 3600000,
    };
}

// Wrapper de compat para callers viejos que pasaban windowMs deslizante.
function computeUsage(activityLogPath, windowMs = WEEK_MS) {
    return computeUsageSince(activityLogPath, Date.now() - windowMs);
}

// #4861 — computeQuota (heuristica duration_ms + weekly_factor/session_factor)
// se RETIRO. Producia el porcentaje calibrado divergente. La fuente unica de
// cuota Anthropic es claude -p /usage via quota-adapters/anthropic.js. Los
// helpers computeUsage/computeUsageSince quedan disponibles pero fuera del
// flujo activo de cuota.

// API multi-provider — dispatch a adapters/. Re-exportado acá para que
// callers que migran de `computeQuota` a `quotaUsage` no necesiten cambiar
// el require path de un solo paso. Fuente única de la lógica vive en
// quota-adapters/index.js (con allowlist + fail-secure).
let _adaptersDispatch = null;
function quotaUsage(provider, sessionData) {
    if (!_adaptersDispatch) {
        _adaptersDispatch = require('./quota-adapters').quotaUsage;
    }
    return _adaptersDispatch(provider, sessionData);
}

module.exports = {
    // #4861 — computeQuota/saveCalibration/clearCalibration retiradas (fuente
    // única = claude -p /usage). getLastWeeklyResetMs/getNextWeeklyResetMs se
    // conservan: los consumen pacing-bucket.js y quota-exhausted.js.
    computeUsage,
    computeUsageSince,
    getLastWeeklyResetMs,
    getNextWeeklyResetMs,
    loadState,
    saveState,
    quotaUsage,
    DEFAULT_LIMIT_HOURS,
    DEFAULT_SESSION_LIMIT_HOURS,
    STATE_SCHEMA_VERSION,
};
