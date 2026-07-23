'use strict';

// =============================================================================
// skill-catalog.js — Catálogo compartido de skills por categoría semántica.
// EP8-H6 (#3959, épica #3952) — CA-4 (orden de skills sincronizado entre las
// vistas Matriz / Pipeline / Equipo).
// -----------------------------------------------------------------------------
// Fuente ÚNICA de verdad para:
//   - `SKILL_CATEGORY`  : skill → categoría ('product' | 'dev' | 'quality' | 'ops').
//   - `CATEGORY_META`   : metadata visual por categoría (label/icon/color).
//   - `CATEGORY_ORDER`  : orden canónico de las categorías.
//   - `skillOrder()`    : orden canónico APLANADO (categorías en `CATEGORY_ORDER`,
//                         skills dentro de cada categoría en su orden de
//                         declaración en `SKILL_CATEGORY`).
//
// Histórico: `SKILL_CATEGORY` y `CATEGORY_META` vivían inline en `dashboard.js`
// (~:1632/:1645) y la Matriz ordenaba por `Object.keys(SKILL_COLORS)`, mientras
// Equipo usaba `skillsByCategory` agrupado por `SKILL_CATEGORY`. Resultado: dos
// órdenes distintos. Este módulo unifica ese contrato en un solo lugar para que
// Matriz/Pipeline/Equipo compartan el mismo orden (CA-4).
//
// La estructura re-exportada es BYTE-A-BYTE la misma que tenía `dashboard.js`,
// así `dashboard.js`/`equipo.js` pueden `require`-arlo sin cambiar su uso.
// =============================================================================

// Categorías semánticas de skills (para agrupación en Equipo Disponible).
// El ORDEN DE DECLARACIÓN dentro de cada categoría define el orden canónico
// intra-categoría que consume `skillOrder()`. No reordenar sin actualizar el
// test anti-regresión `skill-catalog.test.js`.
const SKILL_CATEGORY = {
  po: 'product', ux: 'product', planner: 'product',
  'backend-dev': 'dev', 'android-dev': 'dev', 'web-dev': 'dev',
  tester: 'quality', qa: 'quality', review: 'quality', security: 'quality',
  guru: 'ops', perf: 'ops', build: 'ops', delivery: 'ops',
};

const CATEGORY_META = {
  product:  { label: 'Producto', icon: '🎯', color: '#d29922' },
  dev:      { label: 'Desarrollo', icon: '🛠', color: '#3fb950' },
  quality:  { label: 'Calidad', icon: '🛡', color: '#d2a8ff' },
  ops:      { label: 'Operaciones', icon: '⚙', color: '#58a6ff' },
};

// Orden canónico de categorías (mismo que recorre `dashboard.js` al armar
// `skillsByCategory = { product, dev, quality, ops }`).
const CATEGORY_ORDER = ['product', 'dev', 'quality', 'ops'];

/**
 * Categoría de un skill. Default 'ops' (igual que `dashboard.js:3163`).
 * @param {string} skill
 * @returns {string}
 */
function categoryOf(skill) {
  return SKILL_CATEGORY[skill] || 'ops';
}

/**
 * Orden canónico APLANADO de skills: categorías en `CATEGORY_ORDER`, y dentro de
 * cada una los skills en su orden de declaración en `SKILL_CATEGORY`. Cualquier
 * categoría no listada en `CATEGORY_ORDER` (defensivo ante cambios futuros) se
 * agrega al final en orden de aparición.
 *
 * Es el orden que consumen `pipelineSlice` (para emitir `skillOrder`) y la vista
 * Matriz (para ordenar filas). Fuente única → Matriz y Equipo coinciden (CA-4).
 *
 * @returns {string[]}
 */
function skillOrder() {
  const byCat = {};
  for (const [skill, cat] of Object.entries(SKILL_CATEGORY)) {
    (byCat[cat] = byCat[cat] || []).push(skill);
  }
  const order = [];
  const seenCats = new Set();
  for (const cat of CATEGORY_ORDER) {
    seenCats.add(cat);
    for (const skill of (byCat[cat] || [])) order.push(skill);
  }
  // Categorías declaradas en SKILL_CATEGORY pero ausentes de CATEGORY_ORDER.
  for (const [cat, skills] of Object.entries(byCat)) {
    if (seenCats.has(cat)) continue;
    for (const skill of skills) order.push(skill);
  }
  return order;
}

module.exports = {
  SKILL_CATEGORY,
  CATEGORY_META,
  CATEGORY_ORDER,
  categoryOf,
  skillOrder,
};
