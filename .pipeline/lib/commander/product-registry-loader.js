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
// #5172 — YA NO hay fail-safe a `{}` por config ilegible: la lectura pasa por
// `lib/config-resolver` y el error tipado se propaga. El default single-product
// `Intrale` queda reservado para el caso legítimo (config válida SIN
// `commander_products`), que es lo único que debía activarlo.
// =============================================================================
'use strict';

const configResolver = require('../config-resolver');

const { createProductRegistry, extractRegistryConfig } = require('./product-registry');

/**
 * Carga config.yaml desde el `.pipeline/` dado, vía el punto ÚNICO
 * `lib/config-resolver` (#5172).
 *
 * FALLBACK ELIMINADO (#5172): el `catch { return {} }` degradaba un FALLO DE
 * LECTURA (YAML roto, archivo ausente, permisos) a `{}`, y el registry caía al
 * default single-product `Intrale` — o sea, una config corrupta se veía
 * exactamente igual que un pipeline sin `commander_products` declarados, y el
 * ruteo multi-producto se apagaba en silencio. Ahora el error tipado se PROPAGA.
 *
 * Lo que NO cambia: `commander_products:` AUSENTE en un config que parsea bien
 * sigue siendo válido → `extractRegistryConfig` aplica su default seguro y se
 * sintetiza el producto default con el operador único histórico (SR-6).
 *
 * @param {string} pipelineDir raíz `.pipeline/`.
 * @returns {object} config validado.
 * @throws {ConfigParseViolation|ConfigSchemaViolation}
 */
function loadPipelineConfig(pipelineDir) {
    return configResolver.resolve({ pipelineDir });
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
