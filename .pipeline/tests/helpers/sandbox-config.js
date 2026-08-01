// =============================================================================
// sandbox-config.js — Sembrar la configuración COMPLETA en un sandbox de test
//                     (#5174 · partición kernel/producto)
// =============================================================================
//
// ## Por qué existe
//
// Varios tests levantan el dashboard/pulpo REAL sobre un `PIPELINE_STATE_DIR`
// temporal y, para eso, copiaban `config.yaml` al tmpdir con un `copyFileSync`
// suelto. Post-partición eso deja el sandbox con MEDIA configuración: las 12
// secciones del lado producto viven en `pipeline.config.json`, y
// `lib/config-resolver` falla cerrado si el manifiesto no está junto al kernel.
// El síntoma no es un mensaje claro: el proceso hijo no llega a escuchar y el
// test muere con `ECONNREFUSED`, que se lee como "el dashboard está roto".
//
// Sembrar los DOS lados —o ninguno— es la misma regla CA-3 que el resolver
// aplica en producción ("reubicá ambos o ninguno"). Centralizarla acá evita que
// el próximo sandbox nazca a medias.
//
// ## Uso
//
//   const { seedConfig } = require('./helpers/sandbox-config');
//   seedConfig(tmpDir);   // deja config.yaml + pipeline.config.json en tmpDir
//
// `productPathFor()` del resolver ubica el manifiesto en el PADRE de la raíz
// sólo cuando la raíz se llama `.pipeline`; para un tmpdir plano (que es lo que
// usan estos tests) va en el MISMO directorio. Este helper replica esa regla
// para que el sandbox quede exactamente donde el resolver lo va a buscar.
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PIPELINE_SRC = path.resolve(__dirname, '..', '..');       // .pipeline/
const PRODUCT_SRC = path.resolve(PIPELINE_SRC, '..');           // raíz del repo

const KERNEL_FILE = 'config.yaml';
const PRODUCT_FILE = 'pipeline.config.json';

/**
 * Ubicación del manifiesto de producto para una raíz de pipeline dada.
 * Misma regla que `configResolver.productPathFor`.
 *
 * @param {string} rootDir
 * @returns {string}
 */
function productPathFor(rootDir) {
    const base = path.basename(rootDir) === '.pipeline' ? path.dirname(rootDir) : rootDir;
    return path.join(base, PRODUCT_FILE);
}

/**
 * Copia la configuración REAL del repo (los dos lados) dentro del sandbox.
 *
 * @param {string} rootDir - el directorio que el test va a exportar como
 *        `PIPELINE_STATE_DIR` / `PIPELINE_DIR_OVERRIDE` / `pipelineDir`.
 * @returns {{kernel: string, product: string}} rutas escritas.
 */
function seedConfig(rootDir) {
    const kernel = path.join(rootDir, KERNEL_FILE);
    const product = productPathFor(rootDir);
    fs.mkdirSync(path.dirname(product), { recursive: true });
    fs.copyFileSync(path.join(PIPELINE_SRC, KERNEL_FILE), kernel);
    fs.copyFileSync(path.join(PRODUCT_SRC, PRODUCT_FILE), product);
    return { kernel, product };
}

module.exports = { seedConfig, productPathFor, PIPELINE_SRC, PRODUCT_SRC, KERNEL_FILE, PRODUCT_FILE };
