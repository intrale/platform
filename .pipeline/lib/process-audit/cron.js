'use strict';

// =============================================================================
// process-audit / cron — tick determinístico del auditor del proceso (#6809)
// =============================================================================
//
// Clon estructural de `model-value-audit/cron.js` (D2; la unificación de los
// helpers copiados queda en #7529). `tickIfDue(...)` es lo que el brazo de
// `pulpo.js` llama cada hora. Orden fail-closed (SEC-6809-7):
//
//   resolveSection(cfgRoot) → inFlight → due? → escribir `last_run_at` ATÓMICO
//   → run() → publicar hallazgos (tope por corrida) → escribir resumen
//
// - Gate: `process_audit.enabled === true` EXACTO (`'true'`, `1`, `'yes'` ⇒
//   apagado). `cadence_days` ∈ [1, 30] y `window_days` ∈ [7, 30] enteros;
//   `min_samples_hora` ∈ [1, 120]. Un valor fuera de rango ⇒ `null`
//   (deshabilitado), SIN clamp silencioso.
// - El estado se escribe ANTES de `run`: si la escritura falla, no se corre
//   (anti-repetidor horario). Si `run` lanza, la corrida se pierde hasta la
//   próxima cadencia (`run_fallo`).
// - `due = !Number.isFinite(last) || last > now || (now - last) >= cadence`.
// - Publicación: sólo por el registro único (`publish.js`, D3). Como máximo
//   `MAX_PUBLICACIONES_POR_CORRIDA` intentos por corrida (el registro además
//   aplica su cuota diaria por productor).
// - ÚNICA escritura de este módulo: `writeStateAtomic` sobre
//   `state/process-audit-cron.json`, resuelto SIEMPRE vía `write-target`.
//
// `readStatus()` es la lectura para el dashboard (CA-7): flag + última corrida
// + conteos, sin texto libre.
//
// Sólo `require` de `fs`, `path` y rutas relativas dentro de `lib/`. Nada de
// consola: todo por `logger`.

const fs = require('fs');
const path = require('path');

const DAY_MS = 86400000;
const STATE_FILE = 'process-audit-cron.json';
const STATE_DESTINO = 'state/process-audit-cron.json';
const PRODUCTOR = 'auditor-proceso';
const MAX_PUBLICACIONES_POR_CORRIDA = 10;
const RANGOS = Object.freeze({
    cadence_days: [1, 30],
    window_days: [7, 30],
    min_samples_hora: [1, 120],
});
const DEFAULTS = Object.freeze({ cadence_days: 7, window_days: 14, min_samples_hora: 60 });
const EJES = Object.freeze(['proceso', 'capacidad', 'proveedores']);

let inFlight = false;

function enRango(v, [lo, hi]) {
    return Number.isInteger(v) && v >= lo && v <= hi;
}

/**
 * Sección efectiva o `null` (⇒ `deshabilitado`). Pura.
 * @returns {{cadence_days:number, window_days:number, min_samples_hora:number}|null}
 */
function resolveSection(cfgRoot) {
    const s = cfgRoot && typeof cfgRoot === 'object' ? cfgRoot.process_audit : undefined;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    if (s.enabled !== true) return null;
    const out = {};
    for (const k of Object.keys(RANGOS)) {
        const v = s[k] === undefined ? DEFAULTS[k] : s[k];
        if (!enRango(v, RANGOS[k])) return null;
        out[k] = v;
    }
    return out;
}

/** ¿Toca correr? Futuro o corrupto ⇒ corre. */
function isDue({ last, now, cadenceDays } = {}) {
    const cad = (Number.isFinite(cadenceDays) && cadenceDays >= 1) ? cadenceDays : DEFAULTS.cadence_days;
    if (!Number.isFinite(last)) return true;
    if (last > now) return true;
    return (now - last) >= cad * DAY_MS;
}

// copia de model-value-audit/cron.js — unificar en #7529
function readState(file, fsImpl = fs) {
    try {
        if (typeof fsImpl.existsSync === 'function' && !fsImpl.existsSync(file)) return null;
        const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    } catch {
        return null;
    }
}

// copia de model-value-audit/cron.js — unificar en #7529
function writeStateAtomic(file, data, fsImpl = fs) {
    const dir = path.dirname(file);
    if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fsImpl.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fsImpl.renameSync(tmp, file);
    try { fsImpl.chmodSync(file, 0o600); } catch { /* Windows: best-effort */ }
}

/** SIEMPRE vía `write-target` (lint R1/R2); nunca `__dirname` ni `pipelineDir`. */
function defaultStateFile() {
    return require('../write-target').writePath(process.env, { canal: 'estado', destino: STATE_DESTINO }, 'state', STATE_FILE);
}

function codeOf(e) {
    return (e && typeof e.code === 'string' && e.code) ? e.code : 'error';
}

function conteoPorEje(report) {
    const out = {};
    const ejes = (report && report.ejes) || {};
    for (const e of EJES) {
        const x = ejes[e] || {};
        out[e] = {
            veredicto: typeof x.veredicto === 'string' ? x.veredicto : 'sin_dato',
            hallazgos: Array.isArray(x.hallazgos) ? x.hallazgos.length : 0,
        };
    }
    return out;
}

/**
 * Tick del brazo. Nunca lanza por errores de `run`/`publish`.
 *
 * @param {object} p
 * @param {string} p.pipelineDir
 * @param {object} p.cfgRoot           config resuelta (releída por el caller en cada tick)
 * @param {number} [p.now]
 * @param {object} [p.fsImpl]
 * @param {string} [p.stateFile]       inyectable para tests (mkdtemp)
 * @param {Function} [p.run]           default `require('./index').runAudit`
 * @param {Function} [p.publish]       default `require('./publish').publicarHallazgo`
 * @param {Function} [p.logger]
 * @returns {{ran:boolean, reason:string, publicadas?:number, hallazgos?:number}}
 */
function tickIfDue({ pipelineDir, cfgRoot, now = Date.now(), fsImpl = fs, stateFile, run, publish, logger = () => {} } = {}) {
    const section = resolveSection(cfgRoot);
    if (!section) return { ran: false, reason: 'deshabilitado' };
    if (inFlight) return { ran: false, reason: 'en_curso' };
    inFlight = true;
    try {
        const file = stateFile || defaultStateFile();
        const st = readState(file, fsImpl);
        if (!isDue({ last: st && st.last_run_at, now, cadenceDays: section.cadence_days })) {
            return { ran: false, reason: 'no_due' };
        }
        const previo = (st && typeof st === 'object') ? st : {};
        try {
            writeStateAtomic(file, { ...resumenPrevio(previo), last_run_at: now, last_reason: 'en_curso' }, fsImpl);
        } catch (e) {
            logger(`estado no persistible, corrida omitida (${codeOf(e)})`);
            return { ran: false, reason: 'estado_no_persistible' };
        }

        let report;
        try {
            const runFn = run || require('./index').runAudit;
            report = runFn({
                pipelineDir, cfgRoot, now,
                windowDays: section.window_days,
                minSamplesHora: section.min_samples_hora,
                fsImpl,
            });
        } catch (e) {
            logger(`corrida falló (${codeOf(e)})`);
            guardarResumen(file, fsImpl, { last_run_at: now, last_reason: 'run_fallo' }, logger);
            return { ran: true, reason: 'run_fallo' };
        }
        if (!report || typeof report !== 'object') {
            logger('corrida falló (reporte vacío)');
            guardarResumen(file, fsImpl, { last_run_at: now, last_reason: 'run_fallo' }, logger);
            return { ran: true, reason: 'run_fallo' };
        }

        const hallazgos = Array.isArray(report.hallazgos) ? report.hallazgos : [];
        const pub = publish || require('./publish').publicarHallazgo;
        const motivos = {};
        let publicadas = 0;
        let intentos = 0;
        for (const h of hallazgos) {
            if (intentos >= MAX_PUBLICACIONES_POR_CORRIDA) { motivos.tope_corrida = (motivos.tope_corrida || 0) + 1; continue; }
            intentos++;
            let r;
            try {
                r = pub(h, { logger });
            } catch (e) {
                r = { publicado: false, motivo: 'publish_fallo' };
                logger(`publicación falló (${codeOf(e)}); no se degrada a otro canal`);
            }
            const motivo = (r && typeof r.motivo === 'string' && /^[a-z_]{1,40}$/.test(r.motivo)) ? r.motivo : 'desconocido';
            if (r && r.publicado) publicadas++;
            motivos[motivo] = (motivos[motivo] || 0) + 1;
        }
        const reason = hallazgos.length === 0 ? 'sin_hallazgos' : (publicadas > 0 ? 'publicado' : 'sin_publicaciones_nuevas');
        guardarResumen(file, fsImpl, {
            last_run_at: now,
            last_reason: reason,
            ventana_dias: section.window_days,
            ejes: conteoPorEje(report),
            hallazgos: hallazgos.length,
            publicadas,
            motivos,
        }, logger);
        logger(`corrida terminada: ${hallazgos.length} hallazgos, ${publicadas} propuestas nuevas en el registro`);
        return { ran: true, reason, publicadas, hallazgos: hallazgos.length };
    } finally {
        inFlight = false;
    }
}

function resumenPrevio(st) {
    // Se conserva el último resumen completo mientras corre la nueva corrida.
    const out = {};
    for (const k of ['ejes', 'hallazgos', 'publicadas', 'motivos', 'ventana_dias']) {
        if (st[k] !== undefined) out[k] = st[k];
    }
    return out;
}

function guardarResumen(file, fsImpl, data, logger) {
    try {
        writeStateAtomic(file, data, fsImpl);
    } catch (e) {
        logger(`resumen no persistible (${codeOf(e)})`);
    }
}

/**
 * Estado visible para el operador (dashboard, CA-7). Nunca lanza. Sólo
 * números, enums y un ISO: nada de texto de la telemetría.
 */
function readStatus({ cfgRoot, stateFile, fsImpl = fs } = {}) {
    const s = cfgRoot && typeof cfgRoot === 'object' ? cfgRoot.process_audit : undefined;
    const enabled = !!(s && typeof s === 'object' && s.enabled === true);
    const section = resolveSection(cfgRoot);
    let st = null;
    try { st = readState(stateFile || defaultStateFile(), fsImpl); } catch { st = null; }
    const num = (v) => (Number.isFinite(v) ? v : null);
    const tok = (v) => (typeof v === 'string' && /^[a-z_]{1,40}$/.test(v) ? v : null);
    const ejes = {};
    for (const e of EJES) {
        const x = st && st.ejes && st.ejes[e];
        ejes[e] = { veredicto: tok(x && x.veredicto), hallazgos: num(x && x.hallazgos) };
    }
    const lastRun = st ? num(st.last_run_at) : null;
    return {
        enabled,
        config_valida: enabled ? section !== null : null,
        cadence_days: section ? section.cadence_days : null,
        window_days: section ? section.window_days : null,
        last_run_at: lastRun === null ? null : new Date(lastRun).toISOString(),
        last_reason: st ? tok(st.last_reason) : null,
        hallazgos: st ? num(st.hallazgos) : null,
        publicadas: st ? num(st.publicadas) : null,
        ejes,
        estado: !enabled ? 'inactivo' : (lastRun === null ? 'esperando_primera_corrida' : 'activo'),
    };
}

/** Sólo tests. */
function _resetInFlight() { inFlight = false; }

module.exports = {
    STATE_FILE,
    STATE_DESTINO,
    PRODUCTOR,
    DEFAULTS,
    RANGOS,
    MAX_PUBLICACIONES_POR_CORRIDA,
    DAY_MS,
    resolveSection,
    isDue,
    readState,
    writeStateAtomic,
    defaultStateFile,
    tickIfDue,
    readStatus,
    _resetInFlight,
};
