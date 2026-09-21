'use strict';

// =============================================================================
// model-value-audit / cron — tick determinístico del auditor (#7520, parte 4)
// =============================================================================
//
// `tickIfDue(...)` es lo que el brazo de `pulpo.js` llama cada hora. Orden
// fail-closed (SEC-11 / P3):
//
//   resolveSection(cfgRoot) → inFlight → due? → escribir `last_run_at` ATÓMICO
//   → run() → registrar (sólo `=== true`) → shouldPublish (CA-27) → publish
//
// - Doble gate (CA-24 / SEC-14): `model_value_audit.enabled === true` EXACTO
//   (`'true'`, `1`, `'yes'` ⇒ apagado); sección malformada (`registrar` no
//   booleano, `publish` fuera del enum) ⇒ `deshabilitado` sin escrituras.
// - El estado se escribe ANTES de `run`: si la escritura falla, ni `run` ni
//   `publish` (anti-repetidor horario); si `run` lanza, la corrida se pierde
//   hasta el próximo ciclo (`run_fallo`). Decisión explícita del Arquitecto.
// - `due = !Number.isFinite(last) || last > now || (now - last) >= cadence`:
//   un `last_run_at` futuro o corrupto NO silencia el auditor (corrige
//   `isWeeklyDue` de `multi-provider/health-cron.js`, que con futuro nunca
//   dispara).
// - ÚNICA escritura de este módulo: `writeStateAtomic` sobre
//   `state/model-value-audit-cron.json` (segunda y última escritura permitida
//   del módulo `model-value-audit`, después de `audit.registrar`).
// - `publicado` / `motivo_no_publicado` (CA-UX-6) viven en el log del brazo y
//   en el retorno del tick, NO en la entrada del audit (CA-21 de #7519 fija
//   sus claves).
//
// Sólo `require` de `fs`, `path` y rutas relativas dentro de `lib/`. Nada de
// `console.log`: todo por `logger`.

const fs = require('fs');
const path = require('path');

const DAY_MS = 86400000;
const STATE_FILE = 'model-value-audit-cron.json';
const PUBLISH_ENUM = Object.freeze(['telegram-plain', 'registry', 'none']);
/** Defaults en código si una clave falta (P11): sin canal explícito NO se publica. */
const DEFAULTS = Object.freeze({ cadence_days: 7, window_days: 30, publish: 'none' });
const PRODUCTOR = 'auditor-modelos';

/** Guard de re-entrada a nivel proceso (SEC-11): un tick lento no se solapa. */
let inFlight = false;

/**
 * Sección efectiva o `null` (⇒ `deshabilitado`). Pura, sin side effects.
 *
 * @param {object} cfgRoot config resuelta completa
 * @returns {{registrar:boolean, publish:string, cadence_days:number, window_days:number}|null}
 */
function resolveSection(cfgRoot) {
    const s = cfgRoot && typeof cfgRoot === 'object' ? cfgRoot.model_value_audit : undefined;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    if (s.enabled !== true) return null;
    if (typeof s.registrar !== 'undefined' && typeof s.registrar !== 'boolean') return null;
    const publish = s.publish === undefined ? DEFAULTS.publish : s.publish;
    if (!PUBLISH_ENUM.includes(publish)) return null;
    const cadence_days = (Number.isInteger(s.cadence_days) && s.cadence_days >= 1) ? s.cadence_days : DEFAULTS.cadence_days;
    const window_days = (Number.isInteger(s.window_days) && s.window_days >= 30) ? s.window_days : DEFAULTS.window_days;
    return { registrar: s.registrar === true, publish, cadence_days, window_days };
}

/** ¿Toca correr? Futuro o corrupto ⇒ corre (SEC-11). */
function isDue({ last, now, cadenceDays } = {}) {
    const cad = (Number.isFinite(cadenceDays) && cadenceDays >= 1) ? cadenceDays : DEFAULTS.cadence_days;
    if (!Number.isFinite(last)) return true;
    if (last > now) return true;
    return (now - last) >= cad * DAY_MS;
}

// copia de health-cron.js:278-282 — unificar en #7529
function readState(file, fsImpl = fs) {
    try {
        if (typeof fsImpl.existsSync === 'function' && !fsImpl.existsSync(file)) return null;
        const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
        return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch {
        return null;
    }
}

// copia de health-cron.js:284-291 — unificar en #7529
function writeStateAtomic(file, data, fsImpl = fs) {
    const dir = path.dirname(file);
    if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fsImpl.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fsImpl.renameSync(tmp, file);
    try { fsImpl.chmodSync(file, 0o600); } catch { /* Windows: best-effort */ }
}

/** P4 — SIEMPRE vía `write-target` (lint R1/R2); nunca `__dirname` ni `pipelineDir`. */
function defaultStateFile() {
    return require('../write-target').writePath(process.env, { canal: 'estado', destino: 'state/model-value-audit-cron.json' }, 'state', STATE_FILE);
}

/** CA-27 / P10: hay algo accionable ⇒ se publica (como máximo un mensaje). */
function shouldPublish(report) {
    const skills = Object.values((report && report.skills && typeof report.skills === 'object') ? report.skills : {});
    const precios = (report && report.precios && typeof report.precios === 'object') ? report.precios : {};
    return skills.some((s) => s && (s.veredicto === 'bajar' || s.veredicto === 'subir'))
        || precios.stale === true
        || (Array.isArray(precios.missing_models) && precios.missing_models.length > 0);
}

function hastaDe(now) {
    return new Date(now).toISOString().slice(0, 10);
}

function codeOf(e) {
    return (e && typeof e.code === 'string' && e.code) ? e.code : 'error';
}

function hash8Of(referencia) {
    return typeof referencia === 'string' ? referencia.slice(0, 8) : null;
}

/**
 * Tick del brazo. Nunca lanza por errores de `run`/`publish`; sólo propaga
 * errores de programación fuera de esos dos (los captura el `try/catch` del
 * tick en `pulpo.js`).
 *
 * @param {object} p
 * @param {string} p.pipelineDir     sólo viaja a `run`/`registrar` (lectura + audit)
 * @param {object} p.cfgRoot         config resuelta (releída por el caller en cada tick)
 * @param {number} [p.now]
 * @param {object} [p.fsImpl]
 * @param {string} [p.stateFile]     inyectable para tests (mkdtemp)
 * @param {Function} [p.run]         default `require('./index').runAudit`
 * @param {Function} [p.registrar]   default `require('./audit').registrar`
 * @param {Function} [p.publish]     default `createPublisher({ adapter }).publish`
 * @param {object} [p.publishDeps]   deps del adaptador (tests)
 * @param {Function} [p.logger]
 * @returns {{ran:boolean, published:boolean, reason:string, hash8?:string}}
 */
function tickIfDue({
    pipelineDir, cfgRoot, now = Date.now(), fsImpl = fs, stateFile, run, registrar, publish, publishDeps, logger = () => {},
} = {}) {
    const section = resolveSection(cfgRoot);
    if (!section) return { ran: false, published: false, reason: 'deshabilitado' };
    if (inFlight) return { ran: false, published: false, reason: 'en_curso' };
    inFlight = true;
    try {
        const file = stateFile || defaultStateFile();
        const st = readState(file, fsImpl);
        if (!isDue({ last: st && st.last_run_at, now, cadenceDays: section.cadence_days })) {
            return { ran: false, published: false, reason: 'no_due' };
        }
        try {
            writeStateAtomic(file, { last_run_at: now }, fsImpl);
        } catch (e) {
            logger(`estado no persistible, corrida omitida (${codeOf(e)})`);
            return { ran: false, published: false, reason: 'estado_no_persistible' };
        }

        let report;
        try {
            const runFn = run || require('./index').runAudit;
            report = runFn({ pipelineDir, dias: section.window_days, hasta: hastaDe(now) });
        } catch (e) {
            logger(`corrida falló (${codeOf(e)})`);
            return { ran: true, published: false, reason: 'run_fallo' };
        }
        if (!report || typeof report !== 'object') {
            logger('corrida falló (reporte vacío)');
            return { ran: true, published: false, reason: 'run_fallo' };
        }

        let referencia = typeof report.sha256 === 'string' ? report.sha256 : null;
        if (section.registrar) {
            const registrarFn = registrar || require('./audit').registrar;
            const out = registrarFn({ pipelineDir, report, fsImpl, now: () => now });
            if (out && typeof out.hash_self === 'string') referencia = out.hash_self;
        }
        const hash8 = hash8Of(referencia);

        if (!shouldPublish(report)) {
            const n = Object.keys(report.skills || {}).length;
            logger(`corrida sin hallazgos accionables (${n} agentes; todo mantener/sin evidencia; precios al día)`);
            return { ran: true, published: false, reason: 'sin_hallazgos', hash8 };
        }

        const propagationEnabled = report.propagation_enabled === true;
        const proposal = require('./proposal').buildProposal(report, { referencia, propagationEnabled });
        const pub = publish || require('./publish').createPublisher({ adapter: section.publish, deps: publishDeps }).publish;
        let res;
        try {
            res = pub(proposal, {
                productor: PRODUCTOR, report, hash: referencia, hash8, propagationEnabled,
                cfgRoot, pipelineRoot: pipelineDir, logger, now,
            });
        } catch (e) {
            logger(`suprimido publish_fallo (${codeOf(e)})`);
            return { ran: true, published: false, reason: 'publish_fallo', hash8 };
        }
        const ok = !!(res && res.ok);
        const reason = (res && typeof res.reason === 'string') ? res.reason : (ok ? 'publicado' : 'publish_fallo');
        const published = ok && reason !== 'adaptador_none';
        if (published) {
            const items = (res && Number.isFinite(res.items)) ? res.items : 0;
            logger(`publicado ${hash8} (${items} ítems, audio ${res && res.audio === 'pendiente' ? 'sí' : 'omitido'})`);
        } else {
            logger(`suprimido ${reason}`);
        }
        return { ran: true, published, reason, hash8 };
    } finally {
        inFlight = false;
    }
}

module.exports = {
    STATE_FILE,
    PUBLISH_ENUM,
    DEFAULTS,
    PRODUCTOR,
    DAY_MS,
    resolveSection,
    isDue,
    readState,
    writeStateAtomic,
    defaultStateFile,
    shouldPublish,
    tickIfDue,
};
