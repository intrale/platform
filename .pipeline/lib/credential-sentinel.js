// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

/**
 * #7634 (parte 1 de #7598) — SENTINEL DE CREDENCIALES EN DISCO + FORMAS DE SECRETO.
 *
 * Módulo HOJA: sólo depende de `node:path` y `node:os`. No importa
 * `credentials`, `config-resolver`, `redact` ni nada del pipeline, así lo
 * pueden usar `credenciales-ambiente.js` y `build-child-env.js` sin require
 * circular ni arrastre de dependencias (R3 del Guru).
 *
 * Contenido:
 *   - `SENTINEL_SIN_DIR` / `sentinelPath(...)`: raíz de rutas que NO existen y
 *     que este módulo JAMÁS crea (sin `mkdirSync`). Viven bajo el home, no bajo
 *     un temp world-writable: plantarlas exige ya tener la cuenta del operador
 *     (mismo criterio que `secret-vault.js`, T2-1.4).
 *   - `neutralizarDisco(env, { aws, github })`: para cada scope AUSENTE (flag
 *     `true` = neutralizar) quita las variables que la cadena de credenciales
 *     del CLI usaría y redirige los archivos de config al sentinel.
 *   - `pareceToken(s)`: forma de token de bot de Telegram.
 *   - `looksLikeSecret(value)`: tipo de secreto por FORMA de valor, o `null`.
 *     Regex anclados, cuantificadores acotados y evaluados sobre los primeros
 *     `MAX_SCAN` caracteres (anti-ReDoS, D4).
 *
 * Nunca devuelve ni loguea valores: sólo nombres y `kind`.
 */

const path = require('node:path');
const os = require('node:os');

/** Raíz del sentinel: paths inexistentes que nadie crea. */
const SENTINEL_SIN_DIR = path.join(os.homedir(), '.intrale-pipeline', 'pruebas-sin-dir');

function sentinelPath(...segmentos) {
    return path.join(SENTINEL_SIN_DIR, ...segmentos);
}

/** Forma de token de bot de Telegram (mismo criterio que `telegram-secrets.isLikelyToken`). */
function pareceToken(s) {
    return typeof s === 'string' && /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(s);
}

/** Tope de caracteres evaluados por `looksLikeSecret` (tiempo acotado aunque el valor sea enorme). */
const MAX_SCAN = 512;

/**
 * Formas de secreto. Todas ancladas y sin cuantificadores anidados.
 * `provider-key` cubre `sk-ant-…` y `sk-proj-…` (quedan dentro de `sk-`).
 */
const SECRET_SHAPES = Object.freeze([
    Object.freeze(['aws-access-key', /^(?:AKIA|ASIA)[0-9A-Z]{16}$/]),
    Object.freeze(['github-token', /^(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{20,255})$/]),
    Object.freeze(['provider-key', /^(?:sk-[A-Za-z0-9_-]{16,255}|AIza[0-9A-Za-z_-]{35})$/]),
    Object.freeze(['jwt', /^[A-Za-z0-9_-]{8,511}\.[A-Za-z0-9_-]{8,511}\.[A-Za-z0-9_-]{8,511}$/]),
]);

/** Enum cerrado de tipos de secreto por forma de valor. */
const SECRET_KINDS = Object.freeze(['telegram-token', ...SECRET_SHAPES.map(([k]) => k)]);

/**
 * @param {unknown} value
 * @returns {string|null} `kind` del secreto detectado o `null`.
 */
function looksLikeSecret(value) {
    if (typeof value !== 'string' || value === '') return null;
    // Un valor más largo que el tope no puede matchear ningún patrón anclado
    // completo; igual se evalúa sólo el prefijo para que el costo sea acotado.
    const s = value.length > MAX_SCAN ? value.slice(0, MAX_SCAN) : value;
    if (pareceToken(s)) return 'telegram-token';
    for (const [kind, re] of SECRET_SHAPES) {
        if (re.test(s)) return kind;
    }
    return null;
}

/** Variables AWS que se QUITAN cuando el rol no tiene scope `aws` (C2). */
const AWS_CRED_VARS_A_QUITAR = Object.freeze([
    'AWS_PROFILE',
    'AWS_DEFAULT_PROFILE',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
]);
const AWS_PREFIJO_A_QUITAR = 'AWS_CONTAINER_CREDENTIALS_';

/** Variables GitHub que se QUITAN cuando el rol no tiene scope `github` (C3). */
const GH_CRED_VARS_A_QUITAR = Object.freeze([
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
]);

/** Variables que ESCRIBE el neutralizador (permitidas por construcción en el assert). */
const NEUTRALIZER_VARS = Object.freeze({
    aws: Object.freeze(['AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_EC2_METADATA_DISABLED']),
    github: Object.freeze(['GH_CONFIG_DIR']),
});

/** Rutas sentinel (no existen; nunca se crean). */
const SENTINEL_AWS = sentinelPath('aws', 'sin-archivo');
const SENTINEL_GH_CONFIG = sentinelPath('gh-config-inexistente');

function quitarClaves(env, lista, prefijo) {
    for (const k of Object.keys(env)) {
        const u = k.toUpperCase();
        if (lista.includes(u) || (prefijo && u.startsWith(prefijo))) delete env[k];
    }
}

/**
 * Neutraliza las fuentes de credenciales en disco de los scopes AUSENTES.
 * Muta y devuelve `env`. Nunca crea directorios ni archivos.
 *
 * @param {Record<string,string>} env
 * @param {{ aws?: boolean, github?: boolean }} neutralizar  `true` = el rol NO tiene ese scope.
 */
function neutralizarDisco(env, { aws = false, github = false } = {}) {
    if (!env || typeof env !== 'object') return env;
    if (aws) {
        // Se borran también grafías alternativas de las variables que se escriben,
        // para que el env final no quede con duplicados de mayúsculas.
        quitarClaves(env, [...AWS_CRED_VARS_A_QUITAR, ...NEUTRALIZER_VARS.aws], AWS_PREFIJO_A_QUITAR);
        env.AWS_SHARED_CREDENTIALS_FILE = SENTINEL_AWS;
        env.AWS_CONFIG_FILE = SENTINEL_AWS;
        env.AWS_EC2_METADATA_DISABLED = 'true';
    }
    if (github) {
        quitarClaves(env, [...GH_CRED_VARS_A_QUITAR, ...NEUTRALIZER_VARS.github]);
        env.GH_CONFIG_DIR = SENTINEL_GH_CONFIG;
    }
    return env;
}

module.exports = {
    SENTINEL_SIN_DIR,
    sentinelPath,
    pareceToken,
    looksLikeSecret,
    neutralizarDisco,
    MAX_SCAN,
    SECRET_KINDS,
    AWS_CRED_VARS_A_QUITAR,
    AWS_PREFIJO_A_QUITAR,
    GH_CRED_VARS_A_QUITAR,
    NEUTRALIZER_VARS,
    SENTINEL_AWS,
    SENTINEL_GH_CONFIG,
};
