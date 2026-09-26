// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// actions-usage-cron / cron — tick del brazo de medición semanal de Actions
// (#7689, parte 3/4 de #7661)
// =============================================================================
//
// `tickIfDue(...)` es lo que el brazo de `pulpo.js` llama cada hora. Orden
// fail-closed:
//
//   resolveSection(cfgRoot, repoRoot) → inFlight → due? → escribir estado
//   ATÓMICO (`last_run_at`, `since`) → inFlight = true → runWeek(section, {done})
//   → devolver `lanzado` SIN esperar al hijo (CA-9).
//
// Diferencia con `model-value-audit/cron.js`: allá `run` es síncrono y el
// `finally` libera `inFlight`. Acá la medición corre en un proceso hijo
// asíncrono, así que `inFlight` lo libera `done` (idempotente, flag
// `released`), que llaman el `finally` de `runWeek` y el `catch` del tick si
// `runWeek` lanza de forma sincrónica. Como red de seguridad, un `inFlight`
// más viejo que `timeout_min + INFLIGHT_GRACE_MIN` se considera perdido y se
// libera (el runner ya habría resuelto por timeout).
//
// ÚNICA escritura de este módulo: `writeStateAtomic` sobre
// `state/actions-usage-cron.json`.
//
// Sólo `require` de `fs`, `path` y rutas relativas dentro de `lib/`. Nada de
// consola: todo por `logger`.

const fs = require('fs');
const path = require('path');

const DAY_MS = 86400000;
const MIN_MS = 60000;
const STATE_FILE = 'actions-usage-cron.json';
const TARGET_PLANS = Object.freeze(['free', 'team']);
const DEFAULTS = Object.freeze({ cadence_days: 7, timeout_min: 90, target_plan: 'free' });
const RANGES = Object.freeze({ cadence_days: [1, 30], timeout_min: [10, 240] });
/** Margen sobre `timeout_min` antes de dar por perdido un `inFlight` (el runner resuelve al vencer el timeout). */
const INFLIGHT_GRACE_MIN = 15;
/** Repos: letras, números, punto, guion y guion bajo; nunca empiezan con `-` (RS-7689-1). */
const SAFE_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Allowlist de evidencias: `docs/pipeline/evidence/<n>/<archivo>.json`. */
const EVIDENCE_REL = /^docs\/pipeline\/evidence\/[0-9]+\/[A-Za-z0-9._-]+\.json$/;

/** Códigos del motivo de `deshabilitado`, para el log de transición (UX). */
const REASON_CODE = Object.freeze({
    ENABLED_OFF: 'enabled_off',
    SINCE_INVALIDO: 'since_invalido',
    SIN_REPOS: 'sin_repos',
    RANGO_INVALIDO: 'rango_invalido',
    EVIDENCIA_INVALIDA: 'evidencia_invalida',
});

/** Guard de re-entrada a nivel proceso: una medición a la vez. */
let inFlight = false;
let inFlightSince = 0;

/** `AAAA-MM-DD` que además existe en el calendario (mismo criterio que `isValidIsoDate` de #7687). */
function isValidIsoDate(s) {
    if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return false;
    return d.toISOString().slice(0, 10) === s;
}

function inRange(v, [min, max]) {
    return Number.isInteger(v) && v >= min && v <= max;
}

/**
 * Resuelve una ruta de evidencia de la config a un path absoluto dentro de
 * `<repoRoot>/docs/pipeline/evidence/`. Devuelve `null` si no cumple el
 * pattern, tiene segmentos `..`, sale del directorio permitido o no es un
 * archivo regular (los symlinks se rechazan).
 */
function resolveEvidencePath(repoRoot, rel, fsImpl = fs) {
    if (typeof repoRoot !== 'string' || !repoRoot) return null;
    if (typeof rel !== 'string' || !EVIDENCE_REL.test(rel)) return null;
    if (rel.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
    const base = path.join(path.resolve(repoRoot), 'docs', 'pipeline', 'evidence') + path.sep;
    const abs = path.resolve(repoRoot, rel);
    if (!abs.startsWith(base)) return null;
    try {
        const st = fsImpl.lstatSync(abs);
        if (!st.isFile() || (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink())) return null;
    } catch {
        return null;
    }
    return abs;
}

/** Filtra `repos` con `SAFE_REPO` y descarta los que empiezan con `-` (CA-3). */
function filterRepos(repos) {
    if (!Array.isArray(repos)) return [];
    const out = [];
    for (const r of repos) {
        if (typeof r !== 'string' || r.startsWith('-') || !SAFE_REPO.test(r)) continue;
        if (r === '.' || r === '..') continue;
        if (!out.includes(r)) out.push(r);
    }
    return out;
}

function cleanWorkflowMap(m) {
    const out = Object.create(null);
    if (!m || typeof m !== 'object' || Array.isArray(m)) return out;
    for (const k of Object.keys(m)) {
        if (typeof m[k] === 'string') out[k] = m[k];
    }
    return out;
}

/**
 * Sección efectiva + motivo. `section === null` ⇒ `deshabilitado`.
 *
 * @returns {{section: object|null, reasonCode: string|null}}
 */
function resolveSectionDetailed(cfgRoot, repoRoot, fsImpl = fs) {
    const off = (reasonCode) => ({ section: null, reasonCode });
    const s = cfgRoot && typeof cfgRoot === 'object' ? cfgRoot.actions_usage_measure : undefined;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return off(REASON_CODE.ENABLED_OFF);
    if (s.enabled !== true) return off(REASON_CODE.ENABLED_OFF);
    if (!isValidIsoDate(s.since)) return off(REASON_CODE.SINCE_INVALIDO);
    const repos = filterRepos(s.repos);
    if (repos.length === 0) return off(REASON_CODE.SIN_REPOS);
    const cadence_days = s.cadence_days === undefined ? DEFAULTS.cadence_days : s.cadence_days;
    const timeout_min = s.timeout_min === undefined ? DEFAULTS.timeout_min : s.timeout_min;
    const target_plan = s.target_plan === undefined ? DEFAULTS.target_plan : s.target_plan;
    if (!inRange(cadence_days, RANGES.cadence_days) || !inRange(timeout_min, RANGES.timeout_min)) {
        return off(REASON_CODE.RANGO_INVALIDO);
    }
    if (!TARGET_PLANS.includes(target_plan)) return off(REASON_CODE.RANGO_INVALIDO);
    const baselinePath = resolveEvidencePath(repoRoot, s.baseline, fsImpl);
    const pricingPath = resolveEvidencePath(repoRoot, s.pricing, fsImpl);
    if (!baselinePath || !pricingPath) return off(REASON_CODE.EVIDENCIA_INVALIDA);
    const tracking_issue = Number.isInteger(s.tracking_issue) && s.tracking_issue >= 1 ? s.tracking_issue : null;
    return {
        section: {
            since: s.since,
            cadence_days,
            timeout_min,
            target_plan,
            repos,
            baselinePath,
            pricingPath,
            workflow_map: cleanWorkflowMap(s.workflow_map),
            tracking_issue,
            ola_cerrada: s.ola_cerrada === true,
        },
        reasonCode: null,
    };
}

/** Sección efectiva o `null` (⇒ `deshabilitado`). Sin escrituras. */
function resolveSection(cfgRoot, repoRoot, fsImpl = fs) {
    return resolveSectionDetailed(cfgRoot, repoRoot, fsImpl).section;
}

/** ¿Toca correr? Futuro o corrupto ⇒ corre (no silencia el brazo). */
function isDue({ last, now, cadenceDays } = {}) {
    const cad = inRange(cadenceDays, RANGES.cadence_days) ? cadenceDays : DEFAULTS.cadence_days;
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
    return require('../write-target').writePath(process.env, { canal: 'estado', destino: 'state/actions-usage-cron.json' }, 'state', STATE_FILE);
}

function codeOf(e) {
    return (e && typeof e.code === 'string' && e.code) ? e.code : 'error';
}

/**
 * Tick del brazo. No espera al hijo: el resultado de la medición llega por
 * `onResult` (vía `done`).
 *
 * @param {object} p
 * @param {string} [p.pipelineDir]   reservado (paridad con los otros brazos)
 * @param {string} p.pipelineRoot    raíz del repo (evidencias y script)
 * @param {object} p.cfgRoot         config resuelta (releída por el caller en cada tick)
 * @param {number} [p.now]
 * @param {object} [p.fsImpl]
 * @param {string} [p.stateFile]     inyectable para tests
 * @param {Function} p.runWeek       `(section, { done, repoRoot }) => Promise|void`
 * @param {Function} [p.logger]
 * @param {Function} [p.onResult]    recibe el resultado de la medición
 * @returns {{ran:boolean, reason:string, detalle?:string}}
 */
function tickIfDue({
    pipelineRoot, cfgRoot, now = Date.now(), fsImpl = fs, stateFile, runWeek, logger = () => {}, onResult = () => {},
} = {}) {
    const { section, reasonCode } = resolveSectionDetailed(cfgRoot, pipelineRoot, fsImpl);
    if (!section) return { ran: false, reason: 'deshabilitado', detalle: reasonCode };
    if (inFlight) {
        const staleMs = (section.timeout_min + INFLIGHT_GRACE_MIN) * MIN_MS;
        if (now - inFlightSince < staleMs && now >= inFlightSince) return { ran: false, reason: 'en_curso' };
        logger('la medición anterior no avisó que terminó; se libera el turno');
        inFlight = false;
    }
    const file = stateFile || defaultStateFile();
    const st = readState(file, fsImpl);
    if (!isDue({ last: st && st.last_run_at, now, cadenceDays: section.cadence_days })) {
        return { ran: false, reason: 'no_due' };
    }
    try {
        writeStateAtomic(file, { last_run_at: now, since: section.since }, fsImpl);
    } catch (e) {
        logger(`estado no persistible, medición omitida (${codeOf(e)})`);
        return { ran: false, reason: 'estado_no_persistible' };
    }
    if (typeof runWeek !== 'function') {
        logger('medición no disponible (runWeek ausente)');
        return { ran: false, reason: 'run_fallo' };
    }

    inFlight = true;
    inFlightSince = now;
    let released = false;
    const done = (result) => {
        if (released) return;
        released = true;
        inFlight = false;
        try { onResult(result || { kind: 'desconocido' }); } catch { /* el callback nunca traba el brazo */ }
    };
    try {
        const p = runWeek(section, { done, repoRoot: pipelineRoot });
        if (p && typeof p.catch === 'function') {
            p.catch((e) => {
                logger(`medición falló (${codeOf(e)})`);
                done({ kind: 'error' });
            });
        }
    } catch (e) {
        logger(`medición falló al lanzar (${codeOf(e)})`);
        done({ kind: 'error' });
        return { ran: true, reason: 'run_fallo' };
    }
    return { ran: true, reason: 'lanzado', since: section.since, repos: section.repos.length };
}

function isInFlight() {
    return inFlight;
}

function _resetForTests() {
    inFlight = false;
    inFlightSince = 0;
}

module.exports = {
    STATE_FILE,
    DEFAULTS,
    RANGES,
    TARGET_PLANS,
    REASON_CODE,
    SAFE_REPO,
    EVIDENCE_REL,
    DAY_MS,
    INFLIGHT_GRACE_MIN,
    isValidIsoDate,
    resolveEvidencePath,
    filterRepos,
    resolveSection,
    resolveSectionDetailed,
    isDue,
    readState,
    writeStateAtomic,
    defaultStateFile,
    tickIfDue,
    isInFlight,
    _resetForTests,
};
