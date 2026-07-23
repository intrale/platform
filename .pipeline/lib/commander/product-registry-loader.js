// =============================================================================
// product-registry-loader.js — Construye el product-registry desde config.yaml
// + el operador único histórico (retro-compat). Issue #4780.
//
// Aísla la I/O de config del registry PURO (`product-registry.js`) para que este
// sea unit-testeable sin disco. El loader:
//   1. Lee `config.yaml → commander_products` (server-side, NO secreto).
//   2. Pasa `defaultOperators: [chat_id]` (el operador único histórico de
//      credentials.json) para que, sin `products` declarados, se sintetice el
//      producto default `Intrale` con ese operador (SR-6 / retro-compat).
//
// Fail-safe: si el YAML no existe o no parsea, se degrada a `{}` (el registry
// cae al default single-product Intrale). Nunca rompe el arranque del listener.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { createProductRegistry, extractRegistryConfig } = require('./product-registry');

/**
 * Carga config.yaml (best-effort) desde el `.pipeline/` dado.
 * @param {string} pipelineDir
 * @returns {object} config parseado o {}.
 */
function loadPipelineConfig(pipelineDir) {
    try {
        const p = path.join(pipelineDir, 'config.yaml');
        return yaml.load(fs.readFileSync(p, 'utf8')) || {};
    } catch {
        return {};
    }
}

/**
 * Construye el product-registry de producción.
 *
 * @param {object} opts
 * @param {string} opts.pipelineDir   raíz `.pipeline/` (para leer config.yaml).
 * @param {string|number} [opts.defaultOperator] operador único histórico
 *        (`chat_id` de credentials.json) → operadores del producto default.
 * @param {object} [opts.config]      config ya parseado (override para tests).
 * @returns {object} registry (ver product-registry.createProductRegistry).
 */
function loadProductRegistry(opts = {}) {
    const pipelineConfig = opts.config || loadPipelineConfig(opts.pipelineDir || process.cwd());
    const registryConfig = extractRegistryConfig(pipelineConfig);
    const defaultOperators = opts.defaultOperator !== undefined && opts.defaultOperator !== null
        ? [String(opts.defaultOperator)]
        : [];
    return createProductRegistry({ config: registryConfig, defaultOperators });
}

module.exports = { loadProductRegistry, loadPipelineConfig };
