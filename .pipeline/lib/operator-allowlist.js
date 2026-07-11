// =============================================================================
// operator-allowlist.js — Allowlist cerrada de operadores del pipeline con
// roles `primary` / `backup` (issue #4630, split de #4581 — delegación de firma).
//
// Modelo de seguridad (OWASP A01 Broken Access Control, fail-closed):
//   La allowlist es la fuente de verdad de QUIÉN puede operar el pipeline y con
//   qué autoridad. Es CERRADA: solo los operadores registrados explícitamente en
//   `DEFAULT_OPERATORS` (o los inyectados en tests) existen. Cualquier id fuera
//   de la lista NO tiene rol y toda decisión de autoridad falla cerrada.
//
//   Distingue dos roles:
//     - `primary`: puede crear (otorgar) grants de delegación.
//     - `backup`:  puede EJERCER lo delegado, pero NUNCA re-delegar ni otorgar.
//
//   `assertCanGrant(grantor)` es el único punto que decide quién puede emitir
//   grants: solo `primary`. Un `backup`, un operador desconocido o una allowlist
//   vacía → rechazo con causa diferenciada, sin fallback permisivo.
//
// Este módulo NO depende de `delegation-grant`. La relación es unidireccional:
// `delegation-grant` consume esta allowlist. Mantener así evita ciclos y deja la
// política de identidad aislada de la mecánica de firma.
//
// La lista NO se hidrata desde `config.yaml` ni variables editables: vive en
// código para que agregar un operador requiera un cambio revisado por CODEOWNERS
// (`.pipeline/`), no una edición de config en caliente.
// =============================================================================
'use strict';

// Roles válidos. Enum cerrado: un operador con rol fuera de este set se descarta.
const ROLES = Object.freeze(['primary', 'backup']);

// -----------------------------------------------------------------------------
// Allowlist cerrada por defecto (producción).
//
// `leitolarreta` es el operador primario (mismo criterio que CODEOWNERS y el
// default de firma en CLAUDE.md → GATE 2). Los backups se agregan aquí con un
// cambio revisado; hoy no hay backup designado en producción, y la ausencia es
// intencional: preferimos declarar el backup de forma explícita cuando exista, a
// dejar un placeholder que amplíe la superficie de autoridad.
// -----------------------------------------------------------------------------
const DEFAULT_OPERATORS = Object.freeze([
    Object.freeze({ id: 'leitolarreta', role: 'primary' }),
]);

/**
 * Normaliza una lista de operadores a un Map id→operador, descartando entradas
 * inválidas (fail-closed). Reglas:
 *   - `id` debe ser string no vacío (trim).
 *   - `role` debe pertenecer a `ROLES`; rol inválido → se descarta.
 *   - Ante ids duplicados, gana el PRIMER registro (los siguientes se ignoran).
 * @param {Array<{id:string, role:string}>} list
 * @returns {Map<string, {id:string, role:string}>}
 */
function normalizeOperators(list) {
    const map = new Map();
    if (!Array.isArray(list)) return map;
    for (const op of list) {
        if (!op || typeof op !== 'object') continue;
        const id = typeof op.id === 'string' ? op.id.trim() : '';
        const role = op.role;
        if (!id) continue;
        if (!ROLES.includes(role)) continue; // rol inválido → descartar (fail-closed)
        if (map.has(id)) continue;           // primer registro gana
        map.set(id, Object.freeze({ id, role }));
    }
    return map;
}

/**
 * Crea una allowlist a partir de un conjunto de operadores. En producción se usa
 * el singleton default (ver exports); los tests inyectan su propia lista para
 * cubrir allowlist vacía, operador desconocido y rol `backup` sin re-delegación.
 *
 * @param {object} [opts]
 * @param {Array<{id:string, role:string}>} [opts.operators] - default: DEFAULT_OPERATORS.
 */
function createAllowlist(opts = {}) {
    // `opts.operators` puede ser `[]` explícito (allowlist vacía → todo rechaza).
    const source = opts.operators !== undefined ? opts.operators : DEFAULT_OPERATORS;
    const operators = normalizeOperators(source);

    /**
     * Devuelve el operador registrado o `null` si no existe (fail-closed).
     * @param {string} id
     * @returns {{id:string, role:string}|null}
     */
    function getOperator(id) {
        if (typeof id !== 'string') return null;
        return operators.get(id) || null;
    }

    function hasRole(id, role) {
        const op = getOperator(id);
        return !!op && op.role === role;
    }

    /** @returns {boolean} true solo si `id` está registrado con rol `primary`. */
    function isPrimary(id) { return hasRole(id, 'primary'); }

    /** @returns {boolean} true solo si `id` está registrado con rol `backup`. */
    function isBackup(id) { return hasRole(id, 'backup'); }

    /**
     * Decide si `grantor` puede OTORGAR grants. Solo `primary`. Fail-closed:
     *   - operador desconocido → { ok:false, reason:'unknown-operator' }
     *   - `backup` (u otro rol) → { ok:false, reason:'not-primary' }
     * Nunca lanza: devuelve un resultado que el caller audita.
     * @param {string} grantor
     * @returns {{ok:true, operator:object} | {ok:false, reason:string}}
     */
    function assertCanGrant(grantor) {
        const op = getOperator(grantor);
        if (!op) return { ok: false, reason: 'unknown-operator' };
        if (op.role !== 'primary') return { ok: false, reason: 'not-primary' };
        return { ok: true, operator: op };
    }

    /** @returns {Array<{id:string, role:string}>} copia inmutable de la allowlist. */
    function list() {
        return Array.from(operators.values());
    }

    /** @returns {number} cantidad de operadores registrados. */
    function size() {
        return operators.size;
    }

    return { getOperator, isPrimary, isBackup, assertCanGrant, list, size, ROLES };
}

// Singleton default (producción) sobre la allowlist cerrada.
const _default = createAllowlist();

module.exports = {
    createAllowlist,
    normalizeOperators,
    ROLES,
    DEFAULT_OPERATORS,
    // API de conveniencia ligada al singleton de producción.
    getOperator: (id) => _default.getOperator(id),
    isPrimary: (id) => _default.isPrimary(id),
    isBackup: (id) => _default.isBackup(id),
    assertCanGrant: (grantor) => _default.assertCanGrant(grantor),
    listOperators: () => _default.list(),
};
