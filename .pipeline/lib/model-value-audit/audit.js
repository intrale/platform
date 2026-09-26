// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// model-value-audit / audit — audit trail encadenado (#7519, CA-21 / SEC-R2)
// =============================================================================
//
// ÚNICO módulo de `lib/model-value-audit/` con primitivas de escritura. La
// única escritura es `auditLog.appendChained` sobre un path CONSTANTE debajo
// de `path.resolve(pipelineDir)` (SEC-R7):
//
//     <pipelineDir>/audit/model-value-audit.jsonl
//
// La entry es mínima y sin texto libre (SEC-R2): identificadores whitelisteados,
// enums, contadores y hashes hex. Nada de `motivo`, `evidencia`, tabla ni
// `modelos_observados`. `created_at` / `hash_prev` / `hash_self` los agrega
// `appendChained`; el caller NO los manda.
//
// `registrar` propaga excepciones: el CLI las traduce a exit 2 (C15, SEC-R5).
// `index.js` NO requiere este módulo (C16): la orquestación de escrituras vive
// sólo en `scripts/model-value-report.js`.

const fs = require('fs');
const path = require('path');

const AUDIT_FILE = 'model-value-audit.jsonl';

/** Claves exactas de la entry (orden alfabético para el test de forma, C14). */
const ENTRY_KEYS = Object.freeze([
    'agent_models_sha256', 'integridad', 'pricing', 'propagation_enabled', 'report_sha256', 'skills', 'ts', 'ventana',
]);

/** Subconjunto de `report.integridad` que viaja al audit (enums y contadores). */
const INTEGRIDAD_KEYS = Object.freeze([
    'spawn_exit', 'rebound_events', 'label_mutations', 'provider_cost', 'effective_model', 'broken_files',
]);

const ESTADO_OK = 'verificada';
const ESTADO_NO = 'no_verificada';
const ESTADO_ROTA = 'rota';

/** Path constante debajo de `pipelineDir` resuelto (SEC-R7). */
function auditFilePath(pipelineDir) {
    return path.join(path.resolve(String(pipelineDir || '.')), 'audit', AUDIT_FILE);
}

/**
 * Copia literal de `lib/agent-launcher/dispatch-with-fallback.js` (#4052 SEC-1):
 * garantiza que el archivo exista con 0o600 antes del append. Best-effort e
 * idempotente; en Windows el mode es nominal. Nunca tira.
 */
function ensureSecureAuditFile(file, fsImpl) {
    const _fs = fsImpl || fs;
    try {
        _fs.mkdirSync(path.dirname(file), { recursive: true });
        const fd = _fs.openSync(file, 'a', 0o600);
        _fs.closeSync(fd);
        try { _fs.chmodSync(file, 0o600); } catch { /* best-effort (Windows) */ }
    } catch { /* best-effort */ }
}

function enumEstado(v) {
    return v === ESTADO_OK ? ESTADO_OK : (v === ESTADO_NO ? ESTADO_NO : ESTADO_ROTA);
}

function contador(v) {
    return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? Math.trunc(v) : 0;
}

function hexOrNull(v) {
    return (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) ? v : null;
}

/**
 * Entry mínima (CA-21 / SEC-R2). Todo lo que no sea identificador, enum,
 * contador o hash se queda afuera por construcción.
 *
 * @param {object} report   salida de `report.buildReport`
 * @param {{now?:()=>number}} [opts]
 */
function buildEntry(report, { now } = {}) {
    if (!report || typeof report !== 'object') throw new Error('[model-value-audit] buildEntry: reporte requerido');
    const clock = typeof now === 'function' ? now : Date.now;
    const skills = {};
    for (const skill of Object.keys(report.skills || {}).sort()) {
        const s = report.skills[skill];
        if (!s || typeof s !== 'object' || typeof s.veredicto !== 'string') continue;
        Object.defineProperty(skills, skill, {
            value: { n: contador(s.evidencia && s.evidencia.n), veredicto: s.veredicto },
            enumerable: true, writable: true, configurable: true,
        });
    }
    const src = (report.integridad && typeof report.integridad === 'object') ? report.integridad : {};
    const integridad = {};
    for (const k of INTEGRIDAD_KEYS) {
        integridad[k] = k === 'broken_files' ? contador(src[k]) : enumEstado(src[k]);
    }
    const precios = (report.precios && typeof report.precios === 'object') ? report.precios : {};
    const ventana = (report.ventana && typeof report.ventana === 'object') ? report.ventana : {};
    return {
        agent_models_sha256: hexOrNull(report.agent_models_sha256),
        integridad,
        pricing: {
            sha256: hexOrNull(precios.sha256),
            version: (typeof precios.version === 'number' || typeof precios.version === 'string') ? precios.version : null,
            updated_at: typeof precios.updated_at === 'string' ? precios.updated_at : null,
        },
        propagation_enabled: report.propagation_enabled === true,
        report_sha256: hexOrNull(report.sha256),
        skills,
        ts: new Date(clock()).toISOString(),
        ventana: {
            from: typeof ventana.from === 'string' ? ventana.from : null,
            to: typeof ventana.to === 'string' ? ventana.to : null,
            dias: contador(ventana.dias),
        },
    };
}

/**
 * ÚNICA escritura del módulo: `ensureSecureAuditFile` + una `appendChained`.
 * Devuelve lo que devuelve `appendChained` y PROPAGA excepciones (C15).
 *
 * @param {{pipelineDir:string, report:object, fsImpl?:object, auditLog?:object, now?:()=>number}} p
 */
function registrar({ pipelineDir, report, fsImpl, auditLog, now } = {}) {
    const _fs = fsImpl || fs;
    const _auditLog = auditLog || require('../audit-log');
    const file = auditFilePath(pipelineDir);
    const entry = buildEntry(report, { now });
    ensureSecureAuditFile(file, _fs);
    return _auditLog.appendChained({ file, entry, fsImpl: _fs });
}

module.exports = {
    AUDIT_FILE,
    ENTRY_KEYS,
    INTEGRIDAD_KEYS,
    auditFilePath,
    ensureSecureAuditFile,
    buildEntry,
    registrar,
};
