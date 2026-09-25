// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// model-value-audit / sanitize — whitelist de identificadores (#7517, SEC-3)
// =============================================================================
//
// Todo identificador que llega de los logs es texto no confiable: `skill`,
// `provider`, `model_effective`, `rechazado_en_fase`, `death_kind`, `codepath`
// e `issue` los escribe un proceso que pudo haber sido alimentado por stderr de
// un agente. Acá se los trata como enums cerrados:
//
//   - `skill`            ∈ actores despachables de la config resuelta
//                          (`rollout.dispatchableActors`, 17 hoy)
//   - `rechazado_en_fase`∈ fases de `pipelines.*.skills_por_fase`
//   - `provider`         ∈ `agentModels.providers`
//   - `model_effective`  vía `normalizeModelId` (null permitido)
//   - `death_kind`       ∈ DEATH_KINDS (+ null)
//   - `codepath`         ∈ CODEPATHS (+ null)
//   - `issue`            `/^\d{1,7}$/` tras `String` (+ null)
//   - `exit_code`, `duration_ms`, `tokens_in`, `tokens_out` ⇒ número finito o
//                          string estrictamente numérico (+ null, que se
//                          PRESERVA: el writer emite `exit_code: null` cuando
//                          el proceso muere por señal y no hay código)
//
// Lo que no matchea se CUENTA en `desconocidos.<categoria>` y la fila se
// descarta entera: los valores desconocidos nunca se devuelven ni se imprimen
// (CA-12 / CA-19). `stripForOutput` es la única función que produce texto para
// impresión y se aplica a la SALIDA (partes 3/4), no a los datos.
//
// SEC-5b: si la config no resuelve, `resolveWhitelists` PROPAGA la excepción.
// Una whitelist vacía haría que el 100 % salga desconocido sin explicar por
// qué: fail-closed pero no diagnosticable.
//
// Este módulo NO escribe nada, no ejecuta procesos y no abre red (CA-20).

const ISSUE_RE = /^\d{1,7}$/;
const OUTPUT_MAX_CHARS = 120;

// Enums cerrados de los campos categóricos proyectados (SEC-3b). Se aceptan
// además con valor `null` (el writer los omite o los anula en algunos caminos).
const DEATH_KINDS = Object.freeze(['normal', 'agent-death', 'provider-death', 'credential-death']);
const CODEPATHS = Object.freeze(['generalized', 'legacy', 'premature-death']);

// Campos numéricos. `null`/`undefined` se preservan como `null` (igual que
// `death_kind`/`codepath`); un `number` finito o un string estrictamente
// numérico se aceptan; cualquier otra cosa (booleanos, `""`, `" "`, arrays,
// objetos, NaN, ±Infinity) ⇒ `desconocidos.numericos++` y fila descartada.
// NUNCA `Number(x)` a ciegas: `Number(null) === 0` convertía una muerte por
// señal en un exit limpio (CA-12 / SEC-3b).
const NUMERIC_FIELDS = Object.freeze(['exit_code', 'duration_ms', 'tokens_in', 'tokens_out']);
const NUMERIC_STRING_RE = /^-?\d+(\.\d+)?$/;

// Campos que `read-sources` ya acotó y que se copian tal cual (whitelist
// cerrada; cualquier otra clave de la fila se ignora, no se propaga).
const PASSTHROUGH_FIELDS = Object.freeze(['ts', 'source', 'label', 'action', 'cache']);

// Rango de control completo (C0, DEL, C1, LS, PS) e invisibles bidi / zero-width
// (A2). Nunca `[\r\n\t-^_]`: en JS `\t-^` es el rango 0x09–0x5E y destruye ids.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

// -----------------------------------------------------------------------------
// Whitelists
// -----------------------------------------------------------------------------

/** Actores despachables de la config resuelta (unión de `skills_por_fase`). */
function allowedSkills(config) {
    const rollout = require('../model-propagation-rollout');
    return rollout.dispatchableActors(config);
}

/** Fases: unión de `Object.keys(pipelines.*.skills_por_fase)`. */
function allowedPhases(config) {
    const out = new Set();
    for (const pipeline of Object.values((config && config.pipelines) || {})) {
        for (const fase of Object.keys((pipeline && pipeline.skills_por_fase) || {})) {
            if (fase) out.add(String(fase));
        }
    }
    return out;
}

/**
 * Providers declarados en `agent-models.json`. Acepta el objeto de config o el
 * resultado `{ ok, config }` de `agentModels.loadAndValidate()`.
 */
function allowedProviders(agentModels) {
    const cfg = (agentModels && agentModels.providers)
        ? agentModels
        : ((agentModels && agentModels.config) || {});
    return new Set(Object.keys(cfg.providers || {}));
}

/**
 * Resuelve las tres whitelists desde las fuentes canónicas. Propaga cualquier
 * excepción del resolver (`ConfigParseViolation` / `ConfigSchemaViolation`,
 * SEC-5b) y lanza si `agent-models.json` no valida.
 */
function resolveWhitelists({ pipelineDir, configResolver, agentModels } = {}) {
    const _resolver = configResolver || require('../config-resolver');
    const _agentModels = agentModels || require('../agent-models');
    const config = _resolver.resolve({ pipelineDir, reload: true });
    const validated = _agentModels.loadAndValidate();
    if (!validated || validated.ok === false) {
        throw new Error('agent-models.json no valida: no se construye una whitelist de providers a ciegas');
    }
    return {
        skills: allowedSkills(config),
        phases: allowedPhases(config),
        providers: allowedProviders(validated.config || validated),
    };
}

// -----------------------------------------------------------------------------
// Validadores unitarios
// -----------------------------------------------------------------------------

/** `normalizeModelId` del writer: minúsculas, sin sufijo `[…]`, sin secretos. */
function safeModel(value) {
    const { normalizeModelId } = require('../metrics/effective-model');
    return normalizeModelId(value);
}

/**
 * Regla A3. Devuelve `null` para `null`/`undefined`, el string numérico si
 * matchea `/^\d{1,7}$/`, y `undefined` si es inválido.
 */
function safeIssue(value) {
    if (value == null) return null;
    const s = String(value);
    return ISSUE_RE.test(s) ? s : undefined;
}

/**
 * Texto apto para impresión: `String(s)`, sin controles ni invisibles, tope
 * 120 chars. Ids (`claude-opus-5`) y fechas (`2026-09-21`) quedan intactos.
 */
function stripForOutput(value) {
    return String(value)
        .replace(CONTROL_RE, '')
        .replace(INVISIBLE_RE, '')
        .slice(0, OUTPUT_MAX_CHARS);
}

function nuevosDesconocidos() {
    return { skills: 0, providers: 0, models: 0, phases: 0, death_kinds: 0, codepaths: 0, issues: 0, numericos: 0 };
}

function has(row, field) {
    return Object.prototype.hasOwnProperty.call(row, field);
}

function enEnum(value, lista) {
    return typeof value === 'string' && lista.includes(value);
}

/**
 * Regla numérica estricta. Devuelve `null` para `null`/`undefined`, el número
 * para un `number` finito o un string `/^-?\d+(\.\d+)?$/`, y `undefined` si
 * el valor es inválido (booleanos, strings vacíos/no numéricos, arrays,
 * objetos, NaN, ±Infinity).
 */
function safeNumber(value) {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string' && NUMERIC_STRING_RE.test(value)) {
        const n = Number(value);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}

/**
 * Sanitiza una fila proyectada contra las whitelists. Devuelve `{ ok, row }`
 * con `categoria` cuando falla; no "limpia" parcialmente (la primera falla
 * descarta la fila).
 */
function sanitizeRow(row, whitelists) {
    if (!row || typeof row !== 'object') return { ok: false, categoria: 'skills' };
    const out = {};

    // `skill` y `provider` se validan cuando la fuente los proyecta (las filas
    // de `label-mutations` no los traen: su schema es {issue, label, action}).
    if (has(row, 'skill')) {
        if (typeof row.skill !== 'string' || !whitelists.skills.has(row.skill)) return { ok: false, categoria: 'skills' };
        out.skill = row.skill;
    }
    if (has(row, 'provider')) {
        if (typeof row.provider !== 'string' || !whitelists.providers.has(row.provider)) return { ok: false, categoria: 'providers' };
        out.provider = row.provider;
    }

    if (has(row, 'issue')) {
        const issue = safeIssue(row.issue);
        if (issue === undefined) return { ok: false, categoria: 'issues' };
        out.issue = issue;
    }
    if (has(row, 'model_effective')) {
        if (row.model_effective == null) out.model_effective = null;
        else {
            const model = safeModel(row.model_effective);
            if (model == null) return { ok: false, categoria: 'models' };
            out.model_effective = model;
        }
    }
    if (has(row, 'rechazado_en_fase')) {
        if (typeof row.rechazado_en_fase !== 'string' || !whitelists.phases.has(row.rechazado_en_fase)) {
            return { ok: false, categoria: 'phases' };
        }
        out.rechazado_en_fase = row.rechazado_en_fase;
    }
    if (has(row, 'death_kind')) {
        if (row.death_kind != null && !enEnum(row.death_kind, DEATH_KINDS)) return { ok: false, categoria: 'death_kinds' };
        out.death_kind = row.death_kind == null ? null : row.death_kind;
    }
    if (has(row, 'codepath')) {
        if (row.codepath != null && !enEnum(row.codepath, CODEPATHS)) return { ok: false, categoria: 'codepaths' };
        out.codepath = row.codepath == null ? null : row.codepath;
    }
    for (const f of NUMERIC_FIELDS) {
        if (!has(row, f)) continue;
        const n = safeNumber(row[f]);
        if (n === undefined) return { ok: false, categoria: 'numericos' };
        out[f] = n;
    }

    // Passthrough acotado: sólo los campos que el lector ya acotó (`ts`
    // numérico, `source`, `label`, `action`, `cache`). Ninguna otra clave de
    // la fila llega a la salida.
    for (const k of PASSTHROUGH_FIELDS) {
        if (has(row, k) && !has(out, k)) out[k] = row[k];
    }
    return { ok: true, row: out };
}

/**
 * @param {object[]} rows  filas proyectadas por `read-sources`
 * @param {{skills:Set, phases:Set, providers:Set}} whitelists
 * @returns {{rows: object[], desconocidos: object}}
 */
function sanitizeRows(rows, whitelists) {
    if (!whitelists || !(whitelists.skills instanceof Set) || !(whitelists.providers instanceof Set) || !(whitelists.phases instanceof Set)) {
        throw new Error('sanitizeRows requiere whitelists { skills, phases, providers } como Set');
    }
    const desconocidos = nuevosDesconocidos();
    const out = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        const r = sanitizeRow(row, whitelists);
        if (r.ok) out.push(r.row);
        else desconocidos[r.categoria]++;
    }
    return { rows: out, desconocidos };
}

module.exports = {
    DEATH_KINDS,
    CODEPATHS,
    NUMERIC_FIELDS,
    NUMERIC_STRING_RE,
    PASSTHROUGH_FIELDS,
    ISSUE_RE,
    OUTPUT_MAX_CHARS,
    allowedSkills,
    allowedPhases,
    allowedProviders,
    resolveWhitelists,
    safeModel,
    safeIssue,
    safeNumber,
    stripForOutput,
    sanitizeRow,
    sanitizeRows,
};
