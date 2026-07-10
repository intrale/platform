// =============================================================================
// confidence-index.js — Índice de confiabilidad DESCOMPUESTO por criterio.
//
// Issue: #4576 (épico #4570 — gates de firma del operador).
// Diseño: docs/pipeline/gates-firma-operador.md §4.1 / §4.2.
//
// Implementa CA-1 y CA-2 del issue:
//
//   CA-1 · Descomposición sin blend. El índice de confiabilidad se presenta
//          DESCOMPUESTO por criterio (uno por cada criterio evaluado), NUNCA
//          como un número único agregado. El payload es un `Array` de
//          `{criterio, confianza, fuente, maquina_verificable, contribucion_autonomia}`
//          y NO expone un campo escalar `confianza_total` que dispare decisiones.
//
//   CA-2 · Honestidad máquina vs humano. Un criterio NO máquina-verificable
//          (solo-humano) tiene contribución a la autonomía EXACTAMENTE 0
//          (enforcement estructural, coherente con GATE 0 / #4572). Lo
//          solo-humano se marca `confianza: 'desconocida'` explícito y jamás se
//          blendea a un valor que habilite auto-aprobación.
//
// Coherencia con GATE 0 (#4572): la clasificación máquina-vs-humano NO se
// reimplementa acá — se reusa `gate-verdict.classifyCriterion`, la única fuente
// canónica de esa regla. Así, "solo-humano" significa exactamente lo mismo en
// el veredicto honesto (GATE 0) y en la descomposición de confianza. Un criterio
// que GATE 0 rutea a `requires-operator` es, acá, `maquina_verificable: false`.
//
// El módulo es API PURA: no toca FS, red ni estado. Recibe criterios +
// resultados de gate y devuelve la descomposición. La persistencia tamper-
// evident y la escalera de autonomía viven en `autonomy-ladder.js` /
// `operator-signature-gate.js`.
// =============================================================================
'use strict';

const { classifyCriterion } = require('./gate-verdict');

// -----------------------------------------------------------------------------
// Constantes de dominio
// -----------------------------------------------------------------------------

// Niveles de confianza expresados como categoría honesta (NO como porcentaje
// agregado que simule certeza — §4.1). El operador ve la categoría; la
// contribución numérica a la autonomía es un canal separado y acotado.
const CONFIANZA = Object.freeze({
    ALTA: 'alta',           // máquina-verificable + gate pasó.
    BAJA: 'baja',           // máquina-verificable + gate falló.
    DESCONOCIDA: 'desconocida', // solo-humano, o máquina sin resultado de gate.
});

// Fuente de la señal de confianza (de dónde sale, §4.2 — nunca "vibes" del LLM).
const FUENTE = Object.freeze({
    EVIDENCIA_MAQUINA: 'evidencia_maquina', // check máquina-verificable de GATE 0.
    SOLO_HUMANO: 'solo_humano',             // requiere juicio del operador.
});

// -----------------------------------------------------------------------------
// Normalización de criterios de entrada
// -----------------------------------------------------------------------------

/**
 * Normaliza un criterio a `{ texto, key }`. Acepta:
 *   - string → el texto es el criterio; `key` = texto.
 *   - objeto `{ text | texto | criterio, key? }`.
 *
 * `key` es el identificador estable del criterio en el payload de salida
 * (para que el operador y la calibración lo referencien sin ambigüedad).
 *
 * @param {string|object} c
 * @param {number} index
 * @returns {{ texto: string, key: string }}
 */
function normalizeCriterion(c, index) {
    if (typeof c === 'string') {
        const texto = c.trim();
        return { texto, key: texto || `criterio_${index + 1}` };
    }
    if (c && typeof c === 'object') {
        const texto = String(c.text || c.texto || c.criterio || '').trim();
        const key = String(c.key || c.criterio || texto || `criterio_${index + 1}`).trim();
        return { texto, key: key || `criterio_${index + 1}` };
    }
    return { texto: '', key: `criterio_${index + 1}` };
}

// -----------------------------------------------------------------------------
// Resolución del resultado de gate para un criterio máquina-verificable
// -----------------------------------------------------------------------------

/**
 * Busca el resultado de gate ('pass'|'fail'|...) asociado a un criterio.
 * `gateResults` es un mapa opcional `{ [key]: 'pass'|'fail' }`. Sin entrada
 * para el criterio ⇒ `null` (desconocido: no contribuye a autonomía).
 *
 * @param {string} key
 * @param {object} gateResults
 * @returns {string|null}
 */
function resolveGateResult(key, gateResults) {
    if (!gateResults || typeof gateResults !== 'object') return null;
    const r = gateResults[key];
    return (r === undefined || r === null) ? null : String(r);
}

// -----------------------------------------------------------------------------
// Descomposición principal (CA-1 / CA-2)
// -----------------------------------------------------------------------------

/**
 * Descompone la confianza por criterio. Devuelve SOLO un array (CA-1) — nunca
 * un escalar agregado. Cada ítem:
 *   {
 *     criterio: string,               // key/texto del criterio
 *     texto: string,                  // texto original
 *     maquina_verificable: boolean,   // clasificación GATE 0
 *     confianza: 'alta'|'baja'|'desconocida',
 *     fuente: 'evidencia_maquina'|'solo_humano',
 *     contribucion_autonomia: number  // [0,1]; SIEMPRE 0 si !maquina_verificable
 *   }
 *
 * ENFORCEMENT ESTRUCTURAL (CA-2): `maquina_verificable === false ⇒
 * contribucion_autonomia === 0`. No es un cálculo condicional que un caller
 * pueda saltear: la rama solo-humano fija 0 antes de devolver.
 *
 * @param {object} args
 * @param {Array<string|object>} args.criterios — criterios de aceptación.
 * @param {object} [args.gateResults] — mapa `{ [criterioKey]: 'pass'|'fail' }`.
 * @returns {Array<object>}
 */
function decomposeConfidence({ criterios = [], gateResults = {} } = {}) {
    const list = Array.isArray(criterios) ? criterios : [];
    return list.map((raw, i) => {
        const { texto, key } = normalizeCriterion(raw, i);
        const clase = classifyCriterion({ text: texto }); // 'machine' | 'human'
        const maquinaVerificable = clase === 'machine';

        // Rama solo-humano: contribución 0 SIEMPRE (CA-2, enforcement estructural).
        if (!maquinaVerificable) {
            return {
                criterio: key,
                texto,
                maquina_verificable: false,
                confianza: CONFIANZA.DESCONOCIDA,
                fuente: FUENTE.SOLO_HUMANO,
                contribucion_autonomia: 0,
            };
        }

        // Rama máquina-verificable: la confianza sale de la EVIDENCIA de gate
        // (§4.2), no de una autoevaluación del LLM.
        const gate = resolveGateResult(key, gateResults);
        let confianza;
        let contribucion;
        if (gate === 'pass') {
            confianza = CONFIANZA.ALTA;
            contribucion = 1;
        } else if (gate === 'fail') {
            confianza = CONFIANZA.BAJA;
            contribucion = 0; // falló → no contribuye a autonomía.
        } else {
            // Sin resultado de gate: máquina-verificable pero sin evidencia aún.
            confianza = CONFIANZA.DESCONOCIDA;
            contribucion = 0;
        }

        return {
            criterio: key,
            texto,
            maquina_verificable: true,
            confianza,
            fuente: FUENTE.EVIDENCIA_MAQUINA,
            contribucion_autonomia: contribucion,
        };
    });
}

// -----------------------------------------------------------------------------
// Señales estructurales derivadas (booleanas, NO un blend numérico)
// -----------------------------------------------------------------------------

/**
 * ¿Todos los criterios son máquina-verificables? Es una precondición
 * ESTRUCTURAL (no un promedio) para siquiera ser elegible a auto-aprobación:
 * si hay al menos un criterio solo-humano, la auto-aprobación es imposible
 * (coherente con GATE 0 → `requires-operator`).
 *
 * Un índice vacío devuelve `false` (fail-closed: sin criterios evaluados, no
 * hay base para autonomía).
 *
 * @param {Array<object>} index — salida de `decomposeConfidence`.
 * @returns {boolean}
 */
function esTotalmenteMaquinaVerificable(index) {
    if (!Array.isArray(index) || index.length === 0) return false;
    return index.every((c) => c && c.maquina_verificable === true);
}

/**
 * Cantidad de criterios solo-humanos en el índice (los que exigen ojo del
 * operador, §4.1). Útil para la UI de firma y para el ruteo a firma humana.
 *
 * @param {Array<object>} index
 * @returns {number}
 */
function contarSoloHumanos(index) {
    if (!Array.isArray(index)) return 0;
    return index.filter((c) => c && c.maquina_verificable === false).length;
}

module.exports = {
    decomposeConfidence,
    esTotalmenteMaquinaVerificable,
    contarSoloHumanos,
    // Helpers/constantes exportados para tests y callers.
    normalizeCriterion,
    resolveGateResult,
    CONFIANZA,
    FUENTE,
};
